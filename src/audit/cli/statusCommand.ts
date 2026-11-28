// sites-pinned: tests/audit/status-command.test.ts
import { join, resolve } from "node:path";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { assertNoPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { assertSubmissionRunId, isFileMissingError, readJsonFile } from "audit-tools/shared";
import { AuditTaskSchema } from "../types.js";
import type { AuditState, ObligationState } from "../types/auditState.js";
import { getArtifactsDir } from "./args.js";
import { outputJson } from "./cliHelpers.js";
import { deriveQuestionCycleUnlocked } from "./questionReviewCycle.js";
import { readRunSourceRoot } from "../io/runSnapshot.js";
import { FILE_INSPECTION_PREFIX } from "../orchestrator/fullFileReview.js";
import { ARTIFACT_DEFINITIONS, loadArtifactBundle } from "../io/artifacts.js";
import { ReviewPlanSchema, type ReviewPlan } from "../../shared/types/reviewQuestion.js";
import { readQuestionReviewRunId } from "./questionReviewSession.js";
import { loadCurrentActiveReviewRun } from "./reviewRun.js";
import { StepArtifactSchema } from "./steps.js";
import { inspectAuditQuestionHandoff, readAuditQuestionWorkload } from "./dispatch/hostHandoff.js";
import { readExistingRunConsentUnlocked } from "../../shared/analyzerRunConsent.js";
import { functionalPreflightPath } from "./functionalPreflight.js";
import { getRunPaths } from "../io/runArtifacts.js";

export async function cmdStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  await withArtifactTreeHold(artifactsDir, undefined, () => reportHeldStatus(artifactsDir));
}

async function questionHandoff(artifactsDir: string, plan: ReviewPlan, runId: string) {
  try {
    const step = StepArtifactSchema.parse(await readJsonFile<unknown>(
      join(artifactsDir, "steps", "current-step.json"),
    ));
    const boundPath = step.artifact_paths.host_workload;
    const alongsideChallenge = step.step_kind === "systemic_challenge";
    if ((!alongsideChallenge && step.step_kind !== "dispatch_review") || step.run_id !== runId ||
        step.status !== "ready" || !boundPath ||
        resolve(step.artifacts_dir) !== resolve(artifactsDir)) return { state: "stale" };
    const boundary = { root: step.repo_root, artifactsDir, runId };
    const issued = await inspectAuditQuestionHandoff(boundary);
    let effectivePlan = plan;
    if (issued.questions.some(question => question.question_id.startsWith(FILE_INSPECTION_PREFIX))) {
      const bundle = await loadArtifactBundle(artifactsDir, {});
      const workload = await readAuditQuestionWorkload(boundary);
      const sourceRoot = await readRunSourceRoot(step.repo_root, artifactsDir);
      const cycle = await deriveQuestionCycleUnlocked({ ...boundary, bundle, sourceRoot,
        readOnlyRunId: runId, verifiedSourceFiles: workload.source_files });
      effectivePlan = cycle.effectivePlan;
    }
    const revisions = new Map(effectivePlan.questions.map(question => [question.question_id, question.revision_id]));
    if (resolve(issued.path) !== resolve(boundPath) || issued.stale || issued.questions.some(question =>
      question.snapshot_id !== plan.snapshot_id || revisions.get(question.question_id) !== question.revision_id
    ) || step.progress?.pending_tasks !== issued.questions.length) return { state: "stale" };

    const rejectedAtPublication = step.progress.rejected_tasks;
    // Acceptance can advance after publication. The old count and summary
    // cannot tell us which of the currently pending answers need correction.
    return {
      state: "current", action: issued.pending === 0 ? "continue" : "await_results",
      workload_path: boundPath, pending_answers: issued.pending,
      ...(rejectedAtPublication === undefined ? {} : { previous_publication_rejections: rejectedAtPublication }),
      summary: issued.pending === 0
        ? alongsideChallenge
          ? "Issued answers are accepted. The published systemic challenge is a separate lane."
          : "Issued answers are accepted. Run next-step to continue."
        : "Waiting for " + issued.pending + (issued.pending === 1 ? " question answer." : " question answers."),
    };
  } catch {
    return { state: "unavailable" };
  }
}

async function publishedPreflight(artifactsDir: string) {
  try {
    const step = StepArtifactSchema.parse(await readJsonFile<unknown>(
      join(artifactsDir, "steps", "current-step.json"),
    ));
    if (step.step_kind !== "functional_preflight" || !step.run_id ||
        (step.status !== "ready" && step.status !== "blocked") ||
        resolve(step.artifacts_dir) !== resolve(artifactsDir) ||
        !step.artifact_paths.functional_preflight ||
        resolve(step.artifact_paths.functional_preflight) !== resolve(functionalPreflightPath(artifactsDir))) return null;
    const consent = await readExistingRunConsentUnlocked(step.repo_root, artifactsDir);
    if (consent?.run_id !== step.run_id) return null;
    return { run_id: step.run_id, status: step.status, summary: step.progress?.summary ?? null };
  } catch {
    // A missing, invalid, or stale publication cannot prove an active preflight.
    return null;
  }
}

async function reportHeldStatus(artifactsDir: string): Promise<void> {
  await assertNoPendingFoldReceipt(artifactsDir);
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
    const preflight = await publishedPreflight(artifactsDir);
    if (preflight) {
      outputJson({ artifacts_dir: artifactsDir, status: "preflight", functional_preflight: preflight });
      return;
    }
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

  // Planned questions are not outstanding answers. Only the published handoff
  // and accepted ledger can report answer status.
  let handoff: Awaited<ReturnType<typeof questionHandoff>> | null = null;
  let questionReview: { run_id: string | null; snapshot_id: string; planned_questions: number } | null = null;
  let questionReviewUnreadable = false;
  try {
    const plan = ReviewPlanSchema.parse(await readJsonFile<unknown>(
      join(artifactsDir, ARTIFACT_DEFINITIONS.review_plan.fileName),
    ));
    const runId = await readQuestionReviewRunId(artifactsDir);
    if (runId && auditState.status !== "complete") handoff = await questionHandoff(artifactsDir, plan, runId);
    questionReview = {
      run_id: runId ?? null,
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

  let archivedTasksState: "available" | "absent" | "unavailable" = "absent";
  try {
    const activeRun = await loadCurrentActiveReviewRun(artifactsDir);
    if (activeRun) {
      assertSubmissionRunId(activeRun.run_id);
      const path = getRunPaths(artifactsDir, activeRun.run_id).pendingTasksPath;
      if (resolve(activeRun.pending_audit_tasks_path) !== resolve(path)) {
        throw new Error("Archived task manifest differs from its run path.");
      }
      const tasks = AuditTaskSchema.array().parse(await readJsonFile<unknown>(path));
      pendingTasksSummary = {
        run_id: activeRun.run_id,
        total: tasks.length,
        remaining: tasks.filter(task => task.status !== "complete").length,
      };
      archivedTasksState = "available";
    }
  } catch {
    archivedTasksState = "unavailable";
  }

  outputJson({
    artifacts_dir: artifactsDir,
    status: auditState.status,
    last_obligation: auditState.last_obligation ?? null,
    last_executor: auditState.last_executor ?? null,
    blockers: auditState.blockers ?? [],
    obligations_summary: obligationStates,
    archived_pending_tasks: pendingTasksSummary,
    archived_pending_tasks_state: archivedTasksState,
    question_review_handoff: handoff,
    question_review: questionReview,
    question_review_unreadable: questionReviewUnreadable,
  });
}
