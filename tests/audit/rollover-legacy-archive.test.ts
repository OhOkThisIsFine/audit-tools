import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { cmdCleanup } from "../../src/audit/cli/cleanupCommand.js";
import { callNextStep, withTempRepo } from "./helpers/completion-harness.js";
import { ensureQuestionReviewRunIdUnlocked } from "../../src/audit/cli/questionReviewSession.js";
import { promoteFinalAuditReport, writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { markRunEnded, rollOverFinishedRun } from "../../src/audit/io/rollover.js";
import { runQuestionSynthesisExecutor } from "../../src/audit/orchestrator/synthesisExecutors.js";
import { REVIEW_QUESTION_CONTRACT_VERSION } from "../../src/shared/types/reviewQuestion.js";

const id = "eaf61c59-4e90-4434-91b6-1157b24a83c8";
const names = [
  "audit_plan_metrics.json", "audit_results.jsonl", "audit_tasks.json", "coverage_matrix.json",
  "flow_coverage.json", "requeue_tasks.json", "runtime_validation_report.json",
  "runtime_validation_tasks.json", "task_affinity_graph.json",
];
const raw = (i: number) => Buffer.from([0xff, i, 0x0d, 0x0a]);

async function fixture(run: (dir: string, archive: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "audit-v1-rollover-"));
  const output = join(root, ".audit-tools");
  const dir = join(output, "audit");
  try {
    await mkdir(dir, { recursive: true });
    await run(dir, join(output, "archive"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("finished legacy rollover archives exact retired bytes and accepts an identical prior copy", async () => {
  await fixture(async (dir, archive) => {
    await writeFile(join(dir, "run-consent.json"), JSON.stringify({ run_id: id }));
    await Promise.all(names.map((name, i) => writeFile(join(dir, name), raw(i))));
    await mkdir(join(archive, id), { recursive: true });
    await writeFile(join(archive, id, names[0]!), raw(0));
    expect(await rollOverFinishedRun(dir)).toBe(false);
    await markRunEnded(dir);
    expect(await rollOverFinishedRun(dir)).toBe(true);
    expect(await readdir(join(archive, id))).toEqual(names);
    for (const [i, name] of names.entries()) {
      expect(await readFile(join(archive, id, name))).toEqual(raw(i));
      await expect(readFile(join(dir, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

test("absent old run identity keys the archive by raw content without conflating different runs", async () => {
  await fixture(async (dir, archive) => {
    const file = "audit_results.jsonl";
    for (const i of [1, 1, 2]) {
      await writeFile(join(dir, file), raw(i));
      await markRunEnded(dir);
      expect(await rollOverFinishedRun(dir)).toBe(true);
    }
    const archives = await readdir(archive);
    expect(archives).toHaveLength(2);
    expect(archives.every(name => /^legacy-[a-f0-9]{64}$/.test(name))).toBe(true);
    const bytes = await Promise.all(archives.map(name => readFile(join(archive, name, file))));
    expect(bytes).toEqual(expect.arrayContaining([raw(1), raw(2)]));
  });
});

test.each(["collision", "unsafe identity", "non-regular source", "unsafe archive path"] as const)(
  "historical %s refuses rollover and preserves live evidence",
  async problem => fixture(async (dir, archive) => {
    const file = "audit_results.jsonl";
    const live = join(dir, file);
    await writeFile(join(dir, "run-consent.json"), JSON.stringify({
      run_id: problem === "unsafe identity" ? "../outside" : id,
    }));
    if (problem === "non-regular source") {
      await mkdir(live);
      await writeFile(join(live, "must-survive"), raw(3));
    } else {
      await writeFile(live, raw(3));
    }
    if (problem === "collision") {
      await mkdir(join(archive, id), { recursive: true });
      await writeFile(join(archive, id, file), raw(4));
    }
    if (problem === "unsafe archive path") await writeFile(archive, "not a directory");
    await markRunEnded(dir);
    expect(await rollOverFinishedRun(dir)).toBe(false);
    expect(await readFile(join(dir, "run-ended.json"), "utf8")).toBe("{}\n");
    expect(await readFile(problem === "non-regular source" ? join(live, "must-survive") : live)).toEqual(raw(3));
    if (problem === "collision") expect(await readFile(join(archive, id, file))).toEqual(raw(4));
    if (problem === "unsafe identity") await expect(readdir(archive)).rejects.toMatchObject({ code: "ENOENT" });
  }),
);

async function writeCompletedQuestionReport(dir: string) {
  await ensureQuestionReviewRunIdUnlocked(dir);
  const written = runQuestionSynthesisExecutor({
    review_plan: {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION, snapshot_id: "v2",
      inventory: [], questions: [], omissions: [], lens_decisions: [],
    },
    audit_state: { status: "complete", obligations: [] },
  }, {
    auditRead: null, questionReview: { accepted: [], evidence: [], dependenciesByQuestion: new Map() },
  });
  await writeCoreArtifacts(dir, written.updated);
  expect(await promoteFinalAuditReport({ artifactsDir: dir })).toMatchObject({ promoted: true, archived: true });
  await markRunEnded(dir);
}

test("normal finished v2 rollover creates no historical archive", async () => {
  await fixture(async (dir, archive) => {
    await writeCompletedQuestionReport(dir);
    expect(await rollOverFinishedRun(dir)).toBe(true);
    await expect(readdir(archive)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("ordinary cleanup and next-step both retain sole retired evidence after an archive conflict", async () => {
  await withTempRepo(async root => {
    const output = join(root, ".audit-tools");
    const dir = join(output, "audit");
    await writeCompletedQuestionReport(dir);
    const consent = JSON.parse(await readFile(join(dir, "run-consent.json"), "utf8")) as { run_id: string };
    const live = join(dir, "audit_results.jsonl");
    await writeFile(live, raw(4));
    const archive = join(output, "archive");
    // Verify-only cleanup must not create a missing archive.
    const cleanup = () => captureConsole(() => cmdCleanup(["--root", root, "--artifacts-dir", dir]))
      .then(({ stdout }) => JSON.parse(stdout));
    expect(await cleanup()).toMatchObject({ action: "skipped" });
    await expect(readdir(archive)).rejects.toMatchObject({ code: "ENOENT" });

    const targetDir = join(archive, consent.run_id);
    await mkdir(targetDir, { recursive: true });
    const conflicting = join(targetDir, "audit_results.jsonl");
    await writeFile(conflicting, raw(5));
    const plan = await readFile(join(dir, "review_plan.json"));
    const machine = await readFile(join(dir, "audit-findings.json"));
    expect(await cleanup()).toMatchObject({ action: "skipped" });
    expect(await callNextStep(root, dir)).toMatchObject({ status: "blocked" });
    expect(await readFile(live)).toEqual(raw(4));
    expect(await readFile(conflicting)).toEqual(raw(5));
    expect(await readFile(join(dir, "run-ended.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(dir, "review_plan.json"))).toEqual(plan);
    expect(await readFile(join(dir, "audit-findings.json"))).toEqual(machine);
  });
});

test("the not-started cleanup path also keeps unarchived legacy bytes", async () => {
  await fixture(async (dir, archive) => {
    const file = join(dir, "audit_results.jsonl");
    await writeFile(file, raw(6));
    await writeFile(join(dir, "audit_state.json"), JSON.stringify({ status: "not_started", obligations: [] }));
    const result = await captureConsole(() => cmdCleanup(["--artifacts-dir", dir]));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "skipped", reason: expect.stringContaining("Historical audit evidence") });
    expect(await readFile(file)).toEqual(raw(6));
    await expect(readdir(archive)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("late raw-only diagnostics are archived without changing the promoted report pair", async () => {
  await fixture(async (dir) => {
    await writeCompletedQuestionReport(dir);
    const output = join(dir, "..");
    const readPair = () => Promise.all(["audit-report.md", "audit-findings.json"].map(name => readFile(join(output, name))));
    const before = await readPair();
    const rawDiagnostic = Buffer.from("late raw diagnostic, not a JSON record\n");
    await writeFile(join(dir, "agent-feedback.jsonl"), rawDiagnostic);
    expect(await rollOverFinishedRun(dir)).toBe(true);
    expect(await readPair()).toEqual(before);
    expect(await readFile(join(output, "audit-agent-feedback.jsonl"))).toEqual(rawDiagnostic);
  });
});

test("missing v2 plan blocks next-step and preserves the ended run", async () => {
  await withTempRepo(async root => {
    const dir = join(root, ".audit-tools", "audit");
    await writeCompletedQuestionReport(dir);
    const session = await readFile(join(dir, "review_session.json"));
    const machine = await readFile(join(dir, "audit-findings.json"));
    await rm(join(dir, "review_plan.json"));
    expect(await rollOverFinishedRun(dir)).toBe(false);
    const step = await callNextStep(root, dir);
    expect(step).toMatchObject({ status: "blocked" });
    expect(step.step_kind).not.toBe("present_report");
    expect(await readFile(join(dir, "review_session.json"))).toEqual(session);
    expect(await readFile(join(dir, "audit-findings.json"))).toEqual(machine);
    expect(await readFile(join(dir, "run-ended.json"), "utf8")).toBeTruthy();
  });
});
