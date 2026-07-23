import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { validateResult } from "./validate.mjs";
import { PACKET_SCHEMA_FILENAMES } from "../dist/audit/io/runArtifacts.js";

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

if (!existsSync(taskResultsDir)) {
  console.error(`task-results directory not found: ${taskResultsDir}`);
  process.exit(1);
}

// Manifest-reconciled completeness (COR-7602834d cluster): acceptance is judged against the
// pending manifest, never against whichever task-results files happen to exist.
// A missing or unreadable manifest means no task context can be established, so
// the merge hard-fails BEFORE any write (fail-closed task-identity gate) instead
// of validating results fail-open with no assigned task.
let tasks;
try {
  tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
  if (!Array.isArray(tasks)) {
    throw new Error("pending-audit-tasks.json must be a JSON array of AuditTasks");
  }
} catch (e) {
  console.error(
    `Cannot read pending manifest ${tasksPath}: ${e.message}\n` +
      "merge-results judges acceptance against the pending manifest (fail-closed); aborting before any write.",
  );
  process.exit(1);
}
const taskMap = new Map(tasks.filter(t => t && typeof t.task_id === "string").map(t => [t.task_id, t]));

// Result-file selection excludes the schema pointer files prepare-dispatch
// copies into task-results/ for optional worker self-validation — they are
// support artifacts, never results, and must not be counted as failures.
const PACKET_SCHEMA_FILENAME_SET = new Set(PACKET_SCHEMA_FILENAMES);
const files = readdirSync(taskResultsDir)
  .filter(f => f.endsWith(".json") && !PACKET_SCHEMA_FILENAME_SET.has(f))
  .sort();

const failing = [];
const resultsByTaskId = new Map();

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
    const taskId =
      resultObj && typeof resultObj === "object" && !Array.isArray(resultObj) &&
      typeof resultObj.task_id === "string"
        ? resultObj.task_id
        : undefined;
    if (!taskId) {
      failing.push({
        task_id: filename,
        errors: ["Result has no task_id; cannot bind it to an assigned task."],
      });
      continue;
    }
    if (resultsByTaskId.has(taskId)) {
      // Dedup-by-task_id: the first on-disk result for a task is authoritative;
      // later copies are rejected, never double-merged.
      failing.push({
        task_id: taskId,
        errors: [`Duplicate audit result for assigned task '${taskId}'.`],
      });
      continue;
    }
    if (!taskMap.has(taskId)) {
      // Identity is the tool's authority: a result that matches no assigned
      // task in the pending manifest never validates (fail-closed).
      failing.push({
        task_id: taskId,
        errors: [`Unknown task_id '${taskId}': not in the pending manifest for run '${runId}'.`],
      });
      continue;
    }
    resultsByTaskId.set(taskId, resultObj);
  }
}

// Validate each MANIFEST task's result: present → validate in the assigned
// task's context; absent → a genuine failure (the manifest, not the file
// listing, decides completeness).
const passing = [];
for (const task of taskMap.values()) {
  const resultObj = resultsByTaskId.get(task.task_id);
  if (resultObj === undefined) {
    failing.push({ task_id: task.task_id, errors: ["Missing audit result for assigned task."] });
    continue;
  }
  const { valid, errors } = validateResult(resultObj, task);
  if (valid) {
    passing.push(resultObj);
  } else {
    failing.push({ task_id: task.task_id, errors });
  }
}

if (failing.length > 0) {
  writeFileSync(failedTasksPath, JSON.stringify(failing, null, 2));
  process.stderr.write(`${failing.length} task(s) failed validation and were excluded:\n`);
  for (const f of failing) {
    for (const err of f.errors) {
      process.stderr.write(`  ✗ ${f.task_id}: ${err}\n`);
    }
  }
}

// No destructive truncation on re-run (COR-44bea9c0 cluster): run-results.json is written
// only when there is something to merge. A blocked no-op (nothing passed while
// something failed) — e.g. a stray re-invocation after a successful merge —
// must never truncate a previously written run-results.json to [].
if (passing.length > 0) {
  writeFileSync(auditResultsPath, JSON.stringify(passing, null, 2));
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
