import {
  type WorkerTask,
  type AccessDeclaration,
  usesDeferredWorkerCommand,
} from "../types/workerSession.js";

function renderArgv(task: WorkerTask): string {
  return JSON.stringify(task.worker_command);
}

function renderAccessSection(access: AccessDeclaration): string[] {
  const lines = ["", "## File access"];
  if (access.read_paths.length > 0) {
    lines.push(`Read: ${access.read_paths.join(", ")}`);
  }
  if (access.write_paths.length > 0) {
    lines.push(`Write: ${access.write_paths.join(", ")}`);
  }
  if (access.forbidden_patterns && access.forbidden_patterns.length > 0) {
    lines.push(`Forbidden: ${access.forbidden_patterns.join(", ")}`);
  }
  lines.push("Do not read or write files outside these paths.");
  return lines;
}

export function renderWorkerPrompt(task: WorkerTask): string {
  const commandArgv = renderArgv(task);
  if (task.preferred_executor === "agent" && task.audit_results_path) {
    const tasksPath =
      task.pending_audit_tasks_path ??
      `${task.artifacts_dir}/audit_tasks.json`;
    const lines = [
      `Audit run: ${task.run_id}`,
      `Read: ${tasksPath}`,
      "Scope: review only the tasks listed in the Read file. Do not add tasks,",
      "edit source files, remediate findings, run unrelated audits, or write result_path.",
      "Use host Read and Grep tools for source inspection. Do not use shell search commands.",
      "For each listed task: read the assigned file_paths under the specified lens,",
      "using targeted reads/searches where they give complete enough evidence without loading unrelated context,",
      "and emit exactly one AuditResult object with:",
      "  task_id, unit_id, pass_id, lens (copy from task),",
      "  file_coverage: [{path, total_lines}] — use file_line_counts[path] from the task for each file,",
      "  findings: [] or array of finding objects.",
      "Each finding: id, title, category, severity, confidence, lens, summary,",
      "  affected_files [{path, line_start, line_end, symbol}] (objects, not strings; min 1 entry),",
      "  evidence [strings] (min 1 entry).",
      "For tasks tagged lens_verification: do not write direct findings; use findings: []",
      "  and include verification {verified, needs_followup, concerns, coverage_concerns,",
      "  confidence_concerns, followup_tasks}.",
      "Constraint: line_end must not exceed total_lines for that file.",
      `Write only the JSON array of AuditResult objects to: ${task.audit_results_path}`,
    ];

    if (usesDeferredWorkerCommand(task)) {
      lines.push("Deferred mode: write results, do not execute worker_command.");
    } else {
      lines.push(
        "After writing audit_results_path, execute worker_command from task.json exactly.",
        "The worker command ingests audit_results_path and writes result_path.",
        `Command: ${commandArgv}`,
      );
    }

    if (task.access) {
      lines.push(...renderAccessSection(task.access));
    }

    return lines.join("\n");
  }

  return [
    `Task: ${task.run_id}`,
    `Executor: ${task.preferred_executor}`,
    "Execute worker_command from task.json exactly.",
    `Command: ${commandArgv}`,
    "Write result to: " + task.result_path,
    "Stop after completion.",
  ].join("\n");
}
