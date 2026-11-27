// sites-pinned: tests/audit/next-step-question-workload.test.ts
import { isFileMissingError } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { collectQuestionEvidence } from "../orchestrator/questionEvidence.js";
import { reviewSourceScope } from "../orchestrator/questionPlanning.js";
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import { probeScopeIndexKeyCached, type ScopeIndexMemo } from "../orchestrator/scopeIndexBaseline.js";
import { hashArtifactValue } from "../../shared/artifactFreshness.js";
import { computeStaleArtifacts, type StaleArtifactSet } from "../orchestrator/staleness.js";
import { ingestAuditQuestionResults, readAuditQuestionLedger } from "./dispatch/hostHandoff.js";
import { indexQuestionDependencies, projectQuestionReview, type AuditQuestionBinding } from "./dispatch/questionReviewAcceptance.js";
import { ensureQuestionReviewRunIdUnlocked } from "./questionReviewSession.js";
import { isProjectRulePath } from "../orchestrator/projectRuleEvidence.js";
import { questionWorkloadBindings } from "./questionWorkloadBindings.js";
import type { ReviewReopenEvent } from "../../shared/types/reviewQuestion.js";

interface QuestionCycleOptions {
  root: string;
  sourceRoot: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  readOnlyRunId?: string;
  staleArtifacts?: StaleArtifactSet;
}

/** The same source/evidence binding for dispatch, report and direct submit. */
export async function deriveCurrentQuestionBindings(
  bundle: ArtifactBundle,
  sourceRoot: string,
  verifiedSourceFiles?: AuditQuestionBinding["sourceFiles"],
  reopens: readonly ReviewReopenEvent[] = [],
  knownStale?: StaleArtifactSet,
) {
  const plan = bundle.review_plan;
  if (!plan) throw new Error("Question review requires the active plan");
  const scope = reviewSourceScope(bundle, bundle.scope);
  const sourceFiles = new Map([...scope.allowedSourcePaths, ...scope.allowedContractPaths].flatMap(path => {
    const fingerprint = scope.files.get(path)?.hash;
    return fingerprint ? [[path, fingerprint] as const] : [];
  }));
  const markerName = "external_analyzer_acquisition.json";
  const marker = bundle.external_analyzer_acquisition;
  const markerMetadata = bundle.artifact_metadata?.artifacts[markerName];
  let analyzerStatuses: NonNullable<typeof marker>["tool_statuses"] | undefined;
  if (marker?.enabled && marker.tool_statuses.some(status => status.comparison_fingerprint) &&
      markerMetadata?.content_hash === hashArtifactValue(markerName, marker)) {
    const stale = knownStale ?? computeStaleArtifacts(bundle, { emit: false });
    if (!stale.has(markerName) && !stale.deferred.has(markerName)) analyzerStatuses = marker.tool_statuses;
  }
  const evidence = await collectQuestionEvidence({
    snapshot_id: plan.snapshot_id, sourceRoot, sourceFiles, analyzerResults: bundle.external_analyzer_results ?? [],
    analyzerStatuses,
    rulePaths: [...new Set(plan.inventory.flatMap(item => item.contract_refs.map(ref => ref.path)))].filter(isProjectRulePath),
  });
  const bindings = await questionWorkloadBindings(bundle, sourceRoot, evidence, verifiedSourceFiles, reopens);
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
  const ledger = await readAuditQuestionLedger(boundary);
  const { bindings, evidence, sourceFiles } = await deriveCurrentQuestionBindings(bundle, sourceRoot, undefined, ledger.reopens, options.staleArtifacts);
  const currentAssignmentIds = new Set(bindings.map(({ assignment }) => assignment.assignment_id));
  const ledgerOnly = { ...ledger, accepted_count: 0, issues: [] };
  const ingestion = options.readOnlyRunId !== undefined ? ledgerOnly
    : await ingestAuditQuestionResults(boundary, currentAssignmentIds).catch(error => {
      if (isFileMissingError(error)) return ledgerOnly;
      throw error;
    });
  const sourceIndex = indexQuestionDependencies([...sourceFiles].map(([key, fingerprint]) => ({ kind: "source" as const, key, fingerprint })));
  const dependenciesByQuestion = new Map(bindings.map(binding => [binding.question.question_id, {
    sourceIndex, local: [...binding.dependencies, ...binding.evidence.flatMap(item => item.dependencies)],
  }] as const));
  const pending = bindings.filter(binding => {
    const active = projectQuestionReview(binding.question, ingestion.answers,
      dependenciesByQuestion.get(binding.question.question_id));
    // An accepted inconclusive answer is not a clean result or a reason for
    // infinite redispatch. Reporting keeps its unanswered parts visible.
    return active.current.length === 0;
  });
  return { runId, bindings, pending, evidence, dependenciesByQuestion, ...ingestion };
}

export function assertQualifiedReviewObligation(obligation: string | null): void {
  if (obligation !== null && !["audit_tasks_completed", "synthesis_current", "synthesis_narrative_current"].includes(obligation)) {
    throw new Error("Qualified question review cannot derive upstream obligation: " + obligation);
  }
}

/** The tooling receipt authorizes a review continuation, never fresh acquisition.
 * Use the unchanged DAG and probe the same tracked corpus as normal advance. */
export async function assertQualifiedReviewStillCurrent(
  bundle: ArtifactBundle, sourceRoot: string, memo?: ScopeIndexMemo, knownStale?: StaleArtifactSet,
) {
  if (!bundle.review_tooling_qualification) return;
  const stale = knownStale ?? computeStaleArtifacts(bundle, { emit: false });
  const derivedReports = new Set(["audit-findings.json", "audit-report.md", "synthesis-narrative.json"]);
  if ([...stale, ...stale.deferred].some(name => !derivedReports.has(name))) {
    throw new Error("Qualified question review has stale non-report inputs; refusing to reacquire evidence.");
  }
  const manifest = bundle.repo_manifest;
  if (!manifest ||
      await probeScopeIndexKeyCached(memo, sourceRoot, manifest.files.map(file => file.path)) !== (manifest.scope_index_key ?? null)) {
    throw new Error("Qualified question review has a changed or unverified frozen scope index.");
  }
  const scope = reviewSourceScope(bundle, bundle.scope);
  const admitted = [...new Set([...scope.allowedSourcePaths, ...scope.allowedContractPaths])];
  if (!(await checkFileIntegrity(sourceRoot, manifest, admitted)).is_clean) {
    throw new Error("Qualified question review cannot continue: frozen source changed.");
  }
  assertQualifiedReviewObligation(decideNextStep(bundle, { emitStaleness: false }).selected_obligation);
}
