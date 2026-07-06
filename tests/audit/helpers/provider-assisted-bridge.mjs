import { mkdir, readFile, writeFile } from "node:fs/promises";
// This helper is EXECUTED AS A SPAWNED CHILD `node` process (see
// provider-assisted-bridge.test.mjs `runBridge`), so it must NOT import the
// tests/helpers/spawn.mjs wrapper — that transitively imports the shared
// `src/shared/tooling/exec.ts` source, which a plain node child cannot load
// (ERR_UNKNOWN_FILE_EXTENSION ".ts", no vitest transform). Use raw child_process
// with `windowsHide: true` inline instead (INV-WH covers this file via the
// child-executed-spawn inline check, not the no-raw-import walk).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNonEmptyString, assertStringArray, describeValue, fail, isRecord, looksLikeCliFlag, assertAccessibleDirectory } from "./validate.mjs";
import { buildSyntheticResults } from "./synthetic-results.mjs";

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
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

// TST-27c498da: guard top-level side-effecting code so that this file can be
// imported in tests without triggering argv-driven execution.
//
// Compare via pathToFileURL(argv[1]).href rather than URL(import.meta.url).pathname:
// on Windows the latter yields a drive-prefixed path with a leading slash
// (e.g. "/C:/.../bridge.mjs") that never equals the backslash path in argv[1],
// so the guard was silently false and the whole bridge no-opped (exit 0, no
// results written). pathToFileURL produces the exact "file:///C:/..." form that
// import.meta.url uses on every platform.
const isMainModule =
  typeof import.meta.url === "string" &&
  process.argv[1] != null &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
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
}
