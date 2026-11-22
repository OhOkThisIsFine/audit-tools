import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markRunEnded, rollOverFinishedRun } from "../../src/audit/io/rollover.js";
import { loadArtifactBundle } from "../../src/audit/io/artifacts.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";
import { buildTerminalStep } from "../../src/audit/cli/nextStepHelpers.js";
import type { AuditState } from "../../src/audit/types/auditState.js";
import {
  withTempRepo,
  advanceToDispatchReady,
} from "./helpers/completion-harness.js";
import { presentQuestionReport, readAcceptedAnswers, readQuestionFindings, readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";

test("a completed question audit rolls over without carrying the prior run's answers", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const first = await readQuestionWorkload(await advanceToDispatchReady(root));
    const firstSnapshot = first.work_items[0]!.binding.question.snapshot_id;
    const firstAnswers = await submitQuestions(root, first.work_items);
    expect((await presentQuestionReport(root)).status).toBe("complete");
    const reportPath = join(root, ".audit-tools", "audit-findings.json");
    expect((await readQuestionFindings(reportPath)).question_review.accepted.map(({ submission }) => submission))
      .toEqual(expect.arrayContaining(firstAnswers));
    expect(existsSync(join(artifactsDir, "review_plan.json"))).toBe(true);
    expect(existsSync(join(artifactsDir, "artifact_metadata.json"))).toBe(true);
    const firstConsent = JSON.parse(await readFile(join(artifactsDir, "run-consent.json"), "utf8")) as { run_id: string };

    const promotedDir = join(root, ".audit-tools");
    const promotedReportPath = join(promotedDir, "audit-report.md");
    const previousReport = await readFile(promotedReportPath, "utf8");
    const previousMachineReport = await readFile(reportPath);
    const feedback = Buffer.from(JSON.stringify({
      task_id: "late-rollover-reflection", lens: "security", instruction_clarity: "ambiguous",
      severity: "medium", tool_friction: ["late valid reflection rendered exactly once"],
    }) + "\nnot-json-late-raw-diagnostic\n");
    await writeFile(join(artifactsDir, "agent-feedback.jsonl"), feedback);

    const sessionPath = join(artifactsDir, "session-config.json");
    const strayPath = join(artifactsDir, "stray-run-record.json");
    await writeFile(sessionPath, JSON.stringify({ review_mode: "attended" }));
    await writeFile(strayPath, "{}");
    const edited = join(root, "src", "lib", "session.ts");
    await writeFile(edited, (await readFile(edited, "utf8")) + "\nexport const extra = 1;\n");

    const second = await readQuestionWorkload(await advanceToDispatchReady(root));
    expect(previousReport).not.toContain("late valid reflection");
    const refreshed = await readFile(promotedReportPath, "utf8");
    expect(refreshed.match(/late valid reflection rendered exactly once/g)).toHaveLength(1);
    expect(refreshed).not.toContain("not-json-late-raw-diagnostic");
    expect(await readFile(join(promotedDir, "audit-agent-feedback.jsonl"))).toEqual(feedback);
    expect(await readFile(reportPath)).toEqual(previousMachineReport);
    expect(second.run_id).not.toBe(first.run_id);
    expect(second.work_items[0]!.binding.question.snapshot_id).not.toBe(firstSnapshot);
    const secondConsent = JSON.parse(await readFile(join(artifactsDir, "run-consent.json"), "utf8")) as { run_id: string };
    expect(secondConsent.run_id).not.toBe(firstConsent.run_id);
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(strayPath)).toBe(false);
    await expect(readAcceptedAnswers(artifactsDir, first.run_id)).rejects.toMatchObject({ code: "ENOENT" });

    const secondAnswers = await submitQuestions(root, second.work_items);
    expect((await presentQuestionReport(root)).status).toBe("complete");
    expect((await readQuestionFindings(reportPath)).question_review.accepted.map(({ submission }) => submission))
      .toEqual(expect.arrayContaining(secondAnswers));
    expect(await readAcceptedAnswers(artifactsDir, second.run_id)).toHaveLength(secondAnswers.length);
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

  test("an older run resumes without loading access memory and rollover expires only its working copy", async () => {
    const { base, artifactsDir, promotedDir } = await endedRun();
    try {
      const working = join(artifactsDir, "access_memory.json");
      const archived = join(promotedDir, "archive", "old-run", "access_memory.json");
      const bytes = JSON.stringify({ version: 1, run_id: "old-run", total_ordinals: 0, paths: [] });
      await mkdir(join(promotedDir, "archive", "old-run"), { recursive: true });
      await writeFile(working, bytes);
      await writeFile(archived, bytes);
      const bundle = await loadArtifactBundle(artifactsDir);
      expect(bundle.audit_state?.status).toBe("complete");
      expect(bundle).not.toHaveProperty("access_memory");
      expect(await rollOverFinishedRun(artifactsDir)).toBe(false);
      expect(await readFile(working, "utf8")).toBe(bytes);
      await markRunEnded(artifactsDir);
      expect(await rollOverFinishedRun(artifactsDir)).toBe(true);
      expect(existsSync(working)).toBe(false);
      expect(await readFile(archived, "utf8")).toBe(bytes);
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
