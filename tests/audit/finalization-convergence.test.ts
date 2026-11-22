import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_FILE_TO_BUNDLE_KEY, loadArtifactBundle, writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { advanceToDispatchReady } from "./helpers/completion-harness.js";
import { presentQuestionReport, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { withTempDir } from "./helpers/withTempDir.mjs";

// Every next-step loads what the previous one persisted. An unpublished run
// must finish within the helper's ten-step bound without dispatching again or
// re-planning after its report appears.
test("bound question finalization converges through persist/reload without oscillating", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "src", "api", "resume.ts"), "export function resume(): string { return 'pending'; }\n");
    const dir = join(root, ".audit-tools", "audit");
    // Use the same in-process handler as finalization. Every call still
    // reloads persisted artifacts; starting a fresh CLI process for each
    // unrelated design phase adds startup time without exercising more of
    // the reload and convergence invariants below.
    const first = await advanceToDispatchReady(root);
    const workload = await readQuestionWorkload(first);
    const planFile = join(dir, "review_plan.json");
    const planHash = async () => hashArtifactValue("review_plan.json", JSON.parse(await readFile(planFile, "utf8")));
    const initialPlanHash = await planHash();
    const initial = await loadArtifactBundle(dir);
    const initialRevision = initial.artifact_metadata?.artifacts["review_plan.json"]?.revision;
    expect(typeof initialRevision).toBe("number");
    const answers = await submitQuestions(root, workload.work_items);
    let reportAppeared = false;
    const completed = await presentQuestionReport(root, async (step) => {
      expect(step.step_kind).not.toBe("dispatch_review");
      const current = await loadArtifactBundle(dir);
      if (current.audit_report !== undefined) reportAppeared = true;
      if (reportAppeared) expect(current.audit_report).toBeDefined();
      expect(current.artifact_metadata?.artifacts["review_plan.json"]?.revision).toBe(initialRevision);
      expect(await planHash()).toBe(initialPlanHash);
    });
    expect(reportAppeared).toBe(true);
    expect(completed.status).toBe("complete");
    const report = await readQuestionFindings(join(dir, "audit-findings.json"));
    expect(report.question_review.accepted.map(({ submission }) => submission)).toEqual(expect.arrayContaining(answers));
    expect(report.question_review.accepted).toHaveLength(answers.length);

    // Round-trip the completed active registry independently of its run files.
    // A value that changes meaning on a write/reload can re-stale its dependents.
    const final = await loadArtifactBundle(dir);
    await withTempDir("question-finalization-roundtrip-", async (copy) => {
      await mkdir(copy, { recursive: true });
      await writeCoreArtifacts(copy, final, { prune: true });
      const loaded = await loadArtifactBundle(copy);
      for (const [name, key] of Object.entries(ARTIFACT_FILE_TO_BUNDLE_KEY)) {
        if (name === "tooling_manifest.json") continue; // rebuilt by the loader
        const before = final[key];
        const after = loaded[key];
        expect(after == null ? undefined : hashArtifactValue(name, after), name)
          .toBe(before == null ? undefined : hashArtifactValue(name, before));
      }
    });
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
    expect((await loadArtifactBundle(dir)).audit_report).toBe("# Report\n");

    // Default (no prune): a cleared artifact lingers on disk.
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest });
    expect((await loadArtifactBundle(dir)).audit_report).toBe("# Report\n");

    // prune: the cleared artifact is removed; pruning a missing file is a no-op.
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest }, { prune: true });
    expect((await loadArtifactBundle(dir)).audit_report).toBe(undefined);
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest }, { prune: true });
  });
});

// Fix: a rebuilt artifact's wall-clock generated_at is provenance, not content;
// it must not change the metadata content hash (else its revision churns and
// perpetually re-stales downstreams).
test("metadata content hash ignores generated_at for rebuilt timestamped artifacts", () => {
  for (const name of ["design_assessment.json", "repo_manifest.json"]) {
    expect(hashArtifactValue(name, { generated_at: "2026-01-01T00:00:00Z", data: 1 }), `${name} hash should ignore generated_at`).toBe(hashArtifactValue(name, { generated_at: "2026-12-31T23:59:59Z", data: 1 }));
  }
  expect(hashArtifactValue("design_assessment.json", { data: 1 })).not.toBe(hashArtifactValue("design_assessment.json", { data: 2 }));
});
