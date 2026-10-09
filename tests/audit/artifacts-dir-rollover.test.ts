import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import { markRunEnded, rollOverFinishedRun } from "../../src/audit/io/rollover.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";
import { buildTerminalStep } from "../../src/audit/cli/nextStepHelpers.js";
import type { AuditState } from "../../src/audit/types/auditState.js";
import {
  withTempRepo,
  advanceToDispatchReady,
  buildSyntheticResults,
  seedEmptyNarrative,
  callIngestResults,
  nextStepUntilPresentReport,
} from "./helpers/completion-harness.js";

// Owner decision 2026-10-08 ("keep the artifacts dir"; design record
// docs/reviews/frozen-snapshot-design-2026-10-08.md, plan
// docs/reviews/artifacts-dir-rollover-plan-2026-10-08.md): a completed audit's
// working dir survives completion, and the next run reuses every derived
// artifact whose inputs did not change — so only the edited file is reviewed
// again — while inheriting nothing that belongs to the previous run.
test("the next audit reviews only what changed since the completed one", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await advanceToDispatchReady(root);
    const tasks = JSON.parse(await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"));
    await seedEmptyNarrative(artifactsDir);
    // Outside the audited tree: a results file in the root would be a new file the next run reviews.
    const resultsPath = join(root, ".audit-tools", "results.json");
    await writeFile(resultsPath, JSON.stringify(await buildSyntheticResults(tasks, root), null, 2));
    await callIngestResults(["--root", root, "--artifacts-dir", artifactsDir, "--results", resultsPath]);
    const done = await nextStepUntilPresentReport(root);
    expect(done.status).toBe("complete");

    // Completion keeps the derived work and the staleness baselines.
    expect(existsSync(join(artifactsDir, "audit_tasks.json"))).toBe(true);
    expect(existsSync(join(artifactsDir, "artifact_metadata.json"))).toBe(true);
    const firstConsent = JSON.parse(await readFile(join(artifactsDir, "run-consent.json"), "utf8")) as { run_id: string };

    // The operator's durable intent survives; an unknown entry does not (allow-list).
    await writeFile(join(artifactsDir, "session-config.json"), JSON.stringify({ review_mode: "attended" }));
    await writeFile(join(artifactsDir, "stray-run-record.json"), "{}");
    const edited = join(root, "src", "lib", "session.ts");
    await writeFile(edited, (await readFile(edited, "utf8")) + "export const extra = 1;\n");

    const step = await advanceToDispatchReady(root);
    expect(step.step_kind).toBe("dispatch_review");
    // Nothing of the previous run is inherited.
    const secondConsent = JSON.parse(await readFile(join(artifactsDir, "run-consent.json"), "utf8")) as { run_id: string };
    expect(secondConsent.run_id).not.toBe(firstConsent.run_id);
    expect(existsSync(join(artifactsDir, "session-config.json"))).toBe(true);
    expect(existsSync(join(artifactsDir, "stray-run-record.json"))).toBe(false);
    // Only the edited file is reviewed again.
    const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as {
      work_items: Array<{ scope: { files: string[] } }>;
    };
    expect(workload.work_items.length).toBeGreaterThan(0);
    for (const item of workload.work_items) expect(item.scope.files).toContain("src/lib/session.ts");

    // The second run's results are accepted under the second run's identity —
    // no review-run id, wave or result key of the first run swallows them — and
    // the second run completes with its own report.
    const secondTasks = (JSON.parse(await readFile(join(artifactsDir, "audit_tasks.json"), "utf8")) as Array<{ file_paths: string[] }>)
      .filter((task) => task.file_paths.includes("src/lib/session.ts"));
    expect(secondTasks.length).toBeGreaterThan(0);
    const resultCount = async () => (await readFile(join(artifactsDir, "audit_results.jsonl"), "utf8")).trim().split("\n").length;
    const before = await resultCount();
    await seedEmptyNarrative(artifactsDir);
    await writeFile(resultsPath, JSON.stringify(await buildSyntheticResults(secondTasks as never, root), null, 2));
    await callIngestResults(["--root", root, "--artifacts-dir", artifactsDir, "--results", resultsPath]);
    expect(await resultCount()).toBe(before + secondTasks.length);
    const second = await nextStepUntilPresentReport(root);
    expect(second.status).toBe("complete");
  });
});

// The gate is the run-ended marker the terminal step writes after a successful
// promotion — never byte identity between the dir and the archive, which a
// host's later append or an operator's resynthesize legitimately breaks.
describe("rollOverFinishedRun", () => {
  async function endedRun(): Promise<{ base: string; artifactsDir: string; promotedDir: string }> {
    const base = await mkdtemp(join(tmpdir(), "audit-rollover-"));
    const promotedDir = join(base, ".audit-tools");
    const artifactsDir = join(promotedDir, "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "complete", obligations: [] }));
    await writeFile(join(artifactsDir, "artifact_metadata.json"), "{}");
    await writeFile(join(artifactsDir, "run-consent.json"), "{}");
    await writeFile(join(artifactsDir, "session-config.json"), "{}");
    await writeFile(join(artifactsDir, "analyzer-policy.json"), "{}");
    await writeFile(join(artifactsDir, "agent-feedback.jsonl"), "{\"n\":1}\n");
    return { base, artifactsDir, promotedDir };
  }

  test("a dir without the run-ended marker is left as it is", async () => {
    const { base, artifactsDir } = await endedRun();
    try {
      expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
      expect(existsSync(join(artifactsDir, "run-consent.json"))).toBe(true);
      expect(existsSync(join(artifactsDir, "audit_state.json"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("an ended run with a diagnostic appended after promotion archives it, then rolls over by allow-list", async () => {
    const { base, artifactsDir, promotedDir } = await endedRun();
    try {
      await markRunEnded(artifactsDir);
      // The host appends after the promotion archived the first line.
      await writeFile(join(artifactsDir, "agent-feedback.jsonl"), "{\"n\":1}\n{\"n\":2}\n");
      expect(await rollOverFinishedRun(artifactsDir)).toBe(true);
      expect(await readFile(join(promotedDir, "audit-agent-feedback.jsonl"), "utf8")).toBe("{\"n\":1}\n{\"n\":2}\n");
      expect(existsSync(join(artifactsDir, "artifact_metadata.json"))).toBe(true);
      expect(existsSync(join(artifactsDir, "session-config.json"))).toBe(true);
      for (const gone of ["audit_state.json", "run-consent.json", "analyzer-policy.json", "agent-feedback.jsonl", "run-ended.json"]) {
        expect(existsSync(join(artifactsDir, gone)), gone).toBe(false);
      }
      // A second call has nothing to do.
      expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("an in-place machine contract with no promoted copy keeps the whole dir", async () => {
    const { base, artifactsDir } = await endedRun();
    try {
      await markRunEnded(artifactsDir);
      await writeFile(join(artifactsDir, "audit-findings.json"), "{}");
      expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
      for (const kept of ["audit-findings.json", "audit_state.json", "run-consent.json", "run-ended.json"]) {
        expect(existsSync(join(artifactsDir, kept)), kept).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("the sweep keeps a dir whose run snapshot cannot be removed", async () => {
    const { base, artifactsDir } = await endedRun();
    try {
      await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "not_started", obligations: [] }));
      await writeFile(join(artifactsDir, "run-snapshot.json"), "not json");
      expect((await cleanupStaleArtifactsDir(artifactsDir)).action).toBe("skipped");
      expect(existsSync(join(artifactsDir, "run-snapshot.json"))).toBe(true);
      // --force stays the operator's escape hatch, even over a corrupt record.
      expect((await cleanupStaleArtifactsDir(artifactsDir, { force: true })).action).toBe("deleted");
      expect(existsSync(artifactsDir)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a previous audit's promoted contract never stands in for this run's: the contract is promoted again before the run ends", async () => {
    const { base, artifactsDir, promotedDir } = await endedRun();
    try {
      await mkdir(join(artifactsDir, "steps"), { recursive: true });
      await writeFile(join(artifactsDir, "operator-handoff.json"), JSON.stringify({ progress_summary: "" }));
      // The report already promoted, but this run's contract never reached the
      // promoted path (its copy failed); the previous audit's contract is there.
      await writeFile(join(artifactsDir, "audit-report.md"), "# report");
      await writeFile(join(promotedDir, "audit-report.md"), "# report");
      await writeFile(join(artifactsDir, "audit-findings.json"), "{\"run\":2}");
      await writeFile(join(promotedDir, "audit-findings.json"), "{\"run\":1}");
      const state: AuditState = { status: "complete", obligations: [] };
      await buildTerminalStep({ root: base, sourceRoot: base, artifactsDir }, { audit_report: "# report" }, state, "done");
      expect(await readFile(join(promotedDir, "audit-findings.json"), "utf8")).toBe("{\"run\":2}");
      expect(existsSync(join(artifactsDir, "run-ended.json"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a diagnostic that cannot be archived keeps the whole dir", async () => {
    const { base, artifactsDir, promotedDir } = await endedRun();
    try {
      await markRunEnded(artifactsDir);
      // A directory where the archived copy must go: the copy fails.
      await mkdir(join(promotedDir, "audit-agent-feedback.jsonl"), { recursive: true });
      expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
      for (const kept of ["audit_state.json", "run-consent.json", "agent-feedback.jsonl", "run-ended.json"]) {
        expect(existsSync(join(artifactsDir, kept)), kept).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
