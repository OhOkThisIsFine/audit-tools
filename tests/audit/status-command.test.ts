import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  });
});

test("cmdStatus does NOT advertise the retired run ledger", async () => {
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

    expect(parsed.pending_tasks !== null, "pending_tasks should not be null").toBeTruthy();
    expect(parsed.pending_tasks.total).toBe(3);
    expect(parsed.pending_tasks.remaining).toBe(2);
    expect(parsed.pending_tasks.run_id).toBe(activeRunId);
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
    expect(parsed.pending_tasks).toBe(null);
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
    expect(parsed.pending_tasks).toBe(null);
  });
});

test("cmdStatus exits cleanly with a clear message when no audit_state.json exists", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await runStatus(artifactsDir);

    expect(result.exitCode, "Should exit with code 1 when no audit_state.json").toBe(1);

    // Should produce a human-readable message, not throw
    const combined = result.stdout + result.stderr;
    expect(combined, "Should include explanatory message").toMatch(/no active audit|audit_state/i);
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
