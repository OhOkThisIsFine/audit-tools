import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { advanceAudit } = await import("../src/orchestrator/advance.ts");
const { decideNextStep } = await import("../src/orchestrator/nextStep.ts");
const { loadArtifactBundle, writeCoreArtifacts, ARTIFACT_FILE_TO_BUNDLE_KEY } =
  await import("../src/io/artifacts.ts");
const { hashArtifactValue } = await import(
  "../src/orchestrator/artifactFreshness.ts"
);
const { runSynthesisExecutor } = await import(
  "../src/orchestrator/synthesisExecutors.ts"
);

const LINE_INDEX = {
  "src/api/auth.ts": 6,
  "src/lib/session.ts": 8,
  "package.json": 5,
};

const { withTempDir } = await import("./helpers/withTempDir.mjs");

async function writeFixture(root) {
  await mkdir(join(root, "src", "api"), { recursive: true });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      { name: "conv", version: "0.0.0", scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ) + "\n",
  );
  // src/api/auth.ts → a security-lens high-risk unit → runtime validation tasks,
  // so the finalization loop genuinely exercises runtime_validation ↔ synthesis.
  await writeFile(
    join(root, "src", "api", "auth.ts"),
    "export function authenticate(token: string): boolean {\n  if (!token) return false;\n  return token.trim().length > 0;\n}\n",
  );
  await writeFile(
    join(root, "src", "lib", "session.ts"),
    "export interface Session { id: string; }\nexport function createSession(id: string): Session {\n  return { id };\n}\n",
  );
}

function resultsForPending(bundle) {
  const have = new Set((bundle.audit_results ?? []).map((r) => r.task_id));
  return (bundle.audit_tasks ?? [])
    .filter((t) => t.status !== "complete" && !have.has(t.task_id))
    .map((task) => ({
      task_id: task.task_id,
      unit_id: task.unit_id,
      pass_id: task.pass_id,
      lens: task.lens,
      agent_role: "test",
      file_coverage: (task.file_paths ?? []).map((p) => ({
        path: p,
        total_lines: LINE_INDEX[p] ?? 10,
      })),
      findings: [],
      notes: [],
      requires_followup: false,
    }));
}

// Drives the SAME load → decide → advance → persist(prune) loop the production
// CLI runs (cli/nextStepCommand.ts), auto-answering the agent handoff. A1 was a
// finalization oscillation that spun to the iteration cap; this asserts the
// deterministic loop reaches `complete` quickly and never re-runs planning after
// synthesis (a planning re-run rewrites runtime_validation_report.json and
// re-stales synthesis — the oscillation engine).
test("finalization converges through the real persist/reload loop without oscillating", async () => {
  await withTempDir("audit-code-finalization-", async (root) => {
    await writeFixture(root);
    const artDir = join(root, ".audit-tools/audit");
    await mkdir(artDir, { recursive: true });

    const trail = [];
    let completedAt = -1;
    let lastUpdated = null;
    let sawRuntimeTasks = false;
    const MAX_ITERS = 25;

    for (let i = 0; i < MAX_ITERS; i++) {
      const bundle = await loadArtifactBundle(artDir);
      if ((bundle.runtime_validation_tasks?.tasks ?? []).length > 0) {
        sawRuntimeTasks = true;
      }
      const decision = decideNextStep(bundle);
      if (decision.state.status === "complete") {
        completedAt = i;
        break;
      }
      assert.ok(
        decision.selected_executor,
        `iter ${i}: an executor should be selected (trail: ${trail.join(" -> ")})`,
      );
      trail.push(decision.selected_obligation);

      let res;
      if (decision.selected_executor === "agent" || decision.selected_executor === "rolling_dispatch_executor") {
        const results = resultsForPending(bundle);
        assert.ok(results.length > 0, "agent/rolling_dispatch_executor handoff must have pending tasks to answer");
        res = await advanceAudit(bundle, {
          root,
          lineIndex: LINE_INDEX,
          preferredExecutor: "result_ingestion_executor",
          auditResults: results,
        });
      } else {
        res = await advanceAudit(bundle, { root, lineIndex: LINE_INDEX });
      }
      lastUpdated = res.updated_bundle;
      await writeCoreArtifacts(artDir, res.updated_bundle, { prune: true });
    }

    assert.ok(
      completedAt >= 0,
      `finalization must converge to complete within ${MAX_ITERS} iterations; trail: ${trail.join(" -> ")}`,
    );
    assert.ok(sawRuntimeTasks, "fixture should exercise runtime validation tasks");

    const firstSynthesis = trail.indexOf("synthesis_current");
    assert.ok(firstSynthesis >= 0, `synthesis should run; trail: ${trail.join(" -> ")}`);
    assert.ok(
      !trail.slice(firstSynthesis).includes("planning_artifacts"),
      `planning must not re-run after synthesis; trail: ${trail.join(" -> ")}`,
    );

    // Every persisted artifact must survive a reload with an identical content
    // hash — a round-trip-unstable artifact perpetually re-stales its downstream.
    const reloaded = await loadArtifactBundle(artDir);
    for (const [fileName, key] of Object.entries(ARTIFACT_FILE_TO_BUNDLE_KEY)) {
      if (fileName === "tooling_manifest.json") continue; // generated_at excluded from hash
      const mem = lastUpdated?.[key];
      const disk = reloaded[key];
      if ((mem ?? null) === null && (disk ?? null) === null) continue;
      assert.equal(
        mem == null ? "ABSENT" : hashArtifactValue(fileName, mem),
        disk == null ? "ABSENT" : hashArtifactValue(fileName, disk),
        `${fileName} must round-trip identically across persist/reload`,
      );
    }
  });
});

// Fix: writeCoreArtifacts must remove files for artifacts an executor cleared to
// `undefined` when pruning, or they reload as stale "present" artifacts.
test("writeCoreArtifacts prunes cleared artifacts only when asked", async () => {
  await withTempDir("audit-code-finalization-", async (dir) => {
    const repoManifest = { repository: { name: "t" }, generated_at: "t", files: [] };
    await writeCoreArtifacts(dir, {
      repo_manifest: repoManifest,
      audit_report: "# Report\n",
    });
    assert.equal((await loadArtifactBundle(dir)).audit_report, "# Report\n");

    // Default (no prune): a cleared artifact lingers on disk.
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest });
    assert.equal((await loadArtifactBundle(dir)).audit_report, "# Report\n");

    // prune: the cleared artifact is removed; pruning a missing file is a no-op.
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest }, { prune: true });
    assert.equal((await loadArtifactBundle(dir)).audit_report, undefined);
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest }, { prune: true });
  });
});

// Fix: synthesis renders findings but does not own audit_results; rewriting it
// (or materializing an empty one) desyncs it from its metadata entry and
// re-stales coverage_matrix → planning.
test("synthesis renders findings without rewriting or materializing audit_results", () => {
  const noResults = runSynthesisExecutor({ coverage_matrix: { files: [] } }, undefined);
  assert.equal(noResults.updated.audit_results, undefined);
  assert.ok(!noResults.artifacts_written.includes("audit_results.jsonl"));
  assert.ok(noResults.artifacts_written.includes("audit-report.md"));

  const ingested = [
    { task_id: "u:security", unit_id: "u", pass_id: "p", lens: "security", file_coverage: [], findings: [] },
  ];
  const withResults = runSynthesisExecutor(
    { coverage_matrix: { files: [] }, audit_results: ingested },
    undefined,
  );
  assert.equal(withResults.updated.audit_results, ingested);
});

// Fix: a rebuilt artifact's wall-clock generated_at is provenance, not content;
// it must not change the metadata content hash (else its revision churns and
// perpetually re-stales downstreams).
test("metadata content hash ignores generated_at for rebuilt timestamped artifacts", () => {
  for (const name of ["audit_plan_metrics.json", "design_assessment.json"]) {
    assert.equal(
      hashArtifactValue(name, { generated_at: "2026-01-01T00:00:00Z", data: 1 }),
      hashArtifactValue(name, { generated_at: "2026-12-31T23:59:59Z", data: 1 }),
      `${name} hash should ignore generated_at`,
    );
  }
  // coverage_matrix is intentionally NOT stripped (its timestamp is content).
  assert.notEqual(
    hashArtifactValue("coverage_matrix.json", { generated_at: "a", files: [] }),
    hashArtifactValue("coverage_matrix.json", { generated_at: "b", files: [] }),
  );
});
