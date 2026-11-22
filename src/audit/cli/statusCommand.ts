// sites-pinned: tests/audit/status-command.test.ts
import { join } from "node:path";
import { isFileMissingError, readJsonFile } from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { AuditState, ObligationState } from "../types/auditState.js";
import { getArtifactsDir } from "./args.js";
import { outputJson } from "./cliHelpers.js";
import { ARTIFACT_DEFINITIONS } from "../io/artifacts.js";
import { ReviewPlanSchema } from "../../shared/types/reviewQuestion.js";
import { readQuestionReviewRunId } from "./questionReviewSession.js";
import { loadCurrentActiveReviewRun } from "./reviewRun.js";

export async function cmdStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const auditStatePath = join(artifactsDir, ARTIFACT_DEFINITIONS.audit_state.fileName);

  // 1. Read audit_state.json
  let auditState: AuditState | null = null;
  try {
    auditState = await readJsonFile<AuditState>(auditStatePath);
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  if (!auditState) {
    outputJson({ status: 'no_active_audit', error: 'No audit_state.json found; no active audit in this artifacts directory.' });
    process.exitCode = 1;
    return;
  }

  // Build obligations summary: count by state
  const obligationStates: Record<ObligationState, number> = {
    missing: 0,
    present: 0,
    stale: 0,
    blocked: 0,
    satisfied: 0,
    not_applicable: 0,
  };
  for (const obligation of auditState.obligations ?? []) {
    const state = obligation.state;
    if (state in obligationStates) {
      obligationStates[state]!++;
    }
  }

  // Read only the prepared plan; planned questions are not outstanding answers.
  let questionReview: { run_id: string | null; snapshot_id: string; planned_questions: number } | null = null;
  let questionReviewUnreadable = false;
  try {
    const plan = ReviewPlanSchema.parse(await readJsonFile<unknown>(
      join(artifactsDir, ARTIFACT_DEFINITIONS.review_plan.fileName),
    ));
    questionReview = {
      run_id: await readQuestionReviewRunId(artifactsDir) ?? null,
      snapshot_id: plan.snapshot_id,
      planned_questions: plan.questions.length,
    };
  } catch (error) {
    questionReviewUnreadable = !isFileMissingError(error);
  }

  // Legacy task counts describe an archive, not current dispatch.
  let pendingTasksSummary: {
    run_id: string;
    total: number;
    remaining: number;
  } | null = null;

  try {
    const activeRun = await loadCurrentActiveReviewRun(artifactsDir);
    if (activeRun) {
      const tasks = await readJsonFile<AuditTask[]>(
        activeRun.pending_audit_tasks_path,
      );
      if (Array.isArray(tasks)) {
        // Count remaining: tasks without status "complete"
        const total = tasks.length;
        const remaining = tasks.filter(
          (t) => t.status !== "complete",
        ).length;

        pendingTasksSummary = {
          run_id: activeRun.run_id,
          total,
          remaining,
        };
      }
    }
  } catch {
    // Malformed / unreadable active-run manifest: report "no run", never throw.
  }

  outputJson({
    artifacts_dir: artifactsDir,
    status: auditState.status,
    last_obligation: auditState.last_obligation ?? null,
    last_executor: auditState.last_executor ?? null,
    blockers: auditState.blockers ?? [],
    obligations_summary: obligationStates,
    archived_pending_tasks: pendingTasksSummary,
    question_review: questionReview,
    question_review_unreadable: questionReviewUnreadable,
  });
}
