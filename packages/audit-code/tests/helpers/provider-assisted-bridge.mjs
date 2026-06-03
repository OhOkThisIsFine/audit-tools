import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { countLines } from "./countLines.mjs";

function fail(message) {
  throw new Error(message);
}

function describeValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string, got ${describeValue(value)}.`);
  }
}

function assertStringArray(value, label, options = {}) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of strings.`);
  }
  if (!options.allowEmpty && value.length === 0) {
    fail(`${label} must not be empty.`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail(`${label}[${index}] must be a non-empty string.`);
    }
  });
}

function looksLikeCliFlag(value) {
  return typeof value === "string" && value.startsWith("--");
}

async function assertAccessibleDirectory(path, label) {
  assertNonEmptyString(path, label);
  try {
    await access(path);
  } catch (error) {
    fail(`${label} does not exist or is not accessible: ${path}`);
  }
}

async function buildFileCoverage(task, root) {
  return Promise.all(
    task.file_paths.map(async (path) => ({
      path,
      total_lines: await countLines(root, path),
    })),
  );
}

function validatePendingTask(task, index) {
  if (!isRecord(task)) {
    fail(`pending task ${index} must be an object, got ${describeValue(task)}.`);
  }
  assertNonEmptyString(task.task_id, `pending task ${index}.task_id`);
  assertNonEmptyString(task.unit_id, `pending task ${index}.unit_id`);
  assertNonEmptyString(task.pass_id, `pending task ${index}.pass_id`);
  assertNonEmptyString(task.lens, `pending task ${index}.lens`);
  assertStringArray(task.file_paths, `pending task ${index}.file_paths`);
}

async function buildSyntheticResults(tasks, root) {
  return Promise.all(tasks.map(async (task, index) => {
    validatePendingTask(task, index);
    const notes = ["Synthetic provider-assisted completion result."];
    if (typeof task.priority === "string" && task.priority.trim().length > 0) {
      notes.push(`Priority: ${task.priority}`);
    }
    if (Array.isArray(task.tags) && task.tags.length > 0) {
      notes.push(`Tags: ${task.tags.join(", ")}`);
    }
    return {
      task_id: task.task_id,
      unit_id: task.unit_id,
      pass_id: task.pass_id,
      lens: task.lens,
      agent_role: "provider-assisted-reviewer",
      file_coverage: await buildFileCoverage(task, root),
      findings: [],
      notes,
      requires_followup: false,
    };
  }));
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function readJsonFile(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    fail(`${label} could not be read from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} JSON could not be parsed from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateWorkerTask(task) {
  if (!isRecord(task)) {
    fail(`task must be an object, got ${describeValue(task)}.`);
  }

  assertNonEmptyString(task.contract_version, "task.contract_version");
  assertNonEmptyString(task.run_id, "task.run_id");
  assertNonEmptyString(task.repo_root, "task.repo_root");
  assertNonEmptyString(task.artifacts_dir, "task.artifacts_dir");
  assertNonEmptyString(task.preferred_executor, "task.preferred_executor");
  assertNonEmptyString(task.result_path, "task.result_path");
  assertStringArray(task.worker_command, "task.worker_command");

  if (looksLikeCliFlag(task.audit_results_path)) {
    fail(
      `task.audit_results_path resolved to '${task.audit_results_path}', which looks like a CLI flag instead of a file path.`,
    );
  }

  await assertAccessibleDirectory(task.repo_root, "task.repo_root");
  await assertAccessibleDirectory(task.artifacts_dir, "task.artifacts_dir");
}

const taskPath = process.argv[2];
if (!taskPath) {
  throw new Error("provider-assisted-bridge requires the task path argument.");
}

const task = await readJsonFile(taskPath, "task");
await validateWorkerTask(task);

if (task.preferred_executor === "agent") {
  if (!task.audit_results_path) {
    throw new Error("Agent task is missing audit_results_path.");
  }

  const tasksPath =
    task.pending_audit_tasks_path ??
    join(task.artifacts_dir, "audit_tasks.json");
  const pendingTasks = await readJsonFile(tasksPath, "pending audit tasks");
  if (!Array.isArray(pendingTasks)) {
    fail("pending audit tasks must be a JSON array.");
  }
  await mkdir(dirname(task.audit_results_path), { recursive: true });
  await writeFile(
    task.audit_results_path,
    JSON.stringify(await buildSyntheticResults(pendingTasks, task.repo_root), null, 2),
    "utf8",
  );
}

const [command, ...args] = task.worker_command;
assertNonEmptyString(command, "task.worker_command[0]");
const exitCode = await runCommand(command, args, task.repo_root);
process.exitCode = exitCode;
