import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ObligationStateSchema } from "audit-tools/shared";
import { publishAuditQuestionWorkload, submitAuditQuestionResult } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { writeCurrentStep } from "../../src/audit/cli/steps.js";
import { REVIEW_QUESTION_CONTRACT_VERSION as version, type ReviewQuestion } from "../../src/shared/types/reviewQuestion.js";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const { runCli } = await import("../../src/audit/cli.js");

async function runStatus(artifactsDir: string) {
  const argv = [
    process.execPath,
    join(repoRoot, "src", "cli.ts"),
    "status",
    "--artifacts-dir",
    artifactsDir,
  ];
  const result = await captureConsole(() => runCli(argv));
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

async function withTempDir<T>(fn: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-status-"));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("cmdStatus emits valid JSON with audit_state fields when audit_state.json is present", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    const auditState = {
      status: "active",
      last_obligation: "plan",
      last_executor: "planning_executor",
      obligations: [
        { id: "repo_manifest", state: "satisfied" },
        { id: "plan", state: "present" },
        { id: "audit_tasks", state: "missing" },
      ],
    };
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify(auditState, null, 2),
    );

    const result = await runStatus(artifactsDir);
    expect(result.exitCode, `Unexpected exit code. stderr: ${result.stderr}`).toBe(0);

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      assert.fail(`stdout is not valid JSON: ${result.stdout}\nstderr: ${result.stderr}`);
    }

    expect(parsed.status).toBe("active");
    expect(parsed.last_obligation).toBe("plan");
    expect("obligations_summary" in parsed, "obligations_summary should be present").toBeTruthy();

    const summary = parsed.obligations_summary;
    expect(summary.satisfied).toBe(1);
    expect(summary.present).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.stale).toBe(0);
    expect(summary.blocked).toBe(0);
    expect(summary.not_applicable).toBe(0);
  });
});

test("cmdStatus counts every obligation state and preserves the obligation total", async () => {
  await withTempDir(async (artifactsDir) => {
    const obligations = ObligationStateSchema.options.flatMap((state, index) =>
      Array.from({ length: index + 1 }, (_, occurrence) => ({
        id: `${state}-${occurrence}`,
        state,
      })),
    );
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active", obligations }),
    );

    const result = await runStatus(artifactsDir);
    expect(result.exitCode).toBe(0);
    const summary: Record<string, number> = JSON.parse(result.stdout).obligations_summary;
    expect(Object.keys(summary).sort()).toEqual([...ObligationStateSchema.options].sort());
    for (const [index, state] of ObligationStateSchema.options.entries()) {
      expect(summary[state]).toBe(index + 1);
    }
    expect(Object.values(summary).reduce((sum, count) => sum + count, 0)).toBe(obligations.length);
  });
});

test("cmdStatus does NOT advertise the retired run ledger", async () => {
  // <!-- comment-citation-exempt: names the retired run-ledger loader -->
  // The run ledger was a provenance plane with no producer: `loadRunLedger`
  // read a file no tracked writer ever created, so its empty result was
  // indistinguishable from a run that recorded nothing — and `status` reported
  // `recent_runs: []` as though that were a fact about the run. Both the loader
  // and the field are retired. This asserts the retirement on the COMMAND's
  // output: even a stale `run-ledger.json` file left on disk by an older
  // release is not read, and no field describes it.
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({
        status: "active",
        obligations: [],
      }, null, 2),
    );
    await writeFile(
      join(artifactsDir, "run-ledger.json"),
      JSON.stringify({
        runs: [
          {
            run_id: "run-001",
            obligation_id: "plan",
            selected_executor: "planning_executor",
            status: "completed",
            started_at: "2026-01-01T00:00:00.000Z",
            ended_at: "2026-01-01T00:01:00.000Z",
            result_path: join(artifactsDir, "runs", "run-001", "result.json"),
          },
        ],
      }, null, 2),
    );

    const result = await runStatus(artifactsDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(
      Object.hasOwn(parsed, "recent_runs"),
      "recent_runs advertised a ledger no producer ever wrote, and must be retired with it",
    ).toBe(false);
    expect(
      Object.hasOwn(parsed, "last_obligation_started_at"),
      "the elapsed-time fields were derived from the retired ledger's entries",
    ).toBe(false);
  });
});

/**
 * Write the ACTIVE review-run manifest plus its pending manifest — the pair a
 * review pause leaves behind, and now the only thing `status` reads to find the
 * run the loop is on.
 */
async function writeActiveRun(
  artifactsDir: string,
  runId: string,
  pendingTasks: unknown[],
): Promise<void> {
  const runDir = join(artifactsDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const pendingPath = join(runDir, "pending-audit-tasks.json");
  await writeFile(pendingPath, JSON.stringify(pendingTasks, null, 2));
  await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
  await writeFile(
    join(artifactsDir, "dispatch", "current-review-run.json"),
    JSON.stringify({
      contract_version: "audit-review-run/v1alpha1",
      run_id: runId,
      review_run_path: join(runDir, "review-run.json"),
      pending_audit_tasks_path: pendingPath,
      host_workload_path: join(runDir, "host-workload.json"),
      host_result_map_path: join(runDir, "host-result-map.json"),
    }),
  );
}

test("cmdStatus includes pending task counts from the ACTIVE run, not the newest-named directory", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    // The run the loop is ON. Its name sorts BEFORE the other run's, which is
    // exactly the case a name-sorted scan gets wrong: a derived run id leads
    // with the obligation slug, so "newest name" stopped meaning "newest run"
    // the moment the id stopped being clock-minted.
    const activeRunId = "review-audit_tasks_completed-0123456789abcdef";
    const otherRunId = "review-zzz-ffffffffffffffff";
    await mkdir(join(artifactsDir, "runs", otherRunId), { recursive: true });
    await writeFile(
      join(artifactsDir, "runs", otherRunId, "pending-audit-tasks.json"),
      JSON.stringify([{ task_id: "other", unit_id: "u", pass_id: "p", lens: "security", file_paths: [], rationale: "r" }]),
    );

    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active", obligations: [] }, null, 2),
    );

    const pendingTasks = [
      { task_id: "t1", unit_id: "u1", pass_id: "p1", lens: "security", file_paths: [], rationale: "r", status: "complete" },
      { task_id: "t2", unit_id: "u1", pass_id: "p1", lens: "security", file_paths: [], rationale: "r" },
      { task_id: "t3", unit_id: "u2", pass_id: "p1", lens: "security", file_paths: [], rationale: "r" },
    ];
    await writeActiveRun(artifactsDir, activeRunId, pendingTasks);

    const result = await runStatus(artifactsDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);

    expect(parsed.archived_pending_tasks !== null, "pending_tasks should not be null").toBeTruthy();
    expect(parsed.archived_pending_tasks_state).toBe("available");
    expect(parsed.archived_pending_tasks.total).toBe(3);
    expect(parsed.archived_pending_tasks.remaining).toBe(2);
    expect(parsed.archived_pending_tasks.run_id).toBe(activeRunId);
  });
});

test("cmdStatus degrades to no run when the active review-run manifest is malformed", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active", obligations: [] }, null, 2),
    );
    await writeFile(
      join(artifactsDir, "dispatch", "current-review-run.json"),
      "{not-json\n",
    );

    const result = await runStatus(artifactsDir);

    // `status` reports on the run; it is not the run's validator. A manifest it
    // cannot read says one true thing — this command does not know of an active
    // run — and a stack trace says nothing an operator can use.
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.archived_pending_tasks).toBe(null);
    expect(parsed.archived_pending_tasks_state).toBe("unavailable");
    expect(parsed.status).toBe("active");
  });
});

test("cmdStatus degrades to no run when no active review run exists, even with run directories present", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    // A directory under runs/ is not an active run: without the manifest that
    // names it, which run the loop is on is simply unknown.
    await mkdir(join(artifactsDir, "runs", "review-orphan-0123456789abcdef"), {
      recursive: true,
    });
    await writeFile(
      join(artifactsDir, "runs", "review-orphan-0123456789abcdef", "pending-audit-tasks.json"),
      JSON.stringify([{ task_id: "t1", unit_id: "u1", pass_id: "p1", lens: "security", file_paths: [], rationale: "r" }]),
    );
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active", obligations: [] }, null, 2),
    );

    const result = await runStatus(artifactsDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.archived_pending_tasks).toBe(null);
    expect(parsed.archived_pending_tasks_state).toBe("absent");
  });
});

test("cmdStatus outputs structured JSON with status no_active_audit when audit_state.json is missing", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await runStatus(artifactsDir);

    expect(result.exitCode, "process.exitCode should be 1 on no-active-audit path").toBe(1);

    // stdout should be valid JSON
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      assert.fail(`stdout is not valid JSON on no-active-audit path: ${result.stdout}`);
    }

    expect(parsed.status).toBe("no_active_audit");
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length > 0, "error field should be a non-empty string").toBeTruthy();

    expect(parsed.error, "Should include an explanatory message").toMatch(/no active audit|audit_state/i);

    // Nothing written to stderr on this path
    expect(result.stderr.trim(), "nothing should be written to stderr on no-active-audit path").toBe("");
  });
});

test("cmdStatus surfaces blockers when audit status is blocked", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    const auditState = {
      status: "blocked",
      last_obligation: "audit_tasks",
      blockers: ["No auditable files found in the repository"],
      obligations: [
        { id: "repo_manifest", state: "satisfied" },
        { id: "plan", state: "blocked" },
      ],
    };
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify(auditState, null, 2),
    );

    const result = await runStatus(artifactsDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);

    expect(parsed.status).toBe("blocked");
    expect(Array.isArray(parsed.blockers), "blockers should be an array").toBeTruthy();
    expect(parsed.blockers.length > 0, "blockers should be non-empty when status is blocked").toBeTruthy();
    expect(parsed.blockers[0]).toMatch(/No auditable files/);
  });
});

test("cmdStatus separates a bound question plan from historical task counts", async () => {
  await withTempDir(async (artifactsDir) => {
    await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status: "active" }));
    const planPath = join(artifactsDir, "review_plan.json");
    await writeFile(planPath, JSON.stringify({
      schema_version: "audit-tools/question-review/v1",
      snapshot_id: "snapshot-one",
      inventory: [], questions: [], omissions: [], lens_decisions: [],
    }));
    await writeFile(join(artifactsDir, "review_session.json"), JSON.stringify({
      schema_version: "audit-tools/question-review-session/v1",
      run_id: "question-review-first",
    }));
    const status = JSON.parse((await runStatus(artifactsDir)).stdout);
    expect(status.question_review).toEqual({
      run_id: "question-review-first", snapshot_id: "snapshot-one", planned_questions: 0,
    });
    expect(status.archived_pending_tasks).toBeNull();
    expect(status.question_review_unreadable).toBe(false);

    await writeFile(planPath, "not valid JSON");
    const malformed = JSON.parse((await runStatus(artifactsDir)).stdout);
    expect(malformed.question_review).toBeNull();
    expect(malformed.question_review_unreadable).toBe(true);
  });
});

test("status projects the verified current question handoff without ingesting or advancing", async () => {
  await withTempDir(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const writeJson = (name: string, value: unknown) => writeFile(join(artifactsDir, name), JSON.stringify(value));
    const runId = "question-review-status-fixture";
    const identity = { schema_version: version, question_id: "behavior:test", revision_id: "r1", snapshot_id: "s1" } as const;
    const question: ReviewQuestion = {
      ...identity, lens: "behavior", inventory_item_ids: ["item"], expected_outcome: "Inspect",
      requested_parts: [{ part_id: "scope", expectation: "Inspect" }],
      source_dependencies: [], evidence_dependencies: [], plan_status: "pending",
    };
    const assignment = { ...identity, assignment_id: "review-assignment", authorized_scope: { include: [], exclude: [] }, suggested_sources: [], available_evidence_ids: [] };
    const secondQuestion = { ...question, question_id: "behavior:second" };
    const secondAssignment = { ...assignment, question_id: secondQuestion.question_id, assignment_id: "second-assignment" };
    const boundary = { root, artifactsDir, runId };
    const plan = { schema_version: version, snapshot_id: "s1", inventory: [], questions: [question, secondQuestion], omissions: [], lens_decisions: [] };
    await writeJson("audit_state.json", { status: "active" });
    await writeJson("review_session.json", { schema_version: "audit-tools/question-review-session/v1", run_id: runId });
    await writeJson("review_plan.json", plan);
    const status = async () => JSON.parse((await runStatus(artifactsDir)).stdout).question_review_handoff;
    expect(await status()).toEqual({ state: "unavailable" });

    const { workload_path } = await publishAuditQuestionWorkload({ ...boundary, sourceRoot: root,
      bindings: [
        { question, assignment, sourceFiles: [], evidence: [], dependencies: [] },
        { question: secondQuestion, assignment: secondAssignment, sourceFiles: [], evidence: [], dependencies: [] },
      ] });
    const emit = (rejected: number) => writeCurrentStep({
      artifactsDir, repoRoot: root, stepKind: "dispatch_review", status: "ready", runId,
      progress: { summary: rejected ? "Correct the saved result." : "Wait for answers.", pending_tasks: 2, rejected_tasks: rejected },
      allowedCommands: [], stopCondition: "Submit then continue.", artifactPaths: { host_workload: workload_path }, prompt: "Fixture",
    });
    const step = await emit(0);
    expect(await status()).toMatchObject({ state: "current", action: "await_results", pending_answers: 2, workload_path: step.artifact_paths.host_workload });
    await emit(1);

    const source = (questionId: string, assignmentId: string) => JSON.stringify({ ...identity, question_id: questionId, assignment_id: assignmentId, submission_id: "answer-" + assignmentId,
      inspected_sources: [], evidence_ids: [], limitations: ["synthetic test"],
      answer: { outcome: "inconclusive", findings: [], observations: [], parts: [{ part_id: "scope", outcome: "inconclusive", observation_ids: [] }] },
    });
    const ledger = join(artifactsDir, "runs", runId, "host-accepted-results-ledger.json");
    await expect(readFile(ledger)).rejects.toMatchObject({ code: "ENOENT" });
    await submitAuditQuestionResult({ ...boundary, assignmentId: assignment.assignment_id,
      source: source(question.question_id, assignment.assignment_id) });
    expect(await status()).toMatchObject({
      state: "current", action: "await_results", pending_answers: 1,
      previous_publication_rejections: 1, summary: "Waiting for 1 question answer.",
    });
    await submitAuditQuestionResult({ ...boundary, assignmentId: secondAssignment.assignment_id,
      source: source(secondQuestion.question_id, secondAssignment.assignment_id) });
    const before = await readFile(ledger, "utf8");
    expect(await status()).toMatchObject({ state: "current", action: "continue", pending_answers: 0 });
    expect(await readFile(ledger, "utf8")).toBe(before);
    await writeJson("review_plan.json", { ...plan, questions: [{ ...question, revision_id: "r2" }, secondQuestion] });
    expect(await status()).toEqual({ state: "stale" });
  });
});
