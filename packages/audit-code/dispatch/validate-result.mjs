import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { validateResult } from "./validate.mjs";

const runIdIdx = process.argv.indexOf("--run-id");
const taskIdIdx = process.argv.indexOf("--task-id");
const artifactsDirIdx = process.argv.indexOf("--artifacts-dir");

const runId = runIdIdx !== -1 ? process.argv[runIdIdx + 1] : undefined;
const taskId = taskIdIdx !== -1 ? process.argv[taskIdIdx + 1] : undefined;

if (!runId || !taskId) {
  console.error("Usage: node dispatch/validate-result.mjs --run-id <run_id> --task-id <task_id> [--artifacts-dir <dir>]");
  process.exit(1);
}

const artifactsDir = artifactsDirIdx !== -1 && process.argv[artifactsDirIdx + 1]
  ? resolve(process.argv[artifactsDirIdx + 1])
  : join(process.cwd(), ".audit-artifacts");

const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
const resultPath = join(artifactsDir, "runs", runId, "task-results", sanitized + ".json");

if (!existsSync(resultPath)) {
  console.error(`File not found: ${resultPath}`);
  process.exit(1);
}

let resultObj;
try {
  resultObj = JSON.parse(readFileSync(resultPath, "utf8"));
} catch (e) {
  console.error(`Invalid JSON in ${resultPath}: ${e.message}`);
  process.exit(1);
}

const tasksPath = join(artifactsDir, "runs", runId, "pending-audit-tasks.json");
let task = null;
if (existsSync(tasksPath)) {
  try {
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    task = tasks.find(t => t.task_id === taskId) ?? null;
  } catch (e) {
    process.stderr.write(`[warn] Could not read pending-audit-tasks.json; line-count validation will be skipped: ${e.message}\n`);
  }
}

const { valid, errors } = validateResult(resultObj, task);

if (valid) {
  console.log("✓ valid:", taskId);
  process.exit(0);
} else {
  console.error("✗ invalid:", taskId);
  console.error(JSON.stringify(errors, null, 2));
  process.exit(1);
}
