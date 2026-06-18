import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { validateResult } from "./validate.mjs";

const runIdIdx = process.argv.indexOf("--run-id");
if (runIdIdx === -1 || !process.argv[runIdIdx + 1]) {
  console.error("Usage: node dispatch/merge-results.mjs --run-id <run_id> [--artifacts-dir <dir>]");
  process.exit(1);
}
const runId = process.argv[runIdIdx + 1];

const artifactsDirIdx = process.argv.indexOf("--artifacts-dir");
// Default must match where the orchestrator/wrapper actually writes runs:
// <root>/.audit-tools/audit (COR-bf5c7331). The prior `.audit-artifacts`
// default resolved to a directory the pipeline never populates.
const artifactsDir = artifactsDirIdx !== -1 && process.argv[artifactsDirIdx + 1]
  ? resolve(process.argv[artifactsDirIdx + 1])
  : join(process.cwd(), ".audit-tools", "audit");

const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
const auditResultsPath = join(artifactsDir, "runs", runId, "run-results.json");
const failedTasksPath = join(artifactsDir, "runs", runId, "failed-tasks.json");
const tasksPath = join(artifactsDir, "runs", runId, "pending-audit-tasks.json");

// Build task map for validation context
const taskMap = {};
if (existsSync(tasksPath)) {
  try {
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    for (const task of tasks) {
      taskMap[task.task_id] = task;
    }
  } catch (e) {
    process.stderr.write(`[warn] Could not read pending-audit-tasks.json; line-count validation will be skipped: ${e.message}\n`);
  }
}

if (!existsSync(taskResultsDir)) {
  console.error(`task-results directory not found: ${taskResultsDir}`);
  process.exit(1);
}

const files = readdirSync(taskResultsDir).filter(f => f.endsWith(".json"));

const passing = [];
const failing = [];

for (const filename of files) {
  const filePath = join(taskResultsDir, filename);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    failing.push({ task_id: filename, errors: [`Invalid JSON: ${e.message}`] });
    continue;
  }

  // Expand top-level AuditResult[] arrays — a worker that emits an array
  // payload must not be treated as one invalid object (INV-01 / COR-bf5c7331).
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const resultObj of candidates) {
    const taskId = resultObj?.task_id;
    const task = (taskId && taskMap[taskId]) ? taskMap[taskId] : null;
    const { valid, errors } = validateResult(resultObj, task);

    if (valid) {
      passing.push(resultObj);
    } else {
      failing.push({ task_id: taskId ?? filename, errors });
    }
  }
}

writeFileSync(auditResultsPath, JSON.stringify(passing, null, 2));

if (failing.length > 0) {
  writeFileSync(failedTasksPath, JSON.stringify(failing, null, 2));
  process.stderr.write(`${failing.length} task(s) failed validation and were excluded:\n`);
  for (const f of failing) {
    for (const err of f.errors) {
      process.stderr.write(`  ✗ ${f.task_id}: ${err}\n`);
    }
  }
}

const total = passing.length + failing.length;
// FND-OBS-bf5c7331: emit a structured JSON summary line to stdout so callers
// get a machine-readable payload alongside the human-readable text line.
// Both are written to stdout; the JSON summary line always comes first so
// programmatic consumers can parse it without stripping the text line.
process.stdout.write(
  JSON.stringify({
    ts: new Date().toISOString(),
    source: "audit-code:merge-results",
    event: "merge_summary",
    total,
    accepted: passing.length,
    rejected: failing.length,
    audit_results_path: auditResultsPath,
    ...(failing.length > 0 ? { failed_tasks_path: failedTasksPath } : {}),
  }) + "\n",
);
console.log(`✓ ${passing.length}/${total} tasks valid → ${auditResultsPath}`);
if (failing.length > 0) {
  console.log("  Re-run those tasks in the next cycle.");
}

// Exit non-zero when any result failed validation so callers can detect
// partial merges and avoid treating them as clean success (INV-03 / COR-bf5c7331-2).
process.exit(failing.length > 0 ? 1 : 0);
