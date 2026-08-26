import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateResult } from "./validate.mjs";
import { resolveArtifactsDir } from "./artifacts-dir.mjs";

/**
 * Resolve the AuditTask context for `taskId` from the run's pending
 * manifest. Degrades to `task: null` (never throws) when the manifest is
 * absent or unreadable — validateResult's fail-closed null-task branch is the
 * single enforcement point downstream; this helper only ever supplies
 * context, it never itself decides pass/fail.
 *
 * @param {{ artifactsDir: string, runId: string, taskId: string }} options
 * @returns {{ task: object | null, warning?: string }}
 */
export function resolveTaskContext({ artifactsDir, runId, taskId }) {
  const tasksPath = join(artifactsDir, "runs", runId, "pending-audit-tasks.json");
  if (!existsSync(tasksPath)) {
    return { task: null };
  }
  try {
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    return { task: tasks.find(t => t.task_id === taskId) ?? null };
  } catch (e) {
    return {
      task: null,
      warning: `[warn] Could not read pending-audit-tasks.json; line-count validation will be skipped: ${/** @type {any} */ (e).message}`,
    };
  }
}

/**
 * Importable core (CP-NODE-21 / dispatch-scripts-test-reach): reads one
 * task-results file, resolves its task context via {@link resolveTaskContext},
 * and validates it. No process.exit — the CLI shim below translates the
 * outcome into console output and an exit code, byte-compatible with this
 * script's behavior before the split.
 *
 * @param {{ artifactsDir: string, runId: string, taskId: string }} options
 * @returns {{
 *   ok: boolean,
 *   fatal?: { message: string },
 *   warning?: string,
 *   resultPath: string,
 *   valid?: boolean,
 *   errors?: string[],
 * }}
 */
export function validateOneResult({ artifactsDir, runId, taskId }) {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const resultPath = join(artifactsDir, "runs", runId, "task-results", sanitized + ".json");

  if (!existsSync(resultPath)) {
    return { ok: false, fatal: { message: `File not found: ${resultPath}` }, resultPath };
  }

  let resultObj;
  try {
    resultObj = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (e) {
    return { ok: false, fatal: { message: `Invalid JSON in ${resultPath}: ${/** @type {any} */ (e).message}` }, resultPath };
  }

  const { task, warning } = resolveTaskContext({ artifactsDir, runId, taskId });
  const { valid, errors } = validateResult(resultObj, task);
  return { ok: true, warning, resultPath, valid, errors };
}

function runCli() {
  const runIdIdx = process.argv.indexOf("--run-id");
  const taskIdIdx = process.argv.indexOf("--task-id");

  const runId = runIdIdx !== -1 ? process.argv[runIdIdx + 1] : undefined;
  const taskId = taskIdIdx !== -1 ? process.argv[taskIdIdx + 1] : undefined;

  if (!runId || !taskId) {
    console.error("Usage: node dispatch/validate-result.mjs --run-id <run_id> --task-id <task_id> [--artifacts-dir <dir>]");
    process.exit(1);
  }

  // Default must match where the orchestrator/wrapper actually writes runs:
  // <root>/.audit-tools/audit (COR-bf5c7331), not the legacy `.audit-artifacts`.
  const artifactsDir = resolveArtifactsDir(process.argv);

  const result = validateOneResult({ artifactsDir, runId, taskId });

  if (!result.ok) {
    console.error((/** @type {any} */ (result.fatal)).message);
    process.exit(1);
  }

  if (result.warning) {
    process.stderr.write(result.warning + "\n");
  }

  if (result.valid) {
    console.log("✓ valid:", taskId);
    process.exit(0);
  } else {
    console.error("✗ invalid:", taskId);
    console.error(JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }
}

// Only run the CLI when this file is the process entrypoint — not when a test
// imports validateOneResult()/resolveTaskContext() directly. Compares
// resolved file:// URLs (not raw argv[1] strings) so this is correct on
// Windows, where argv[1] is a backslash path that never equals
// import.meta.url's forward-slash form.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runCli();
}
