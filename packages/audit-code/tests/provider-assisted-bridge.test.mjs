import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "helpers", "provider-assisted-bridge.mjs");

function runBridge(taskPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, taskPath], {
      cwd: dirname(taskPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "provider-assisted-bridge-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("provider-assisted bridge fails clearly on malformed task JSON", async () => {
  await withTempDir(async (dir) => {
    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, "{not-valid-json", "utf8");

    const result = await runBridge(taskPath);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /task JSON could not be parsed/i);
  });
});

test("provider-assisted bridge validates agent task and pending task structure before execution", async () => {
  await withTempDir(async (dir) => {
    const repoRoot = join(dir, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "src.ts"), "export const x = 1;\n", "utf8");

    const tasksPath = join(dir, "pending-audit-tasks.json");
    await writeFile(tasksPath, JSON.stringify([{ task_id: "task-1" }], null, 2));

    const resultPath = join(dir, "result.json");
    const auditResultsPath = join(dir, "run-results.json");
    const taskPath = join(dir, "task.json");
    await writeFile(
      taskPath,
      JSON.stringify(
        {
          contract_version: "audit-code-worker/v1alpha1",
          run_id: "run-1",
          repo_root: repoRoot,
          artifacts_dir: dir,
          obligation_id: "audit_tasks_completed",
          preferred_executor: "agent",
          result_path: resultPath,
          worker_command: [process.execPath, "-e", "process.exit(0)"],
          audit_results_path: auditResultsPath,
          pending_audit_tasks_path: tasksPath,
        },
        null,
        2,
      ),
    );

    const result = await runBridge(taskPath);
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /pending task 0\.unit_id must be a non-empty string/i,
    );
  });
});

test("provider-assisted bridge writes synthetic results for valid agent tasks", async () => {
  await withTempDir(async (dir) => {
    const repoRoot = join(dir, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "src.ts"), "export const x = 1;\n", "utf8");

    const tasksPath = join(dir, "pending-audit-tasks.json");
    await writeFile(
      tasksPath,
      JSON.stringify(
        [
          {
            task_id: "task-1",
            unit_id: "unit-1",
            pass_id: "pass:correctness",
            lens: "correctness",
            file_paths: ["src.ts"],
            rationale: "fixture",
            priority: "high",
          },
        ],
        null,
        2,
      ),
    );

    const resultPath = join(dir, "result.json");
    const auditResultsPath = join(dir, "run-results.json");
    const taskPath = join(dir, "task.json");
    await writeFile(
      taskPath,
      JSON.stringify(
        {
          contract_version: "audit-code-worker/v1alpha1",
          run_id: "run-1",
          repo_root: repoRoot,
          artifacts_dir: dir,
          obligation_id: "audit_tasks_completed",
          preferred_executor: "agent",
          result_path: resultPath,
          worker_command: [process.execPath, "-e", "process.exit(0)"],
          audit_results_path: auditResultsPath,
          pending_audit_tasks_path: tasksPath,
        },
        null,
        2,
      ),
    );

    const result = await runBridge(taskPath);
    assert.equal(result.code, 0);

    const written = JSON.parse(await readFile(auditResultsPath, "utf8"));
    assert.equal(written.length, 1);
    assert.equal(written[0].task_id, "task-1");
    assert.equal(written[0].file_coverage[0].total_lines, 1);
    assert.ok(
      written[0].notes.some((note) => /priority: high/i.test(note)),
    );
  });
});

async function buildValidTaskFixture(dir) {
  const repoRoot = join(dir, "repo");
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, "src.ts"), "export const x = 1;\n", "utf8");

  const tasksPath = join(dir, "pending-audit-tasks.json");
  await writeFile(
    tasksPath,
    JSON.stringify(
      [
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass:correctness",
          lens: "correctness",
          file_paths: ["src.ts"],
          rationale: "fixture",
          priority: "high",
        },
      ],
      null,
      2,
    ),
  );

  const resultPath = join(dir, "result.json");
  const auditResultsPath = join(dir, "run-results.json");
  return { repoRoot, tasksPath, resultPath, auditResultsPath };
}

// ── worker command failure modes (TST-bb375ff3) ────────────────────────────

test("provider-assisted bridge fails clearly when worker command exits non-zero", async () => {
  await withTempDir(async (dir) => {
    const { repoRoot, tasksPath, resultPath, auditResultsPath } = await buildValidTaskFixture(dir);

    const taskPath = join(dir, "task.json");
    await writeFile(
      taskPath,
      JSON.stringify(
        {
          contract_version: "audit-code-worker/v1alpha1",
          run_id: "run-1",
          repo_root: repoRoot,
          artifacts_dir: dir,
          obligation_id: "audit_tasks_completed",
          preferred_executor: "agent",
          result_path: resultPath,
          worker_command: [process.execPath, "-e", "process.exit(1)"],
          audit_results_path: auditResultsPath,
          pending_audit_tasks_path: tasksPath,
        },
        null,
        2,
      ),
    );

    const result = await runBridge(taskPath);
    assert.notEqual(result.code, 0, "bridge should exit non-zero when worker exits with code 1");
  });
});

test("provider-assisted bridge fails clearly when worker command cannot be spawned", async () => {
  await withTempDir(async (dir) => {
    const { repoRoot, tasksPath, resultPath, auditResultsPath } = await buildValidTaskFixture(dir);

    const taskPath = join(dir, "task.json");
    await writeFile(
      taskPath,
      JSON.stringify(
        {
          contract_version: "audit-code-worker/v1alpha1",
          run_id: "run-1",
          repo_root: repoRoot,
          artifacts_dir: dir,
          obligation_id: "audit_tasks_completed",
          preferred_executor: "agent",
          result_path: resultPath,
          worker_command: ["/nonexistent-executable-path-xyz"],
          audit_results_path: auditResultsPath,
          pending_audit_tasks_path: tasksPath,
        },
        null,
        2,
      ),
    );

    const result = await runBridge(taskPath);
    assert.notEqual(result.code, 0, "bridge should exit non-zero when worker command cannot be spawned");
    assert.match(result.stderr, /ENOENT|spawn|failed/i, "stderr should indicate the spawn failure");
  });
});
