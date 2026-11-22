// sites-pinned: tests/audit/next-step-question-workload.test.ts
import { isFileMissingError } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { collectQuestionEvidence } from "../orchestrator/questionEvidence.js";
import { reviewSourceScope } from "../orchestrator/questionPlanning.js";
import { ingestAuditQuestionResults, readAuditQuestionLedger } from "./dispatch/hostHandoff.js";
import { projectQuestionReview, type AuditQuestionBinding } from "./dispatch/questionReviewAcceptance.js";
import { ensureQuestionReviewRunIdUnlocked } from "./questionReviewSession.js";
import { questionWorkloadBindings } from "./questionWorkloadBindings.js";

interface QuestionCycleOptions {
  root: string;
  sourceRoot: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  readOnlyRunId?: string;
}

/** The same source/evidence binding for dispatch, report and direct submit. */
export async function deriveCurrentQuestionBindings(
  bundle: ArtifactBundle,
  sourceRoot: string,
  verifiedSourceFiles?: AuditQuestionBinding["sourceFiles"],
) {
  const plan = bundle.review_plan;
  if (!plan) throw new Error("Question review requires the active plan");
  const scope = reviewSourceScope(bundle, bundle.scope);
  const sourceFiles = new Map([...scope.allowedSourcePaths, ...scope.allowedContractPaths].flatMap(path => {
    const fingerprint = scope.files.get(path)?.hash;
    return fingerprint ? [[path, fingerprint] as const] : [];
  }));
  const evidence = await collectQuestionEvidence({
    snapshot_id: plan.snapshot_id, sourceRoot, sourceFiles, analyzerResults: bundle.external_analyzer_results ?? [],
  });
  const bindings = await questionWorkloadBindings(bundle, sourceRoot, evidence, verifiedSourceFiles);
  return { bindings, evidence, sourceFiles };
}

/** One projection for host dispatch and report synthesis. The existing host
 * run ledger is the only accepted-answer store. Call inside the artifact hold. */
export async function deriveQuestionCycleUnlocked(options: QuestionCycleOptions) {
  const { bundle, root, sourceRoot, artifactsDir } = options;
  const plan = bundle.review_plan;
  if (!plan) throw new Error("Question review requires the active plan");
  const runId = options.readOnlyRunId ?? await ensureQuestionReviewRunIdUnlocked(artifactsDir);
  const boundary = { root, artifactsDir, runId };
  const { bindings, evidence, sourceFiles } = await deriveCurrentQuestionBindings(bundle, sourceRoot);
  const currentAssignmentIds = new Set(bindings.map(({ assignment }) => assignment.assignment_id));
  const ingestion = options.readOnlyRunId !== undefined
    ? { ...await readAuditQuestionLedger(boundary), accepted_count: 0, issues: [] }
    : await ingestAuditQuestionResults(boundary, currentAssignmentIds).catch(error => {
    if (isFileMissingError(error)) return { accepted_count: 0, answers: [], adjudications: [], consolidations: [], issues: [] };
    throw error;
  });
  const currentInputs = [...sourceFiles].map(([key, fingerprint]) => ({ kind: "source" as const, key, fingerprint }));
  const dependenciesByQuestion = new Map(bindings.map(binding => [binding.question.question_id, [
    ...binding.dependencies, ...currentInputs, ...binding.evidence.flatMap(item => item.dependencies),
  ]] as const));
  const pending = bindings.filter(binding => {
    const active = projectQuestionReview(binding.question, ingestion.answers,
      dependenciesByQuestion.get(binding.question.question_id), ingestion.adjudications);
    // An accepted inconclusive answer is not a clean result or a reason for
    // infinite redispatch. Reporting keeps its unanswered parts visible.
    return active.current.length === 0;
  });
  return { runId, bindings, pending, evidence, dependenciesByQuestion, ...ingestion };
}
