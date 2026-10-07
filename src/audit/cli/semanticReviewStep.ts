// sites-pinned: tests/audit/host-handoff.test.ts
// (the steward-lane verification
// contract — `toAuditHostTask` is where the lane tags were being dropped, so this is
// the site whose revert makes the prompt branch unreachable)
import { resolve } from "node:path";

import {
  linkFrictionRunIds,
  readJsonFile,
} from "audit-tools/shared";

import { AUDIT_FRICTION_RUN_ID } from "../orchestrator/nextStep.js";

import type { ArtifactBundle } from "../io/artifacts.js";
import { derivePendingTaskPartition } from "../orchestrator/pendingTasks.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import type { AuditTask } from "../types.js";
import {
  auditIngestRemedy,
  type AuditHostIngestIssue,
} from "../validation/ingestIssueCodes.js";
import { renderIngestReportLines } from "audit-tools/shared";
import {
  prepareAuditHostHandoff,
  toAuditHostTask,
  type AuditHostValidationWarning,
} from "./dispatch/hostHandoff.js";
import { nextStepCommand } from "./prompts.js";
import { writeCurrentStep } from "./steps.js";


/**
 * Publish the complete semantic-review workload. The host owns every execution
 * choice; audit-tools only binds prompts/results and ingests validated
 * AuditResult objects on the next invocation.
 */
interface SemanticReviewStepParams {
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
}

/** Prepare bound work without taking over the host's current architecture step. */
export async function prepareSemanticReviewWorkload(params: SemanticReviewStepParams) {
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
  const { completedTaskIds, pendingTasks } = derivePendingTaskPartition(params.bundle);
  const handoff = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: activeReviewRun.run_id,
    tasks: tasks.map((task) => toAuditHostTask(task, params.bundle.repo_manifest)),
    pendingTaskCount: pendingTasks.length,
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
  return { handoff, completedTaskIds, resultPaths, continueCommand };
}

export async function renderSemanticReviewStep(params: SemanticReviewStepParams): Promise<Awaited<ReturnType<typeof writeCurrentStep>>> {
  const { root, artifactsDir, activeReviewRun } = params;
  const { handoff, completedTaskIds, resultPaths, continueCommand } = await prepareSemanticReviewWorkload(params);
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
        // The summary states the COUNT and points at the report; it does not
        // quote a heading. Which headings render depends on the remedy of each
        // issue, so a quoted heading can name a section that is not there.
        (issues.length > 0
          ? ` ${issues.length} prior submission issue(s) are stated in the step prompt.`
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
      ...renderIngestReportLines({
        issues,
        remedy: auditIngestRemedy,
        workload: "follows",
        advisories: validationWarnings,
      }),
      `Read the workload at: ${handoff.workload_path}`,
      "",
      // Two imperative steps, not one directive plus a plea. The removed plea
      // ("do not edit audit state or hand-merge results") asked the reader to
      // remember a rule `ingestAuditHostResults` already enforces: a result is
      // bound to its run id, work item id and prompt digest, so a hand-merged
      // or moved result is refused mechanically.
      "For each work item in the workload:",
      "1. Follow its prompt.",
      "2. Write the result JSON at its bound `result_path`.",
      "",
      `When the results are written, run: ${continueCommand}`,
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
