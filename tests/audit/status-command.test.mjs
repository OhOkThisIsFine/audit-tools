import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const { runCli } = await import("../../src/audit/cli.ts");

async function runStatus(artifactsDir) {
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

async function withTempDir(fn) {
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
    } catch (e) {
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

test("cmdStatus includes recent run ledger entries", async () => {
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

    const ledger = {
      runs: [
        {
          run_id: "run-001",
          provider: "worker-command",
          obligation_id: "plan",
          selected_executor: "planning_executor",
          status: "completed",
          started_at: "2026-01-01T00:00:00.000Z",
          ended_at: "2026-01-01T00:01:00.000Z",
          result_path: join(artifactsDir, "runs", "run-001", "result.json"),
        },
        {
          run_id: "run-002",
          provider: "worker-command",
          obligation_id: "audit_tasks",
          selected_executor: "dispatch_executor",
          status: "completed",
          started_at: "2026-01-01T00:02:00.000Z",
          ended_at: "2026-01-01T00:03:00.000Z",
          result_path: join(artifactsDir, "runs", "run-002", "result.json"),
        },
      ],
    };
    await writeFile(
      join(artifactsDir, "run-ledger.json"),
      JSON.stringify(ledger, null, 2),
    );

    const result = await runStatus(artifactsDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);

    expect(Array.isArray(parsed.recent_runs), "recent_runs should be an array").toBeTruthy();
    expect(parsed.recent_runs.length > 0, "recent_runs should be non-empty").toBeTruthy();

    const firstEntry = parsed.recent_runs[0];
    expect("run_id" in firstEntry, "each entry should have run_id").toBeTruthy();
    expect("obligation_id" in firstEntry, "each entry should have obligation_id").toBeTruthy();
    expect("status" in firstEntry, "each entry should have status").toBeTruthy();
    expect("started_at" in firstEntry, "each entry should have started_at").toBeTruthy();

    // Should be limited to last 5 runs (newest first)
    expect(parsed.recent_runs.length <= 5, "recent_runs should be capped at 5").toBeTruthy();
    expect(parsed.recent_runs[0].run_id).toBe("run-002");
    expect(parsed.recent_runs[1].run_id).toBe("run-001");
  });
});

test("cmdStatus includes pending task counts from the most recent run directory", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    const runId = "20260101T000000000Z_audit_tasks_001";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });

    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active", obligations: [] }, null, 2),
    );

    const pendingTasks = [
      { task_id: "t1", unit_id: "u1", pass_id: "p1", lens: "security", file_paths: [], rationale: "r", status: "complete" },
      { task_id: "t2", unit_id: "u1", pass_id: "p1", lens: "security", file_paths: [], rationale: "r" },
      { task_id: "t3", unit_id: "u2", pass_id: "p1", lens: "security", file_paths: [], rationale: "r" },
    ];
    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify(pendingTasks, null, 2),
    );

    const result = await runStatus(artifactsDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);

    expect(parsed.pending_tasks !== null, "pending_tasks should not be null").toBeTruthy();
    expect(parsed.pending_tasks.total).toBe(3);
    expect(parsed.pending_tasks.remaining).toBe(2);
    expect(parsed.pending_tasks.run_id).toBe(runId);
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
