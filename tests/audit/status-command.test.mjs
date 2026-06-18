import test from "node:test";
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
    assert.equal(result.exitCode, 0, `Unexpected exit code. stderr: ${result.stderr}`);

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      assert.fail(`stdout is not valid JSON: ${result.stdout}\nstderr: ${result.stderr}`);
    }

    assert.equal(parsed.status, "active");
    assert.equal(parsed.last_obligation, "plan");
    assert.ok("obligations_summary" in parsed, "obligations_summary should be present");

    const summary = parsed.obligations_summary;
    assert.equal(summary.satisfied, 1);
    assert.equal(summary.present, 1);
    assert.equal(summary.missing, 1);
    assert.equal(summary.stale, 0);
    assert.equal(summary.blocked, 0);
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
          provider: "local-subprocess",
          obligation_id: "plan",
          selected_executor: "planning_executor",
          status: "completed",
          started_at: "2026-01-01T00:00:00.000Z",
          ended_at: "2026-01-01T00:01:00.000Z",
          result_path: join(artifactsDir, "runs", "run-001", "result.json"),
        },
        {
          run_id: "run-002",
          provider: "local-subprocess",
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
    assert.equal(result.exitCode, 0);

    const parsed = JSON.parse(result.stdout);

    assert.ok(Array.isArray(parsed.recent_runs), "recent_runs should be an array");
    assert.ok(parsed.recent_runs.length > 0, "recent_runs should be non-empty");

    const firstEntry = parsed.recent_runs[0];
    assert.ok("run_id" in firstEntry, "each entry should have run_id");
    assert.ok("obligation_id" in firstEntry, "each entry should have obligation_id");
    assert.ok("status" in firstEntry, "each entry should have status");
    assert.ok("started_at" in firstEntry, "each entry should have started_at");

    // Should be limited to last 5 runs (newest first)
    assert.ok(parsed.recent_runs.length <= 5, "recent_runs should be capped at 5");
    assert.equal(parsed.recent_runs[0].run_id, "run-002");
    assert.equal(parsed.recent_runs[1].run_id, "run-001");
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
    assert.equal(result.exitCode, 0);

    const parsed = JSON.parse(result.stdout);

    assert.ok(parsed.pending_tasks !== null, "pending_tasks should not be null");
    assert.equal(parsed.pending_tasks.total, 3);
    assert.equal(parsed.pending_tasks.remaining, 2);
    assert.equal(parsed.pending_tasks.run_id, runId);
  });
});

test("cmdStatus exits cleanly with a clear message when no audit_state.json exists", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await runStatus(artifactsDir);

    assert.equal(result.exitCode, 1, "Should exit with code 1 when no audit_state.json");

    // Should produce a human-readable message, not throw
    const combined = result.stdout + result.stderr;
    assert.match(combined, /no active audit|audit_state/i, "Should include explanatory message");
  });
});

test("cmdStatus outputs structured JSON with status no_active_audit when audit_state.json is missing", async () => {
  await withTempDir(async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await runStatus(artifactsDir);

    assert.equal(result.exitCode, 1, "process.exitCode should be 1 on no-active-audit path");

    // stdout should be valid JSON
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      assert.fail(`stdout is not valid JSON on no-active-audit path: ${result.stdout}`);
    }

    assert.equal(parsed.status, "no_active_audit");
    assert.equal(typeof parsed.error, "string");
    assert.ok(parsed.error.length > 0, "error field should be a non-empty string");

    // Nothing written to stderr on this path
    assert.equal(result.stderr.trim(), "", "nothing should be written to stderr on no-active-audit path");
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
    assert.equal(result.exitCode, 0);

    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.status, "blocked");
    assert.ok(Array.isArray(parsed.blockers), "blockers should be an array");
    assert.ok(parsed.blockers.length > 0, "blockers should be non-empty when status is blocked");
    assert.match(parsed.blockers[0], /No auditable files/);
  });
});
