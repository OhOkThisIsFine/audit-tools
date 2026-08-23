import { resolve } from "node:path";

import { linkFrictionRunIds, readJsonFile } from "audit-tools/shared";

import { AUDIT_FRICTION_RUN_ID } from "../orchestrator/nextStep.js";

import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import type { AuditTask } from "../types.js";
import type { AuditHostIngestIssue } from "../validation/ingestIssueCodes.js";
import {
  prepareAuditHostHandoff,
  type AuditHostTask,
  type AuditHostValidationWarning,
} from "./dispatch/hostHandoff.js";
import { nextStepCommand } from "./prompts.js";
import { writeCurrentStep } from "./steps.js";

function taskComplexity(task: AuditTask): string {
  const estimate = task.token_estimate ?? 0;
  if (estimate >= 8_000) return "deep";
  if (estimate >= 2_000) return "standard";
  return "focused";
}

function toHostTask(task: AuditTask): AuditHostTask {
  const risk = task.priority ?? "low";
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_paths: task.file_paths,
    file_line_counts: task.file_line_counts ?? {},
    rationale: task.rationale,
    priority: risk,
    complexity: taskComplexity(task),
    risk,
    token_estimate: Math.max(0, Math.floor(task.token_estimate ?? 0)),
  };
}

/**
 * The classified failures of the ingest that just ran, stated to the host that
 * has to repair them. Same section the remediate draw already renders from the
 * same shared vocabulary — a work item whose result never arrived, would not
 * parse, or failed the contract is NAMED here instead of silently reappearing
 * in an identical workload.
 */
function renderIngestIssueLines(
  issues: readonly AuditHostIngestIssue[],
): string[] {
  if (issues.length === 0) return [];
  return [
    "## Result status requiring attention",
    "",
    ...issues.map(
      (issue) =>
        `- ${issue.work_item_id ? `\`${issue.work_item_id}\` (${issue.code}): ` : `${issue.code}: `}` +
        `${issue.message}${issue.result_path ? ` (\`${issue.result_path}\`)` : ""}`,
    ),
    "",
    // NOT "the bindings are unchanged": ingesting anything changes the pending
    // task set, and a changed pending set re-mints the review run — new run id,
    // new run directory, new bound result paths. The paths quoted above are the
    // ones the ingest READ; the workload published below is always the authority.
    "Each named work item is still pending and is republished in the workload below. Write its repaired result at that workload's bound `result_path` — a path quoted above belongs to the ingest just consumed and is stale whenever the run was re-minted.",
    "",
  ];
}

/**
 * The ADVISORY half of the ingest report: validation warnings on results that
 * WERE accepted. Deliberately a separate renderer from {@link renderIngestIssueLines}
 * — these need no repair, so they must not share a section (or a count) with
 * items that could not be accepted, or an accepted-with-warning result reads as
 * a refusal that never happened.
 */
function renderValidationWarningLines(
  warnings: readonly AuditHostValidationWarning[],
): string[] {
  if (warnings.length === 0) return [];
  return [
    "## Advisory notes on accepted results",
    "",
    ...warnings.map(
      (warning) =>
        `- \`${warning.work_item_id}\` was ACCEPTED; advisory: ${warning.message}`,
    ),
    "",
  ];
}

/**
 * Publish the complete provider-neutral semantic-review workload. The host owns
 * every execution choice; audit-tools only binds prompts/results and ingests
 * validated AuditResult objects on the next invocation.
 */
export async function renderSemanticReviewStep(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  selectedExecutor?: string | null;
  inProcessMadeProgress?: boolean;
  /** Failures the ingest that preceded this emission classified. */
  ingestIssues?: readonly AuditHostIngestIssue[];
  /** Advisory validation findings on results the SAME ingest accepted. */
  validationWarnings?: readonly AuditHostValidationWarning[];
}): Promise<Awaited<ReturnType<typeof writeCurrentStep>>> {
  const { root, artifactsDir, activeReviewRun } = params;
  if (!activeReviewRun.pending_audit_tasks_path) {
    throw new Error(
      `Semantic review run ${activeReviewRun.run_id} has no pending-task manifest.`,
    );
  }

  const tasks = await readJsonFile<AuditTask[]>(
    activeReviewRun.pending_audit_tasks_path,
  );
  const handoff = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: activeReviewRun.run_id,
    tasks: tasks.map(toHostTask),
  });
  // Name this round's runs on the audit friction record, which is keyed by a fixed
  // literal and so on its own names no run at all (semantics: `FrictionRunLinks`). Each
  // reference is sourced from the envelope that owns it, never synthesized.
  await linkFrictionRunIds(
    artifactsDir,
    AUDIT_FRICTION_RUN_ID,
    {
      step_run_id: activeReviewRun.run_id,
      dispatch_run_id: handoff.workload.run_id,
    },
    "audit-code",
  );
  const continueCommand = nextStepCommand(root, artifactsDir);
  const resultPaths = handoff.workload.work_items.map((item) =>
    resolve(root, item.result_path),
  );
  const issues = params.ingestIssues ?? [];
  const validationWarnings = params.validationWarnings ?? [];

  return writeCurrentStep({
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: activeReviewRun.run_id,
    allowedCommands: [continueCommand],
    allowedMcpTools: ["auditor_continue_audit"],
    progress: {
      summary:
        `Published ${handoff.workload.work_items.length} pending semantic-review ` +
        `work item(s) for host execution.` +
        (issues.length > 0
          ? ` ${issues.length} prior submission(s) could not be accepted — see "Result status requiring attention".`
          : ""),
      pending_tasks: handoff.workload.work_items.length,
      completed_tasks: tasks.length - handoff.workload.work_items.length,
    },
    stopCondition:
      "Execute the published host workload, write each bound result, then run next-step.",
    repoRoot: root,
    artifactPaths: {
      host_workload: handoff.workload_path,
      host_result_map: handoff.result_map_path,
      active_review_run: activeReviewRun.review_run_path,
      pending_audit_tasks: activeReviewRun.pending_audit_tasks_path,
    },
    prompt: [
      "# audit-code semantic review",
      "",
      ...renderIngestIssueLines(issues),
      ...renderValidationWarningLines(validationWarnings),
      `Read the complete provider-neutral workload at: ${handoff.workload_path}`,
      "",
      "Execute every work item using the host facilities available in this conversation.",
      "For each item, follow its prompt and write the exact result contract to its bound result_path.",
      "Missing or invalid results remain pending; do not edit audit state or hand-merge results.",
      "",
      `When the available results are written, run: ${continueCommand}`,
      "",
    ].join("\n"),
    access: {
      read_paths: [
        handoff.workload_path,
        handoff.result_map_path,
        activeReviewRun.pending_audit_tasks_path,
      ],
      write_paths: resultPaths,
    },
  });
}
