// sites-pinned: tests/audit/next-step-helpers.test.ts, tests/audit/charter-emit-order.test.ts, tests/audit/executor-registry-sync.test.ts, tests/audit/pipeline-integration.test.ts, tests/audit/source-read-only-executors.test.ts
import { readQuestionReportCharterOptions, type ArtifactBundle } from "../io/artifacts.js";
import { EXECUTOR_REGISTRY } from "./executors.js";
import { readRunSnapshotLinks } from "../io/runSnapshot.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { AdvanceAuditOptions } from "./advanceTypes.js";
import { RunLogger, readAuditReadState } from "audit-tools/shared";
import { runIntakeExecutor } from "./intakeExecutors.js";
import { runIntentEquivalenceResolve } from "./intentEquivalenceExecutor.js";
import {
  runStructureExecutor,
  runDesignAssessmentExecutor,
  runDocsDigestExecutor,
  runStructureDecompositionExecutor,
} from "./structureExecutors.js";
import { buildQuestionPlanArtifacts } from "./questionPlanExecutor.js";
import {
  runExternalAnalyzerImportExecutor,
} from "./ingestionExecutors.js";
import {
  runQuestionSynthesisExecutor,
  runQuestionSynthesisNarrativeExecutor,
} from "./synthesisExecutors.js";
import { runCriticalFlowFallbackExecutor } from "./criticalFlowFallbackExecutor.js";
import { runCharterExtractionExecutor } from "./charterExtractionExecutor.js";
import { runCharterComparisonExecutor } from "./charterComparisonExecutor.js";
import { runCharterFidelityExecutor } from "./charterFidelityExecutor.js";
import { runCharterClarificationExecutor } from "./charterClarificationExecutor.js";
import { runSystemicChallengeExecutor } from "./systemicChallengeExecutor.js";
import { runAutoFixExecutor } from "./autoFixExecutor.js";
import { runSyntaxResolutionExecutor } from "./syntaxResolutionExecutor.js";
import { runGraphEnrichmentExecutor } from "./graphEnrichmentExecutor.js";
import { runExternalAnalyzerAcquisitionExecutor } from "./acquisitionExecutor.js";
import { resolveAuditScope } from "./scope.js";

/**
 * Per-dispatch execution context threaded to every executor runner. Carries the
 * advance options (root, line/size indexes, incoming host results, analyzer
 * policy, …) plus the run logger + correlation id so a runner that emits its own
 * structured events (planning's scope event) can do so. The engine stays agnostic;
 * audit-code picks its own `Ctx` shape (cf. remediate-code's `RemediateCtx`).
 */
export interface AuditExecutorCtx {
  options: AdvanceAuditOptions;
  log: RunLogger;
  correlationId: string;
  obligation: string | null;
}

/** A single audit executor: bundle + ctx → the uniform run result. */
export type AuditExecutorRunner = (
  bundle: ArtifactBundle,
  ctx: AuditExecutorCtx,
) => Promise<ExecutorRunResult>;

/**
 * Audited source-read-only runners (`ExecutorDefinition.source_read_only`) may
 * retain the fold's manifest-index memo. The flag is an allowlist: new runners
 * and all command-backed tooling invalidate by default.
 */
const SOURCE_READ_ONLY_EXECUTORS: ReadonlySet<string> = new Set(
  EXECUTOR_REGISTRY.filter((executor) => executor.source_read_only).map(
    (executor) => executor.id,
  ),
);

export function preservesSourceIndexes(executor: string | null): boolean {
  return executor !== null && SOURCE_READ_ONLY_EXECUTORS.has(executor);
}

/**
 * Narrow an optional root to a definite string for a runner that requires it,
 * throwing the canonical "advanceAudit <executor> requires root" error otherwise.
 */
function requireRoot(root: string | undefined, executorName: string): string {
  if (!root) {
    throw new Error(`advanceAudit ${executorName} requires root`);
  }
  return root;
}

/**
 * What both synthesis executors read from disk. The runner owns the artifacts
 * dir and the repository root, so it reads the packet-retention index and what
 * the audit read (`readAuditReadState`) here, and the synthesis executors stay
 * synchronous.
 */
async function synthesisReadInputs(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions,
): Promise<Parameters<typeof runQuestionSynthesisExecutor>[1]> {
  const cycle = bundle.question_cycle;
  if (!cycle || cycle.pending.length > 0) throw new Error("Question review must reach report-ready state before synthesis");
  return {
    auditRead: options.root
      ? await readAuditReadState(options.root, bundle.audit_findings?.audit_read, {
          excludePaths: options.artifactsDir ? await readRunSnapshotLinks(options.artifactsDir) : [],
        })
      : null,
    charter: options.artifactsDir ? await readQuestionReportCharterOptions(options.artifactsDir) : undefined,
    questionReview: { accepted: cycle.answers, evidence: cycle.evidence, adjudications: cycle.adjudications,
      dependenciesByQuestion: cycle.dependenciesByQuestion, consolidations: cycle.consolidations },
  };
}

/**
 * Executor-id → runner. The single source of dispatch (A3 step 4 slice 2a):
 * `advanceAudit`'s scan path and its `preferredExecutor` forced path both dispatch
 * through this map, replacing the hand `switch` and the registry⇄switch sync
 * invariant. Each runner co-locates the per-executor argument adaptation the
 * switch arm used to do. Slice 2b reuses these same runners inside the obligation
 * `execute` closures that drive the `advance` fold.
 *
 * Executors absent here are host-delegation points (including
 * `semantic_review_executor`): routed through the host before reaching
 * `advanceAudit`, they produce a no-progress handoff (the "no runner" branch)
 * rather than a deterministic run.
 */
export const EXECUTOR_RUNNERS: Record<string, AuditExecutorRunner> = {
  intake_executor: async (bundle, { options }) =>
    runIntakeExecutor(
      bundle,
      requireRoot(options.root, "intake_executor"),
      options.artifactsDir,
      options.repositoryRoot ?? options.root,
    ),
  // DD-9: deterministic arms resolve directly; prose-only change requires the
  // consumed, pair-bound host verdict.
  intent_equivalence_executor: async (bundle, { options }) =>
    runIntentEquivalenceResolve(bundle, options.intentEquivalenceVerdict),
  external_analyzer_acquisition_executor: async (bundle, { options }) =>
    runExternalAnalyzerAcquisitionExecutor(
      bundle,
      options.root,
      options.externalAcquisition,
    ),
  // root is intentionally optional: present → buildGraphBundleFromFs, absent →
  // manifest-only buildGraphBundle.
  structure_executor: async (bundle, { options }) =>
    runStructureExecutor(bundle, options.root),
  critical_flow_fallback_executor: async (bundle, { options }) =>
    runCriticalFlowFallbackExecutor(bundle, options.criticalFlowFallbackResults),
  graph_enrichment_executor: async (bundle, { options }) =>
    runGraphEnrichmentExecutor(bundle, {
      root: options.root,
      analyzers: options.analyzers,
      llmEdgeReasoning: options.graphLlmEdgeReasoning,
      edgeReasoning: options.edgeReasoningResults,
    }),
  design_assessment_executor: async (bundle) =>
    runDesignAssessmentExecutor(bundle),
  docs_digest_executor: async (bundle, { options }) =>
    runDocsDigestExecutor(bundle, options.root),
  structure_decomposition_executor: async (bundle, { options }) =>
    runStructureDecompositionExecutor(bundle, options.root),
  // root and artifactsDir are passed through UNCHANGED and stay optional: the
  // omit branch needs no disk, and a `requireRoot` here would throw before the
  // executor's own `not_run` abstention could ever be recorded — which would
  // make the recorded abstention unreachable and the affirmation a lie.
  charter_extraction_executor: async (bundle, { options }) =>
    runCharterExtractionExecutor(bundle, options.charterSubmission, {
      ...(options.root ? { root: options.root } : {}),
      ...(options.artifactsDir ? { artifactsDir: options.artifactsDir } : {}),
    }),
  charter_comparison_executor: async (bundle, { options }) =>
    runCharterComparisonExecutor(bundle, options.charterComparisonSubmission, {
      ...(options.root ? { root: options.root } : {}),
    }),
  charter_fidelity_executor: async (bundle, { options }) =>
    runCharterFidelityExecutor(bundle, options.charterFidelitySubmission),
  charter_clarification_executor: async (bundle, { options }) =>
    runCharterClarificationExecutor(bundle, options.clarificationAnswers),
  systemic_challenge_executor: async (bundle, { options }) =>
    runSystemicChallengeExecutor(
      bundle,
      options.systemicChallenge,
      options.systemicChallengeSubmissionHash,
    ),
  planning_executor: async (bundle, { options, log, correlationId, obligation }) => {
    const root = requireRoot(options.root, "planning_executor");
    const plannedScope = await resolveAuditScope({ root, since: options.since, bundle });
    log.event({
      phase: "advance",
      kind: "scope",
      correlationId,
      obligation: obligation ?? undefined,
      note:
        plannedScope.mode === "delta"
          ? `delta since ${plannedScope.since}: ${plannedScope.seed_files.length} changed + ${plannedScope.expanded_files.length} neighbors; full audit advised before release`
          : "full audit scope",
    });
    return buildQuestionPlanArtifacts(bundle, plannedScope);
  },
  // The PRIOR report's `audit_read` is handed in so a re-synthesis over an
  // unchanged tree keeps it byte-identical and does not re-stale the narrative
  // pass.
  synthesis_executor: async (bundle, { options }) =>
    runQuestionSynthesisExecutor(bundle, await synthesisReadInputs(bundle, options)),
  // The narrative executor reads `auditRead` only on the fallback where no base
  // report exists yet; a persisted report's own `audit_read` rides through
  // `applyNarrative` untouched.
  synthesis_narrative_executor: async (bundle, { options }) =>
    runQuestionSynthesisNarrativeExecutor(bundle, options.narrativeResults, await synthesisReadInputs(bundle, options)),
  external_analyzer_import_executor: async (bundle, { options }) => {
    if (!options.externalAnalyzerResults) {
      throw new Error(
        "advanceAudit external_analyzer_import_executor requires externalAnalyzerResults",
      );
    }
    return runExternalAnalyzerImportExecutor(
      bundle,
      options.externalAnalyzerResults,
    );
  },
  // Both local-tooling executors receive the recorded consent decisions so a
  // recorded operator decline of prettier/black/sqlfluff/tsc/eslint vetoes the
  // spawn at the shared admitLocalSpawn chokepoint — the same decline-first
  // rule the acquisition engine enforces, applied to repo-local tooling.
  auto_fix_executor: async (bundle, { options }) =>
    runAutoFixExecutor(bundle, requireRoot(options.root, "auto_fix_executor"), {
      analyzerConsent: options.externalAcquisition?.analyzerConsent,
      // Forwarded so the phase gate is reachable through the PRODUCTION
      // dispatch, not only at the executor's direct seam — the shape the
      // decline veto was once found dead in (CP-NODE-5).
      autoFix: options.autoFix,
      repositoryRoot: options.repositoryRoot,
      artifactsDir: options.artifactsDir,
    }),
  syntax_resolution_executor: async (bundle, { options }) =>
    runSyntaxResolutionExecutor(
      bundle,
      requireRoot(options.root, "syntax_resolution_executor"),
      { analyzerConsent: options.externalAcquisition?.analyzerConsent },
    ),
};
