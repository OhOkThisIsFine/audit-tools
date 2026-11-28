// sites-pinned: tests/audit/status-command.test.ts
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { assertNoPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { assertSubmissionRunId, hashContent, isFileMissingError, isJsonParseError, readJsonFile, toPromptPathToken } from "audit-tools/shared";
import { AuditTaskSchema } from "../types.js";
import { AuditStatusProjectionSchema, type ObligationState } from "../types/auditState.js";
import { getArtifactsDir } from "./args.js";
import { outputJson } from "./cliHelpers.js";
import { deriveQuestionCycleUnlocked } from "./questionReviewCycle.js";
import { readRunSourceRoot } from "../io/runSnapshot.js";
import { FILE_INSPECTION_PREFIX } from "../orchestrator/fullFileReview.js";
import { ARTIFACT_DEFINITIONS, loadArtifactBundle } from "../io/artifacts.js";
import { ReviewPlanSchema, type ReviewPlan } from "../../shared/types/reviewQuestion.js";
import { readQuestionReviewRunId } from "./questionReviewSession.js";
import { loadCurrentActiveReviewRun } from "./reviewRun.js";
import { StepArtifactSchema, type StepArtifact } from "./steps.js";
import { inspectAuditQuestionHandoff, readAuditQuestionWorkload } from "./dispatch/hostHandoff.js";
import { readExistingRunConsentUnlocked } from "../../shared/analyzerRunConsent.js";
import { functionalPreflightPath, readFunctionalPreflight } from "./functionalPreflight.js";
import { getRunPaths } from "../io/runArtifacts.js";
import { readAuditReviewBinding } from "./auditReviewBindings.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, laneSubmissionId, laneSubmissionPath, systemicChallengeLane } from "./laneSubmissions.js";
import { systemicChallengeSchemaForBundle, systemicPremiseToken, systemicReviewInputRevision } from "../orchestrator/systemicChallengeExecutor.js";
import { systemicChallengeEnded } from "../types/systemicChallenge.js";
import { inspectPublishedConceptualProgress } from "./conceptualDispatch.js";
import { parseReviewSubmissionEnvelope } from "../../shared/types/reviewIndependence.js";

export async function cmdStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  await withArtifactTreeHold(artifactsDir, undefined, () => reportHeldStatus(artifactsDir));
}

type LoadBundle = () => ReturnType<typeof loadArtifactBundle>;

async function readCurrentStep(path: string) {
  try {
    const step = StepArtifactSchema.parse(await readJsonFile<unknown>(path));
    return { state: "verified", step } as const;
  } catch (error) {
    return { state: isFileMissingError(error) ? "absent" : "unavailable" } as const;
  }
}

async function questionHandoff(artifactsDir: string, plan: ReviewPlan, runId: string, step: StepArtifact, loadBundle: LoadBundle) {
  try {
    const boundPath = step.artifact_paths.host_workload;
    const alongsideChallenge = step.step_kind === "systemic_challenge";
    if ((!alongsideChallenge && step.step_kind !== "dispatch_review") || step.run_id !== runId ||
        step.status !== "ready" || !boundPath ||
        resolve(step.artifacts_dir) !== resolve(artifactsDir)) return { state: "stale" };
    const boundary = { root: step.repo_root, artifactsDir, runId };
    const issued = await inspectAuditQuestionHandoff(boundary);
    let effectivePlan = plan;
    if (issued.questions.some(question => question.question_id.startsWith(FILE_INSPECTION_PREFIX))) {
      const bundle = await loadBundle();
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

// Inspect the same persisted round, prompt and answer that next-step would
// consume, without decoding through its ledger-writing submission path.
async function systemicContinuation(artifactsDir: string, step: StepArtifact, ordinaryRunId: string | null, loadBundle: LoadBundle) {
  if (step.step_kind !== "systemic_challenge" || step.status !== "ready" ||
      resolve(step.artifacts_dir) !== resolve(artifactsDir)) return null;
  // Only a combined publication is tied to the ordinary question session.
  if (step.run_id !== null && step.run_id !== ordinaryRunId) return null;
  try {
    const bundle = await loadBundle();
    const register = bundle.systemic_challenge;
    if (!register || systemicChallengeEnded(register) ||
        register.round_token !== systemicPremiseToken(bundle)) return { state: "stale" };
    const lane = systemicChallengeLane(register.rounds);
    const path = laneSubmissionPath(artifactsDir, lane);
    const resultPath = step.artifact_paths.systemic_challenge_results;
    const promptPath = step.artifact_paths.systemic_challenge_prompt;
    if (!resultPath || resolve(resultPath) !== resolve(path) || !promptPath) return { state: "stale" };
    const binding = await readAuditReviewBinding(artifactsDir, lane);
    if (binding?.requirement !== "independent" || binding.runId !== AUDIT_GATE_SUBMISSION_SCOPE ||
        binding.submissionId !== laneSubmissionId(lane, binding.runId) ||
        resolve(binding.promptPath) !== resolve(promptPath) ||
        binding.semanticInputRevision !== systemicReviewInputRevision(bundle)) return { state: "stale" };

    let bytes: Buffer;
    try { bytes = await readFile(path); } catch (error) {
      if (!isFileMissingError(error)) throw error;
      return {
        state: "await_result",
        summary: "The systemic challenge can continue once its own result is saved. It does not wait for ordinary answers.",
      };
    }
    const parsed = parseReviewSubmissionEnvelope(JSON.parse(bytes.toString("utf8")), {
      requirement: binding.requirement, promptSha256: binding.promptSha256,
    });
    if (!parsed.ok || !systemicChallengeSchemaForBundle(bundle).safeParse(parsed.result).success) {
      return { state: "unavailable" };
    }
    const roundHash = hashContent(lane + "\n" + hashContent(bytes));
    if (register.folded_submission_hashes?.includes(roundHash)) return { state: "stale" };
    return {
      state: "ready", action: "continue",
      summary: "Run next-step to continue the systemic challenge without waiting for ordinary answers.",
    };
  } catch {
    return { state: "unavailable" };
  }
}

async function publishedPreflight(artifactsDir: string, step: StepArtifact | undefined) {
  try {
    if (step?.step_kind !== "functional_preflight" || !step.run_id ||
        (step.status !== "ready" && step.status !== "blocked") ||
        resolve(step.artifacts_dir) !== resolve(artifactsDir) ||
        !step.artifact_paths.functional_preflight ||
        resolve(step.artifact_paths.functional_preflight) !== resolve(functionalPreflightPath(artifactsDir))) return null;
    const consent = await readExistingRunConsentUnlocked(step.repo_root, artifactsDir);
    if (consent?.run_id !== step.run_id) return null;
    const current = await readFunctionalPreflight(artifactsDir, consent.run_id, toPromptPathToken(consent.repository_root));
    if (current.state === "accepted") return {
      run_id: consent.run_id, status: current.report.decision,
      summary: current.report.decision === "ready"
        ? "Functional preflight is ready. Run next-step to continue."
        : "Operator approved a degraded audit. Run next-step to continue. Limitation: " + current.report.limitation,
    };
    return { run_id: consent.run_id, status: current.state === "stopped" ? "blocked" : "pending", summary: current.summary };
  } catch {
    // A missing, invalid, or stale publication cannot prove an active preflight.
    return null;
  }
}

function reportInvalidAuditState(artifactsDir: string): void {
  outputJson({
    artifacts_dir: artifactsDir,
    status: "invalid_audit_state",
    error: "audit_state.json is malformed or contains invalid status fields.",
  });
  process.exitCode = 1;
}

async function reportHeldStatus(artifactsDir: string): Promise<void> {
  await assertNoPendingFoldReceipt(artifactsDir);
  const auditStatePath = join(artifactsDir, ARTIFACT_DEFINITIONS.audit_state.fileName);

  let auditState: ReturnType<typeof AuditStatusProjectionSchema.parse> | undefined;
  try {
    const state = AuditStatusProjectionSchema.safeParse(await readJsonFile<unknown>(auditStatePath));
    if (!state.success) {
      reportInvalidAuditState(artifactsDir);
      return;
    }
    auditState = state.data;
  } catch (error) {
    if (isJsonParseError(error)) {
      reportInvalidAuditState(artifactsDir);
      return;
    }
    if (!isFileMissingError(error)) throw error;
  }

  const stepPath = join(artifactsDir, "steps", "current-step.json");
  const currentStep = await readCurrentStep(stepPath);
  const step = currentStep.state === "verified" ? currentStep.step : undefined;
  const unavailableStep = currentStep.state === "unavailable" ? {
    state: "unavailable",
    path: stepPath,
    summary: "Could not verify continuation from the current-step publication.",
  } : undefined;
  const preflight = await publishedPreflight(artifactsDir, step);
  if (!auditState) {
    if (preflight) {
      outputJson({ artifacts_dir: artifactsDir, status: "preflight", functional_preflight: preflight });
      return;
    }
    if (unavailableStep) {
      outputJson({ artifacts_dir: artifactsDir, status: "current_step_unavailable", current_step: unavailableStep });
      process.exitCode = 1;
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
    obligationStates[obligation.state]++;
  }

  // Planned questions are not outstanding answers. Only the published handoff
  // and accepted ledger can report answer status.
  let bundle: ReturnType<LoadBundle> | undefined;
  const loadBundle: LoadBundle = () => bundle ??= loadArtifactBundle(artifactsDir, {});
  let handoff: Awaited<ReturnType<typeof questionHandoff>> | null = null;
  let questionReview: { run_id: string | null; snapshot_id: string; planned_questions: number } | null = null;
  let questionReviewUnreadable = false;
  try {
    const plan = ReviewPlanSchema.parse(await readJsonFile<unknown>(
      join(artifactsDir, ARTIFACT_DEFINITIONS.review_plan.fileName),
    ));
    const runId = await readQuestionReviewRunId(artifactsDir);
    if (runId && auditState.status !== "complete") {
      if (step) {
        handoff = await questionHandoff(artifactsDir, plan, runId, step, loadBundle);
      } else {
        handoff = { state: "unavailable" };
      }
    }
    questionReview = {
      run_id: runId ?? null,
      snapshot_id: plan.snapshot_id,
      planned_questions: plan.questions.length,
    };
  } catch (error) {
    questionReviewUnreadable = !isFileMissingError(error);
  }
  const systemic = step && auditState.status !== "complete"
    ? await systemicContinuation(artifactsDir, step, questionReview?.run_id ?? null, loadBundle)
    : null;

  let conceptual: Awaited<ReturnType<typeof inspectPublishedConceptualProgress>> | undefined;
  if (step && (step.step_kind === "design_review_conceptual" || step.step_kind === "design_review_parallel")) {
    try {
      await access(join(artifactsDir, "run-ended.json"));
      conceptual = { state: "stale", summary: "The audit run has ended." };
    } catch (error) {
      if (!isFileMissingError(error)) {
        conceptual = { state: "unavailable", summary: "Could not inspect the audit run." };
      } else {
        conceptual = auditState.status === "complete"
          ? { state: "stale", summary: "The audit run has completed." }
          : await inspectPublishedConceptualProgress(artifactsDir, step, loadBundle);
      }
    }
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
    ...(unavailableStep ? { current_step: unavailableStep } : {}),
    ...(preflight ? { functional_preflight: preflight } : {}),
    last_obligation: auditState.last_obligation ?? null,
    last_executor: auditState.last_executor ?? null,
    blockers: auditState.blockers ?? [],
    obligations_summary: obligationStates,
    archived_pending_tasks: pendingTasksSummary,
    archived_pending_tasks_state: archivedTasksState,
    question_review_handoff: handoff,
    systemic_challenge_continuation: systemic,
    ...(conceptual ? { conceptual_review_progress: conceptual } : {}),
    question_review: questionReview,
    question_review_unreadable: questionReviewUnreadable,
  });
}
