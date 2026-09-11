import { resolve } from "node:path";

import {
  deriveLaneDemand,
  isMissingObservation,
  linkFrictionRunIds,
  readJsonFile,
} from "audit-tools/shared";

import { AUDIT_FRICTION_RUN_ID } from "../orchestrator/nextStep.js";

import type { ArtifactBundle } from "../io/artifacts.js";
import { derivePendingTaskPartition } from "../orchestrator/pendingTasks.js";
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

/**
 * The audit draw's lane demand.
 *
 * The bounding rules are the SHARED ones ({@link deriveLaneDemand}); the draw
 * supplies only the genuinely per-mode input — its frozen, content-derived
 * `risk_estimate`. The banding helpers that used to live here read the task's
 * `priority` enum as if it were a risk score, which is what put a coarsely
 * bucketed dispatch PRIORITY where a likelihood×stakes estimate belongs.
 */
function toHostTask(task: AuditTask): AuditHostTask {
  const tokenEstimate = Math.max(0, Math.floor(task.token_estimate ?? 0));
  const demand = deriveLaneDemand({
    tokenEstimate,
    fileCount: task.file_paths.length,
    riskScore: task.risk_estimate ?? 0,
  });
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_paths: task.file_paths,
    file_line_counts: task.file_line_counts ?? {},
    rationale: task.rationale,
    priority: task.priority ?? "low",
    demand,
    token_estimate: tokenEstimate,
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
  // MISSING and REJECTED are stated under their OWN headings. They shared one
  // before, which forced a host parser to special-case the message text — the
  // measured friction — and told the reader the same thing about two situations
  // whose remedies are opposite: one is patience, the other is a repair. The
  // split is on the CODE, so rewording a message cannot move an item between
  // the two.
  const missing = issues.filter(isMissingObservation);
  const rejected = issues.filter((issue) => !isMissingObservation(issue));
  const section = (heading: string, lines: readonly string[]): string[] =>
    lines.length === 0 ? [] : [heading, "", ...lines, ""];
  return [
    ...section(
      "## Results not yet written",
      missing.map((issue) => `- ${describeIssue(issue)}`),
    ),
    ...section(
      "## Result status requiring attention",
      rejected.map((issue) => `- ${describeIssue(issue)}`),
    ),
    ...(issues.length === 0
      ? []
      : [
          // NOT "the bindings are unchanged": the run id is derived from the review
          // obligation, so a partial ingest does NOT re-mint the run and the bound
          // paths of carried-over items are stable. What still moves is the ASK — a
          // re-planned task's prompt digest, and therefore its bound path, is
          // different, and a result written against the old ask is correctly refused.
          // So the workload published below is the authority for what to write, and a
          // path quoted above is only guaranteed current for an item whose ask the
          // ingest did not change.
          "Each named work item is still pending and is republished in the workload below. Write its repaired result at that workload's bound `result_path` — that workload is always the authority for where a result is read.",
          "",
        ]),
  ];
}

/** One issue as a bullet, with its locators. Shared by both sections above. */
function describeIssue(issue: AuditHostIngestIssue): string {
  return (
    `${issue.work_item_id ? `\`${issue.work_item_id}\` (${issue.code}): ` : `${issue.code}: `}` +
    `${issue.message}${issue.result_path ? ` (\`${issue.result_path}\`)` : ""}`
  );
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
  /**
   * The bundle this draw's review obligation was selected against. REQUIRED:
   * the completed count has no second derivation — it comes from the ONE
   * pending-set partition (`derivePendingTaskPartition`), which is the same
   * source the published workload's task list is built from. A caller that has
   * no bundle has no review obligation either.
   */
  bundle: ArtifactBundle;
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
  // The completed half of this pause's count comes from the ONE pending-set
  // partition — the same derivation `buildPendingAuditTasks` projects the
  // published tasks from — never from `tasks.length - work_items.length`. That
  // subtraction only ever measured how many items the handoff boundary HID, so
  // it read zero for every run whose publish was exhaustive (which is every
  // run: the boundary suppresses nothing), and it would misreport the moment a
  // task left the pending set for any reason other than acceptance.
  const { completedTaskIds } = derivePendingTaskPartition(params.bundle);
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
    progress: {
      summary:
        `Published ${handoff.workload.work_items.length} pending semantic-review ` +
        `work item(s) for host execution.` +
        (issues.length > 0
          ? ` ${issues.length} prior submission(s) were not accepted — see "Result status requiring attention"` +
            ` and "Results not yet written".`
          : ""),
      pending_tasks: handoff.workload.work_items.length,
      completed_tasks: completedTaskIds.size,
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
