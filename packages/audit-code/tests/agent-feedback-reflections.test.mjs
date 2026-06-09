import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

// Disk-load + staleness wiring for the opt-in worker feedback channel
// (agent-feedback.jsonl → bundle.agent_reflections → "Process Feedback").
// Workers own the file; the orchestrator only reads it. The feedback file is
// deliberately NOT a registry artifact: persist must never rewrite or prune it,
// and a change to it must re-stale exactly one downstream (audit-report.md).

const { loadArtifactBundle, writeCoreArtifacts, getArtifactValue } =
  await import("../src/io/artifacts.ts");
const { computeArtifactMetadata } = await import(
  "../src/orchestrator/artifactMetadata.ts"
);
const { computeStaleArtifacts } = await import(
  "../src/orchestrator/staleness.ts"
);
const { runSynthesisExecutor } = await import(
  "../src/orchestrator/synthesisExecutors.ts"
);
const { advanceAudit } = await import("../src/orchestrator/advance.ts");
const { decideNextStep } = await import("../src/orchestrator/nextStep.ts");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

const FEEDBACK_FILE = "agent-feedback.jsonl";

const REFLECTION = {
  task_id: "u:security",
  lens: "security",
  instruction_clarity: "ambiguous",
  severity: "medium",
  tool_friction: ["packet path was stale"],
};

test("loadArtifactBundle parses agent-feedback.jsonl leniently and persist never touches it", async () => {
  await withTempDir("audit-code-feedback-", async (dir) => {
    // Absent file → no bundle key (normal, non-meta-audit runs unaffected).
    assert.equal((await loadArtifactBundle(dir)).agent_reflections, undefined);

    const raw =
      JSON.stringify(REFLECTION) +
      "\n" +
      "not json — worker scribble\n" +
      JSON.stringify({ task_id: "u:tests", instruction_clarity: "clear", severity: "info" }) +
      "\n";
    await writeFile(join(dir, FEEDBACK_FILE), raw);

    const bundle = await loadArtifactBundle(dir);
    assert.equal(bundle.agent_reflections?.length, 2);
    assert.equal(bundle.agent_reflections[0].task_id, "u:security");

    // The staleness machinery resolves the pseudo-artifact by file name.
    assert.equal(
      getArtifactValue(bundle, FEEDBACK_FILE),
      bundle.agent_reflections,
    );

    // Workers own the file: a full persist — even pruning, even with the key
    // absent from the written bundle — must leave the raw bytes untouched
    // (a rewrite would drop the malformed-but-human-readable line; a prune
    // would delete lines appended after load).
    await writeCoreArtifacts(dir, { repo_manifest: { repository: { name: "t" }, generated_at: "t", files: [] } }, { prune: true });
    assert.equal(await readFile(join(dir, FEEDBACK_FILE), "utf8"), raw);
  });
});

test("synthesis renders Process Feedback from bundle reflections; machine contract carries none", () => {
  const run = runSynthesisExecutor(
    { coverage_matrix: { files: [] }, agent_reflections: [REFLECTION] },
    undefined,
  );
  assert.match(run.updated.audit_report, /## Process Feedback/);
  assert.match(run.updated.audit_report, /packet path was stale/);
  // audit-findings.json is the machine contract — reflections are render-only.
  assert.ok(
    !JSON.stringify(run.updated.audit_findings).includes("packet path was stale"),
    "reflections must not leak into audit-findings.json",
  );

  const without = runSynthesisExecutor({ coverage_matrix: { files: [] } }, undefined);
  assert.doesNotMatch(without.updated.audit_report, /## Process Feedback/);
});

test("changed reflections re-stale audit-report.md exactly once; unchanged reflections never churn", () => {
  // Simulate the advance-loop metadata flow: agent-feedback.jsonl is in the
  // always-updated set (no executor ever lists it in artifacts_written).
  const alwaysUpdated = ["audit-report.md", FEEDBACK_FILE];

  const synthesized = { audit_report: "# Audit Report\n", agent_reflections: [REFLECTION] };
  const metadata = computeArtifactMetadata(synthesized, undefined, alwaysUpdated);
  assert.ok(metadata.artifacts[FEEDBACK_FILE], "feedback gets a metadata entry when present");

  // Converged: same content re-hashed on a later advance → nothing stale.
  const settled = computeArtifactMetadata({ ...synthesized, artifact_metadata: metadata }, metadata, [FEEDBACK_FILE]);
  assert.equal(
    settled.artifacts[FEEDBACK_FILE].revision,
    metadata.artifacts[FEEDBACK_FILE].revision,
    "unchanged feedback must keep its revision",
  );
  assert.equal(
    computeStaleArtifacts({ ...synthesized, artifact_metadata: metadata }).size,
    0,
  );

  // A worker appends a reflection → only the report re-stales.
  const appended = {
    ...synthesized,
    agent_reflections: [
      ...synthesized.agent_reflections,
      { task_id: "u:tests", instruction_clarity: "unclear", severity: "high" },
    ],
    artifact_metadata: metadata,
  };
  const stale = computeStaleArtifacts(appended);
  assert.deepEqual([...stale], ["audit-report.md"]);

  // Re-synthesis records the new feedback revision → converged again.
  const afterResynthesis = computeArtifactMetadata(appended, metadata, alwaysUpdated);
  assert.equal(
    computeStaleArtifacts({ ...appended, artifact_metadata: afterResynthesis }).size,
    0,
    "one re-synthesis must fully converge",
  );

  // No feedback file at all: the report records the dependency at revision 0
  // and stays satisfied (normal runs see zero behavior change).
  const noFeedback = { audit_report: "# Audit Report\n" };
  const noFeedbackMetadata = computeArtifactMetadata(noFeedback, undefined, alwaysUpdated);
  assert.equal(
    noFeedbackMetadata.artifacts["audit-report.md"].dependency_revisions[FEEDBACK_FILE],
    0,
  );
  assert.equal(
    computeStaleArtifacts({ ...noFeedback, artifact_metadata: noFeedbackMetadata }).size,
    0,
  );
});

// The real persist/reload loop. A reflection appended mid-run AFTER the first
// synthesis (but before the run finalizes — here, in the synthesis →
// synthesis-narrative window) must re-stale the report for exactly one extra
// synthesis step, render Process Feedback, and still converge to complete.
// (Once audit_state.json records `complete`, decideNextStep latches it by
// design — post-completion appends are out of scope; reflections are a
// mid-run channel.)
test("a reflection appended after synthesis re-synthesizes once and the run still converges", async () => {
  await withTempDir("audit-code-feedback-loop-", async (root) => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(
        { name: "feedback-loop", version: "0.0.0", scripts: { test: 'node -e "process.exit(0)"' } },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(root, "src", "util.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    const lineIndex = { "src/util.ts": 3, "package.json": 5 };
    const artDir = join(root, ".audit-tools/audit");
    await mkdir(artDir, { recursive: true });

    // Advance one bounded step (auto-answering the agent handoff), mirroring
    // the production load → decide → advance → persist(prune) loop.
    const step = async () => {
      const bundle = await loadArtifactBundle(artDir);
      const decision = decideNextStep(bundle);
      if (decision.state.status === "complete") return null;
      const options = { root, lineIndex };
      if (decision.selected_executor === "agent") {
        const have = new Set((bundle.audit_results ?? []).map((r) => r.task_id));
        options.preferredExecutor = "result_ingestion_executor";
        options.auditResults = (bundle.audit_tasks ?? [])
          .filter((t) => t.status !== "complete" && !have.has(t.task_id))
          .map((t) => ({
            task_id: t.task_id,
            unit_id: t.unit_id,
            pass_id: t.pass_id,
            lens: t.lens,
            agent_role: "test",
            file_coverage: (t.file_paths ?? []).map((p) => ({
              path: p,
              total_lines: lineIndex[p] ?? 10,
            })),
            findings: [],
            notes: [],
            requires_followup: false,
          }));
      }
      const res = await advanceAudit(bundle, options);
      await writeCoreArtifacts(artDir, res.updated_bundle, { prune: true });
      return decision.selected_obligation;
    };

    // Drive until the first synthesis has produced a report.
    const preTrail = [];
    for (let i = 0; i < 25; i++) {
      const obligation = await step();
      assert.notEqual(obligation, null, `run completed before synthesis? trail: ${preTrail.join(" -> ")}`);
      preTrail.push(obligation);
      if (obligation === "synthesis_current") break;
    }
    assert.ok(
      preTrail.includes("synthesis_current"),
      `synthesis should have run; trail: ${preTrail.join(" -> ")}`,
    );
    assert.doesNotMatch(
      await readFile(join(artDir, "audit-report.md"), "utf8"),
      /## Process Feedback/,
      "no reflections yet → no Process Feedback section",
    );

    // Worker appends a reflection while the run is still active, then a
    // malformed line (which must parse away to nothing).
    await appendFile(join(artDir, FEEDBACK_FILE), JSON.stringify(REFLECTION) + "\n");
    await appendFile(join(artDir, FEEDBACK_FILE), "worker crashed mid-line{\n");

    const postTrail = [];
    for (let i = 0; i < 6; i++) {
      const obligation = await step();
      if (obligation === null) break;
      postTrail.push(obligation);
    }
    assert.equal(
      postTrail.filter((o) => o === "synthesis_current").length,
      1,
      `the appended reflection must trigger exactly one re-synthesis; post trail: ${postTrail.join(" -> ")}`,
    );
    const report = await readFile(join(artDir, "audit-report.md"), "utf8");
    assert.match(report, /## Process Feedback/);
    assert.match(report, /packet path was stale/);

    // Converged: the loop reached complete and stays complete.
    const finalBundle = await loadArtifactBundle(artDir);
    assert.equal(decideNextStep(finalBundle).state.status, "complete");
  });
});
