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
      `Repository root: ${task.repo_root}`,
      "Set the shell/tool workdir to the repository root before executing worker_command.",
      `Read: ${tasksPath}`,
      "Scope: review only the tasks listed in the Read file. Do not add tasks,",
      "edit source files, remediate findings, run unrelated audits, or write result_path.",
      "Use host Read and Grep tools for source inspection. Do not use shell search commands.",
      "For each listed task: read the assigned file_paths under the specified lens,",
      "using targeted reads/searches where they give complete enough evidence without loading unrelated context,",
      "and emit exactly one AuditResult object with:",
      "  task_id, unit_id, pass_id, lens (copy from task),",
      "  file_coverage: [{path, total_lines}] — coverage stat; use file_line_counts[path] from the task",
      "    (advisory: a count mismatch is a warning, not an error — findings are grounded by quoted_text below),",
      "  findings: [] or array of finding objects.",
      "Each finding: id, title, category, severity, confidence, lens, summary,",
      "  affected_files [{path, line_start, line_end, symbol, quoted_text}] (objects, not strings; min 1 entry),",
      "  evidence [strings] (min 1 entry).",
      "Grounding (required): at least one affected_files entry must include quoted_text — a short",
      "  verbatim span copied EXACTLY from that file at the cited lines. The tool re-reads it and",
      "  content-matches against disk; a finding whose quoted_text is not found on disk (or is omitted)",
      "  is marked ungrounded and surfaced for review. Quote real code that exists; never paraphrase.",
      "  Matching is on content (whitespace-normalized), so exact line numbers may safely drift.",
      "Behavior claims (a cycle, an unused symbol, 'throws', a failing check) may also add an",
      "  executable_anchor {command:[argv], confirm_if:{kind: exit_zero|exit_nonzero|output_includes|output_excludes, text?}}.",
      "  The tool RUNS the read-only command from the repo root and confirms or REFUTES the claim — a refuting run",
      "  quarantines the finding. Inspection tools only (grep/rg/findstr/madge/ast-grep, or read-only git grep/log/diff/show);",
      "  off-allowlist commands (node/npm/…) are skipped, not run. e.g. {command:['madge','--circular','src'],",
      "  confirm_if:{kind:'output_includes', text:'src/a.ts'}} to prove a cycle, or grep to prove a symbol's (non-)existence.",
      "For tasks tagged lens_verification: do not write direct findings; use findings: []",
      "  and include verification {verified, needs_followup, concerns, coverage_concerns,",
      "  confidence_concerns, followup_tasks}.",
      "Constraint: line_end must not exceed total_lines for that file.",
      "Windows PowerShell: do not pipe an inline foreach statement directly into ConvertTo-Json.",
      "Assign the foreach output to a variable first, then pipe that variable to ConvertTo-Json.",
      "PowerShell also unwraps single-element arrays: @(@{...}) collapses to one object, so a one-result",
      "submission serializes as an object (not a 1-element array) and is rejected. Wrap it yourself:",
      "'[' + (ConvertTo-Json $obj -Depth 12) + ']', or build the array with Write-Output -NoEnumerate.",
      `Write only the JSON array of AuditResult objects to: ${task.audit_results_path}`,
    ];

    lines.push(
      "Optional — never let this delay or replace the audit result: if you hit task",
      "ambiguity, tool friction, or unclear instructions, you MAY append one JSON",
      `reflection line to ${task.artifacts_dir}/agent-feedback.jsonl with shape:`,
      "  {task_id, lens, instruction_clarity (clear|mostly_clear|ambiguous|unclear),",
      "   ambiguities: [string], tool_friction: [string], suggestions: [string],",
      "   severity (info|low|medium|high)}. One object per line; never overwrite existing lines.",
    );

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
    `Repository root: ${task.repo_root}`,
    "Set the shell/tool workdir to the repository root before executing worker_command.",
    "Execute worker_command from task.json exactly.",
    `Command: ${commandArgv}`,
    "Write result to: " + task.result_path,
    "Stop after completion.",
  ].join("\n");
}
