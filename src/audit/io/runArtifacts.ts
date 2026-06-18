import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonFile } from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { RunPaths, DispatchBatchRun } from "./runArtifactTypes.js";
import {
  CURRENT_TASK_FILENAME,
  CURRENT_PROMPT_FILENAME,
  CURRENT_TASKS_FILENAME,
} from "../supervisor/operatorHandoff.js";

export type { RunPaths, DispatchBatchRun } from "./runArtifactTypes.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
// src/audit/io/ (source) or dist/audit/io/ (built) → three levels up is the
// package root, which holds the packaged schemas/ asset dir.
const packageRoot = resolve(moduleDir, "..", "..", "..");
const auditResultSchemaPath = join(packageRoot, "schemas", "audit_result.schema.json");
const auditResultsSchemaPath = join(packageRoot, "schemas", "audit_results.schema.json");
const findingSchemaPath = join(packageRoot, "schemas", "finding.schema.json");

/**
 * Schema files copied into a dispatch run's `task-results/` directory so packet
 * workers can optionally self-validate before submit. `audit_result.schema.json`
 * `$ref`s the other two by relative filename, so all three must sit side-by-side
 * for a validator to resolve them. Exported so merge-and-ingest can recognize
 * them as legitimate (not stray) files in `task-results/`.
 */
export const PACKET_SCHEMA_FILENAMES = [
  "audit_result.schema.json",
  "finding.schema.json",
  "audit_task.schema.json",
] as const;

async function copySchemaFiles(
  targetDir: string,
  entries: Array<{ srcPath: string; name: string }>,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    await writeFile(join(targetDir, entry.name), await readFile(entry.srcPath, "utf8"), "utf8");
  }
}

/**
 * Copy {@link PACKET_SCHEMA_FILENAMES} into `targetDir` under their canonical
 * filenames, making the AuditResult schema reachable from a dispatch run's
 * `task-results/` directory.
 */
export async function writePacketSchemaFiles(
  targetDir: string,
  pkgRoot: string,
): Promise<void> {
  await copySchemaFiles(targetDir, PACKET_SCHEMA_FILENAMES.map(name => ({ srcPath: join(pkgRoot, "schemas", name), name })));
}
// CURRENT_TASK_FILENAME, CURRENT_PROMPT_FILENAME, CURRENT_TASKS_FILENAME
// imported from operatorHandoff.ts (shared canonical filenames).
const CURRENT_SINGLE_TASK_FILENAME = "current-single-task.json";
const CURRENT_SINGLE_TASK_PROMPT_FILENAME = "current-single-task-prompt.md";
const CURRENT_SCHEMA_FILENAME = "audit-result.schema.json";
const CURRENT_RESULTS_SCHEMA_FILENAME = "audit-results.schema.json";
const CURRENT_FINDING_SCHEMA_FILENAME = "finding.schema.json";

// Section labels for the single-task fallback prompt.
const FALLBACK_PROMPT_TITLE = "# audit-code single-task fallback";
const FALLBACK_SECTION_FILES = "Assigned files and line counts:";
const FALLBACK_SECTION_INSTRUCTIONS = "Instructions:";

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}

function formatRunTimestamp(value: Date): string {
  return [
    pad(value.getUTCFullYear(), 4),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate()),
    "T",
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds()),
    pad(value.getUTCMilliseconds(), 3),
    "Z",
  ].join("");
}

function normalizeRunIdSegment(value: string | null): string {
  const normalized = (value ?? "terminal")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "terminal";
}

export function buildRunId(
  obligationId: string | null,
  index: number,
  now: Date = new Date(),
): string {
  const timestamp = formatRunTimestamp(now);
  const obligation = normalizeRunIdSegment(obligationId);
  return `${timestamp}_${obligation}_${String(index).padStart(3, "0")}`;
}

export function getRunPaths(artifactsDir: string, runId: string): RunPaths {
  const runDir = join(artifactsDir, "runs", runId);
  return {
    runDir,
    taskPath: join(runDir, "task.json"),
    promptPath: join(runDir, "prompt.md"),
    resultPath: join(runDir, "result.json"),
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
    statusPath: join(runDir, "status.json"),
  };
}

export async function ensureSupervisorDirs(
  artifactsDir: string,
): Promise<void> {
  await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
  await mkdir(join(artifactsDir, "runs"), { recursive: true });
}

async function writeDispatchSchemaFiles(artifactsDir: string): Promise<void> {
  const dispatchDir = join(artifactsDir, "dispatch");
  // Ensure the dispatch dir exists: this is now written before the pointer
  // files (which formerly created it), and parallel-slot dispatch may reach
  // here before the canonical dispatch has run.
  await copySchemaFiles(dispatchDir, [
    { srcPath: auditResultSchemaPath,  name: CURRENT_SCHEMA_FILENAME },
    { srcPath: auditResultsSchemaPath, name: CURRENT_RESULTS_SCHEMA_FILENAME },
    { srcPath: findingSchemaPath,      name: CURRENT_FINDING_SCHEMA_FILENAME },
  ]);
}

function renderSingleTaskFallbackPrompt(task: WorkerTask, auditTask: AuditTask): string {
  const commandArgv = JSON.stringify(task.worker_command);
  const lineCounts = auditTask.file_paths
    .map((path) => `- ${path}: ${auditTask.file_line_counts?.[path] ?? 0} lines`)
    .join("\n");
  return [
    FALLBACK_PROMPT_TITLE,
    "",
    "Use this file only when the conversation host cannot dispatch subagents.",
    "This prompt is generated deterministically from the first pending task.",
    "",
    `run_id: ${task.run_id}`,
    `task_id: ${auditTask.task_id}`,
    `unit_id: ${auditTask.unit_id}`,
    `pass_id: ${auditTask.pass_id}`,
    `lens: ${auditTask.lens}`,
    `rationale: ${auditTask.rationale}`,
    "",
    FALLBACK_SECTION_FILES,
    lineCounts,
    "",
    FALLBACK_SECTION_INSTRUCTIONS,
    "1. Read only the assigned files above.",
    "2. Produce exactly one AuditResult object for task_id above, wrapped in a JSON array.",
    "3. Write that JSON array to audit_results_path.",
    "4. Run worker_command exactly, then stop without checking audit state or reading a report.",
    "",
    `audit_results_path: ${task.audit_results_path}`,
    `worker_command: ${commandArgv}`,
    "",
  ].join("\n");
}

async function writeSingleTaskFallbackFiles(
  artifactsDir: string,
  task: WorkerTask,
  currentTasks?: AuditTask[],
): Promise<void> {
  if (
    task.preferred_executor !== "agent" ||
    !task.audit_results_path ||
    !currentTasks ||
    currentTasks.length === 0
  ) {
    return;
  }

  const firstTask = currentTasks[0]!;
  await writeJsonFile(
    join(artifactsDir, "dispatch", CURRENT_SINGLE_TASK_FILENAME),
    firstTask,
  );
  await writeFile(
    join(artifactsDir, "dispatch", CURRENT_SINGLE_TASK_PROMPT_FILENAME),
    renderSingleTaskFallbackPrompt(task, firstTask),
    "utf8",
  );
}

export async function writeWorkerTaskFiles(
  task: WorkerTask,
  prompt: string,
  paths: RunPaths,
  artifactsDir: string,
  currentTasks?: AuditTask[],
  options: { updateDispatch?: boolean } = {},
  log?: { event: (name: string, data: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await mkdir(paths.runDir, { recursive: true });
    await writeJsonFile(paths.taskPath, task);
    await writeFile(paths.promptPath, prompt, "utf8");
    await writeJsonFile(paths.statusPath, {
      run_id: task.run_id,
      status: "dispatched",
    });

    // The result schema files are always required by the worker, regardless of
    // whether this run owns the shared "current dispatch" pointer files.
    await writeDispatchSchemaFiles(artifactsDir);

    // Parallel-slot dispatch passes updateDispatch:false so each slot does NOT
    // clobber the shared current-task / current-prompt / current-tasks pointers
    // (only the single canonical dispatch should own them). The default path
    // (updateDispatch unset/true) refreshes those pointers and the single-task
    // fallback.
    const updateDispatch = options.updateDispatch !== false;
    if (!updateDispatch) {
      return;
    }
    await writeJsonFile(
      join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME),
      task,
    );
    await writeFile(
      join(artifactsDir, "dispatch", CURRENT_PROMPT_FILENAME),
      prompt,
      "utf8",
    );
    await writeJsonFile(
      join(artifactsDir, "dispatch", CURRENT_TASKS_FILENAME),
      currentTasks ?? [],
    );
    await writeSingleTaskFallbackFiles(artifactsDir, task, currentTasks);
  } catch (err) {
    log?.event("dispatch_io_error", {
      run_id: task.run_id ?? null,
      function: "writeWorkerTaskFiles",
      error: String(err),
    });
    throw err;
  }
}

export async function writeDispatchBatchFiles(
  artifactsDir: string,
  runs: DispatchBatchRun[],
  currentTasks: AuditTask[],
  log?: { event: (name: string, data: Record<string, unknown>) => void },
): Promise<void> {
  try {
    const summary = {
      contract_version: "audit-code-dispatch/v1alpha1",
      mode: "parallel-batch",
      run_count: runs.length,
      current_tasks_path: join(artifactsDir, "dispatch", CURRENT_TASKS_FILENAME),
      runs,
    };
    const promptLines = [
      "# audit-code parallel dispatch",
      "",
      `This batch launched ${runs.length} deferred review run(s).`,
      "Each run keeps its own task.json, prompt.md, result.json, and status.json under .audit-tools/audit/runs/<run_id>/.",
      "Use current-tasks.json for the combined task list. The per-run files below are operational references for launched workers; do not read per-run prompt or schema files unless debugging a failed dispatch.",
      "",
      "Runs:",
      ...runs.flatMap((run) => [
        `- ${run.run_id}`,
        `  task: ${run.task_path}`,
        `  prompt (worker-owned; do not read during normal orchestration): ${run.prompt_path}`,
        `  result: ${run.result_path}`,
        `  status: ${run.status_path}`,
        ...(run.audit_results_path
          ? [`  audit results: ${run.audit_results_path}`]
          : []),
        ...(run.pending_audit_tasks_path
          ? [`  pending tasks: ${run.pending_audit_tasks_path}`]
          : []),
      ]),
      "",
    ];

    await writeJsonFile(join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME), summary);
    await writeFile(
      join(artifactsDir, "dispatch", CURRENT_PROMPT_FILENAME),
      promptLines.join("\n"),
      "utf8",
    );
    await writeJsonFile(
      join(artifactsDir, "dispatch", CURRENT_TASKS_FILENAME),
      currentTasks,
    );
    await writeDispatchSchemaFiles(artifactsDir);
  } catch (err) {
    log?.event("dispatch_io_error", {
      run_id: "batch",
      function: "writeDispatchBatchFiles",
      error: String(err),
    });
    throw err;
  }
}

export async function clearDispatchFiles(
  artifactsDir: string,
  log?: { event: (name: string, data: Record<string, unknown>) => void },
): Promise<void> {
  const targets = [
    CURRENT_TASK_FILENAME,
    CURRENT_PROMPT_FILENAME,
    CURRENT_TASKS_FILENAME,
    CURRENT_SINGLE_TASK_FILENAME,
    CURRENT_SINGLE_TASK_PROMPT_FILENAME,
    CURRENT_SCHEMA_FILENAME,
    CURRENT_RESULTS_SCHEMA_FILENAME,
    CURRENT_FINDING_SCHEMA_FILENAME,
  ];
  try {
    for (const name of targets) {
      await rm(join(artifactsDir, "dispatch", name), { force: true });
    }
  } catch (err) {
    log?.event("dispatch_io_error", {
      run_id: "clear",
      function: "clearDispatchFiles",
      error: String(err),
    });
    throw err;
  }
}
