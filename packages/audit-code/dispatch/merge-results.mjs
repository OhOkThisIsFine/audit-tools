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
const artifactsDir = artifactsDirIdx !== -1 && process.argv[artifactsDirIdx + 1]
  ? resolve(process.argv[artifactsDirIdx + 1])
  : join(process.cwd(), ".audit-artifacts");

const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
const auditResultsPath = join(artifactsDir, "runs", runId, "audit-results.json");
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
  } catch {
    // proceed without task context
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
  let resultObj;
  try {
    resultObj = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    failing.push({ task_id: filename, errors: [`Invalid JSON: ${e.message}`] });
    continue;
  }

  const taskId = resultObj?.task_id;
  const task = (taskId && taskMap[taskId]) ? taskMap[taskId] : null;
  const { valid, errors } = validateResult(resultObj, task);

  if (valid) {
    passing.push(resultObj);
  } else {
    failing.push({ task_id: taskId ?? filename, errors });
  }
}

writeFileSync(auditResultsPath, JSON.stringify(passing, null, 2));

if (failing.length > 0) {
  writeFileSync(failedTasksPath, JSON.stringify(failing, null, 2));
  process.stderr.write(`${failing.length} task(s) failed validation and were excluded:\n`);
  for (const f of failing) {
    process.stderr.write(`  ✗ ${f.task_id}: ${f.errors[0]}\n`);
  }
}

const total = files.length;
console.log(`✓ ${passing.length}/${total} tasks valid → ${auditResultsPath}`);
if (failing.length > 0) {
  console.log("  Re-run those tasks in the next cycle.");
}

process.exit(0);
