/**
 * Extracted helpers for the next-step command.
 *
 * Splitting these out of nextStepCommand.ts reduces that file to just the
 * top-level cmdNextStep dispatcher, keeping each module focused on a single
 * concern.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  advance,
  describeStoppedFold,
  RunLogger,
  compareCodeUnits,
  isFileMissingError,
  isJsonParseError,
  isRecord,
  readJsonFile,
  persistAnalyzerConsent,
  persistAnalyzerSettings,
  writeJsonFile,
  type ObligationDef,
  type ObligationOutcome,
} from "audit-tools/shared";
import type {
  AnalyzerSetting,
  CriticalFlowFallbackResult,
  GraphEdge,
  SynthesisNarrative,
} from "audit-tools/shared";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  promoteFinalAuditReport,
} from "../io/artifacts.js";
import {
  auditReportPath,
  groundDesignFindings,
  laneAssetsDir,
  promotedAuditReportPath,
} from "audit-tools/shared";
import type { CharterKind, CharterSubmission } from "audit-tools/shared";
import { charterExtractionKindsForCeiling } from "./charterExtractionPrompt.js";
import {
  LANE_SUBMISSION_SCHEMAS,
  charterLaneSchema,
  describeSubmissionShapeMismatch,
  unwrapSubmissionArray,
} from "./laneValidators.js";
import type { ZodError, ZodTypeAny } from "zod";
import type { AuditState } from "../types/auditState.js";
import type { Finding } from "../types.js";
import type {
  DesignAssessment,
  RejectedDesignReviewSubmission,
} from "../types/designAssessment.js";
import {
  advanceAudit,
  engineMaxTransitions,
  findExecutorFailure,
  runSingleAdvanceStep,
  MAX_DRAIN_STEPS,
  type AdvanceAuditResult,
} from "../orchestrator/advance.js";
import {
  buildDesignReviewSnapshot,
  isDesignReviewStale,
  type DesignReviewPass,
} from "../orchestrator/designReviewSnapshot.js";
import {
  computeStaleArtifacts,
  emitStalenessRecord,
  isMetadataMigrationStaleness,
  resetStalenessDedup,
} from "../orchestrator/staleness.js";
import {
  commitFold,
  createFoldTransaction,
  markSubmissionApplied,
  describeQuarantineLocation,
  quarantineLocationPhrase,
  quarantineSubmissionFile,
  quarantineSurvivalNote,
  recoverStagedSubmissions,
  stageLaneSubmission,
  type FoldTransaction,
} from "./foldTransaction.js";
import {
  charterClarificationOmits,
  charterExtractionOmits,
  intentEquivalenceOmits,
  synthesisNarrativeOmits,
  systemicChallengeOmits,
} from "../orchestrator/obligationPolicy.js";
import { computeArtifactStateSignature } from "../orchestrator/artifactMetadata.js";
import {
  decideNextStep,
  PRIORITY,
  AUDIT_FRICTION_RUN_ID,
  decideAuditFrictionCloseout,
} from "../orchestrator/nextStep.js";
import { isHostDelegationExecutor } from "../orchestrator/executors.js";
import { resolveCharterCeiling } from "../orchestrator/charterExtractionExecutor.js";
import { deriveAuditState } from "../orchestrator/state.js";
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";
import type { EdgeReasonRewrite } from "../orchestrator/edgeReasoning.js";
import {
  graphEnrichmentUnresolvedAnalyzers,
  graphEnrichmentLowConfidenceEdges,
  pendingAnalyzerConsent,
} from "../orchestrator/hostInputPause.js";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import type { ExternalAnalyzerCandidate } from "audit-tools/shared";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { runAuditStepUnlocked, withArtifactTreeHold } from "./auditStep.js";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";
import {
  writeHandoffOnly,
  ensureSemanticReviewRunUnlocked,
  loadCurrentActiveReviewRun,
} from "./reviewRun.js";
import { sizeIndexFromManifest } from "../orchestrator/reviewPackets.js";
import { buildPendingAuditTasks } from "./dispatch/packetFilter.js";
import { buildLineIndex } from "./lineIndex.js";
import {
  ingestAuditHostResults,
  type AuditHostValidationWarning,
} from "./dispatch/hostHandoff.js";
import type { AuditHostIngestIssue } from "../validation/ingestIssueCodes.js";
import {
  CHARTER_EXTRACTION_MERGED_FILENAME,
  GATE_LANES,
  charterExtractionLane,
  charterExtractionPacketFilename,
  laneSubmissionPath,
  recordHostResultOutcomes,
  recordLaneOutcome,
} from "./laneSubmissions.js";

// ── Gate submission helper ────────────────────────────────────────────────────

/**
 * One poll attempt over a lane's bound submission path. Every gate that
 * consumes host/worker submissions narrows on `status`, so a malformed lane can
 * never hard-fail the whole next-step call (the 2026-08-06 design-review loss:
 * a SyntaxError thrown out of one lane destroyed the sibling lane's consumed,
 * not-yet-persisted results).
 */
export type SubmissionConsumeAttempt<T> =
  | { status: "ok"; value: T; path: string; contentHash?: string }
  | { status: "absent" }
  | { status: "malformed"; path: string; reason: string };

/**
 * Read a lane's submission from the TOOL-COMPUTED path its emission bound —
 * never a name a host could type. `ok` when the file exists and parses;
 * `absent` on ENOENT-family errors; `malformed` when the file exists but is not
 * JSON — submitted content is the CALLER's to quarantine, never an
 * infrastructure failure. All other IO errors re-throw unchanged.
 *
 * With a fold transaction the submission is STAGED first — renamed into
 * `submission-staging/` before anything parses it (CX-02 landing 3), so a
 * crash mid-consumption is recoverable and `path` names the STAGED file: the
 * quarantine helpers move it from there, and `markSubmissionApplied` (never a
 * direct unlink) schedules its commit-time deletion. Without a transaction the
 * read is a pure probe of the bound path — nothing moves.
 */
export async function tryConsumeSubmission<T>(
  artifactsDir: string,
  lane: string,
  tx?: FoldTransaction,
): Promise<SubmissionConsumeAttempt<T>> {
  if (tx) {
    const stagedResult = await stageLaneSubmission(tx, artifactsDir, lane);
    if (stagedResult.status === "absent") return { status: "absent" };
    const { stagingPath, contentHash } = stagedResult.staged;
    try {
      const value = await readJsonFile<T>(stagingPath);
      return { status: "ok", value, path: stagingPath, contentHash };
    } catch (error) {
      if (isJsonParseError(error)) {
        return { status: "malformed", path: stagingPath, reason: error.message };
      }
      throw error;
    }
  }
  const filePath = laneSubmissionPath(artifactsDir, lane);
  try {
    const value = await readJsonFile<T>(filePath);
    return { status: "ok", value, path: filePath };
  } catch (error) {
    if (isFileMissingError(error)) return { status: "absent" };
    if (isJsonParseError(error)) {
      return { status: "malformed", path: filePath, reason: error.message };
    }
    throw error;
  }
}

// ── Parameters type shared across all nextStep helpers ──────────────────────

export type NextStepParams = {
  root: string;
  artifactsDir: string;
  selfCliPath: string;
  timeoutMs: number;
  narrativeEnabled?: boolean;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  /**
   * External-analyzer acquisition gate (Slice D). Set by the real CLI next-step
   * path (`enabled:true` + global-`fetch` adapter); left unset by tests so the
   * acquisition executor stays a hermetic empty-marker no-op.
   */
  externalAcquisition?: ExternalAcquisitionAdvanceOptions;
  since?: string;
};

export type TerminalStepResult =
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string; triage?: import("audit-tools/shared").FrictionTriageDecision }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

/**
 * A guard's in-fold verdict that the fold must END at a terminal — carried out
 * of the engine as an emit and CONVERTED to the real terminal step by the fold
 * driver AFTER the single core commit and outside the hold. The conversion
 * cannot happen in-fold: `buildTerminalStep` can promote the final report,
 * and promotion DELETES artifactsDir — under the fold's own hold that would
 * destroy the lock it holds and the tree its commit is about to write.
 */
export interface TerminalFoldIntent {
  kind: "terminal_intent";
  bundle: ArtifactBundle;
  state: AuditState;
  reason: string;
}

/**
 * The host-actionable outcome of one `next-step` deterministic fold — the
 * discriminated union `runDeterministicForNextStep` returns and `cmdNextStep`
 * renders (one branch per kind). Each audit `ObligationDef.execute` returns this
 * inside an `emit` outcome (or a `transition` carrying the reloaded bundle when
 * the fold continues).
 */
export type NextStepResult =
  | {
      kind: "semantic_review";
      state: AuditState;
      bundle: ArtifactBundle;
      activeReviewRun: ActiveReviewRun;
      selectedExecutor?: string | null;
      inProcessMadeProgress?: boolean;
      /**
       * Failures the just-completed ingest classified — a bound result that
       * never arrived, would not parse, or failed the contract. Carried to the
       * emitted step so the host is TOLD which items to repair instead of
       * receiving an identical workload with no statement of what went wrong.
       */
      ingestIssues?: readonly AuditHostIngestIssue[];
      /**
       * Advisory validation findings on results that WERE accepted. Sibling of
       * {@link ingestIssues}: informational only — an accepted-with-warning
       * result needs no repair and must not read as one that could not be
       * accepted.
       */
      validationWarnings?: readonly AuditHostValidationWarning[];
    }
  | { kind: "design_review_parallel"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_contract"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_conceptual"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "charter_extraction"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "charter_delta"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "charter_clarification"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "systemic_challenge"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "confirm_intent"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "intent_equivalence"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "analyzer_install"; state: AuditState; bundle: ArtifactBundle; unresolved: AnalyzerPlanEntry[] }
  | { kind: "analyzer_consent"; state: AuditState; bundle: ArtifactBundle; pending: ExternalAnalyzerCandidate[] }
  | { kind: "edge_reasoning"; state: AuditState; bundle: ArtifactBundle; candidates: GraphEdge[] }
  | { kind: "critical_flow_fallback"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "synthesis_narrative"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "complete"; state: AuditState; bundle: ArtifactBundle; finalReportPath: string; triage?: import("audit-tools/shared").FrictionTriageDecision }
  | { kind: "blocked"; state: AuditState; bundle: ArtifactBundle; reason: string };

/**
 * The return-kind set as RUNTIME data, so a drift guard can IMPORT the real set
 * instead of transcribing it into a literal that silently agrees with a second
 * literal on the other side of the seam.
 *
 * A TypeScript union is erased at runtime, so the bridge is a table typed TOTAL
 * over `NextStepResult["kind"]`: a kind added to the union above with no row
 * here is a compile error (missing property), and a row naming a kind the union
 * does not carry is one too (excess property). The exported array is
 * `Object.keys` of that table — derived, never a second hand-listed copy that
 * could disagree with the table it describes.
 */
const NEXT_STEP_RETURN_KIND_TABLE: Readonly<
  Record<NextStepResult["kind"], true>
> = {
  semantic_review: true,
  design_review_parallel: true,
  design_review_contract: true,
  design_review_conceptual: true,
  charter_extraction: true,
  charter_delta: true,
  charter_clarification: true,
  systemic_challenge: true,
  confirm_intent: true,
  intent_equivalence: true,
  analyzer_install: true,
  analyzer_consent: true,
  edge_reasoning: true,
  critical_flow_fallback: true,
  synthesis_narrative: true,
  complete: true,
  blocked: true,
};

/** The kinds `runDeterministicForNextStep` can return, derived from the table's own keys. */
export const NEXT_STEP_RETURN_KINDS: readonly NextStepResult["kind"][] =
  Object.keys(NEXT_STEP_RETURN_KIND_TABLE) as NextStepResult["kind"][];

/**
 * Finalization thrashing tolerance (ARC-b8fed771 / the finalization-cycle guard).
 * The deterministic fold may legitimately revisit a prior artifact state a bounded
 * number of times (e.g. a runtime_validation <-> synthesis ping-pong, or
 * filesystem-retry revision churn) before the canonical report is rendered; only
 * outrunning distinct states by THIS many revisits is a non-converging cycle. Kept
 * a single named constant — never inline the literal (HANDOFF approach-B mandate:
 * no magic numbers).
 */
export const FINALIZATION_CYCLE_TOLERANCE = 16;

// ── Extracted helpers ─────────────────────────────────────────────────────────

/**
 * Promote the final report bundle to the repo root — but only once friction
 * triage is satisfied. Returns the path the present_report step should surface.
 *
 * promoteFinalAuditReport copies audit-report.md + audit-findings.json to the
 * parent `.audit-tools/` dir, then DELETES artifactsDir (so a rerun after a
 * truly-complete audit starts fresh). That deletion must not happen while
 * friction triage is still pending ("dispose"): the host has not yet written its
 * open_observations, and wiping artifactsDir would also drop audit_state /
 * audit_report, causing the next next-step to replay the fold from scratch (the
 * confirm_intent regression). So:
 *   - already promoted (re-entry after a prior complete) → use the promoted path
 *   - friction pending → DO NOT promote; surface the in-place report so the host
 *     can read it while finishing triage. artifactsDir stays intact, so the next
 *     call (after open_observations are written) re-evaluates triage cleanly.
 *   - friction satisfied → promote (and delete artifactsDir) → rerun starts fresh
 */
async function promoteIfFrictionSatisfied(
  artifactsDir: string,
  triage: import("audit-tools/shared").FrictionTriageDecision,
): Promise<string> {
  const promotedPath = promotedAuditReportPath(artifactsDir);
  // "Already promoted" must mean THIS run's render, not any file at the promoted
  // path: a PREVIOUS audit's promoted report satisfies a bare existence check,
  // which is exactly the dogfood 2026-07-30 false-green — `status: complete`
  // named the promoted path while the root deliverables still held the prior
  // run's report and this run's render sat only under `.audit-tools/audit/`.
  // Identity, not existence: promoted content must equal the in-place render.
  const inPlacePath = auditReportPath(artifactsDir);
  const [promotedText, inPlaceText] = await Promise.all([
    readFile(promotedPath, "utf8").catch(() => null),
    readFile(inPlacePath, "utf8").catch(() => null),
  ]);
  // A missing in-place render alongside an existing promoted file is the
  // legitimate re-entry AFTER promotion (promotion deletes artifactsDir);
  // a PRESENT in-place render that differs is precisely the stale-promotion
  // case and must fall through to promote.
  const alreadyPromoted =
    promotedText !== null && (inPlaceText === null || promotedText === inPlaceText);
  if (alreadyPromoted) return promotedPath;
  if (triage.action === "dispose") {
    // Friction triage still pending — keep the in-place report, do not delete.
    return inPlacePath;
  }
  const promoted = await promoteFinalAuditReport({ artifactsDir });
  return promoted.promoted ? promotedPath : inPlacePath;
}

/**
 * Build the terminal step for a deterministic fold that has stopped advancing
 * (no actionable obligation, or a cycle guard fired). A rendered report is the
 * deliverable: if synthesis already produced one — or the state is formally
 * complete — present it instead of reporting the stopped fold as a bare
 * "blocked" failure. A completed audit must never surface as blocked just
 * because finalization kept churning (e.g. a runtime_validation <-> synthesis
 * ping-pong, or revision churn from filesystem retries) after the report was
 * written. With no report yet, the stop is a genuine block.
 */
export async function buildTerminalStep(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  blockedReason: string,
): Promise<TerminalStepResult> {
  const reportRendered =
    state.status === "complete" || Boolean(bundle.audit_report);
  await writeHandoffOnly({
    root: params.root,
    artifactsDir: params.artifactsDir,
    bundle,
    audit_state: state,
    progress_summary:
      reportRendered && state.status !== "complete"
        ? `Audit report already rendered; ending run. ${blockedReason}`
        : blockedReason,
  });
  if (!reportRendered) {
    return { kind: "blocked", state, bundle, reason: blockedReason };
  }
  // Evaluate friction triage BEFORE promotion. promoteFinalAuditReport deletes
  // artifactsDir, so promoting while triage is still pending ("dispose") would
  // (a) delete the friction record the host must finish writing, and (b) wipe
  // audit_state/audit_report so the next next-step replays the fold from scratch
  // (the confirm_intent regression). Defer promotion until triage is satisfied;
  // until then keep the in-place report so the host can read it.
  const triage = await decideAuditFrictionCloseout(params.artifactsDir, AUDIT_FRICTION_RUN_ID);
  const finalReportPath = await promoteIfFrictionSatisfied(params.artifactsDir, triage);
  return {
    kind: "complete",
    state,
    bundle,
    finalReportPath,
    triage,
  };
}

type AnalyzerConsentBranchResult =
  | { action: "continue" }
  | { action: "return"; result: { kind: "analyzer_consent"; state: AuditState; bundle: ArtifactBundle; pending: ExternalAnalyzerCandidate[] } }
  | { action: "fallthrough" };

/**
 * Item B (consent surfacing) — the acquisition obligation's fold branch,
 * mirroring the analyzer-install consent fold exactly:
 *   - nothing pending (acquisition off / this run's scoped grant covers every
 *     applicable candidate / all decided) → run the deterministic acquisition
 *     executor (`fallthrough`);
 *   - a decisions submission arrived on the `analyzer_consent` lane
 *     (`{ "<id>": "granted" | "declined" }`) → persist the decisions into
 *     session config (decisions durable, tokens never), fold them into the
 *     in-flight acquisition options, and re-scan (`continue`);
 *   - otherwise → emit the ONE batched operator-interactive offer step
 *     (`return`), so applicable consent-gated candidates are never silently
 *     skipped (the silent-fail-closed defect this program exists to fix).
 */
export async function handleAnalyzerConsentBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "externalAcquisition">,
  bundle: ArtifactBundle,
  state: AuditState,
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined },
  tx: FoldTransaction,
): Promise<AnalyzerConsentBranchResult> {
  const pending = pendingAnalyzerConsent({
    root: params.root,
    analyzers: analyzersRef.value,
    externalAcquisitionEnabled: params.externalAcquisition?.enabled,
    analyzerConsent: params.externalAcquisition?.analyzerConsent,
    // Typed as AnalyzerConsentTokenGrant end-to-end — the forwarding site takes
    // the grant, never a bare string, so a candidate outside the grant's scope
    // is still offered rather than silently admitted.
    acquisitionConsentToken: params.externalAcquisition?.consentToken,
  });
  if (pending.length === 0) return { action: "fallthrough" };
  const incoming = await consumeEnumMapSubmission(
    params.artifactsDir,
    GATE_LANES.analyzer_consent,
    ANALYZER_CONSENT_VALUES,
    tx,
  );
  if (incoming.status === "quarantined") {
    return { action: "continue" };
  }
  if (incoming.status === "ok") {
    // The operator answers grants and declines on ONE lane, but the two have
    // different lifetimes and the split is enforced here rather than trusted.
    // A DECLINE is durable: it vetoes every later spawn of that tool. A GRANT
    // binds only the run that asked (owner directive, 2026-08-21) — a durable
    // grant keeps granting itself to runs whose operator never saw the offer,
    // which for a network-egress analyzer turns one consent into standing
    // consent. Grants therefore ride the per-run consent TOKEN, the channel the
    // strict policy schema cannot hold.
    const declined: Record<string, "declined"> = {};
    const granted: string[] = [];
    for (const [id, decision] of Object.entries(incoming.values)) {
      if (decision === "declined") declined[id] = "declined";
      else granted.push(id);
    }
    await persistAnalyzerConsent(params.root, declined);
    if (params.externalAcquisition) {
      params.externalAcquisition.analyzerConsent = {
        ...(params.externalAcquisition.analyzerConsent ?? {}),
        ...declined,
      };
      if (granted.length > 0) {
        const existing = params.externalAcquisition.consentToken;
        params.externalAcquisition.consentToken = {
          value: existing?.value ?? randomUUID(),
          // Scoped, never run-wide: the grant names exactly the ids the
          // operator was offered and answered.
          tools: [...new Set([...(existing?.tools ?? []), ...granted])].sort(
            compareCodeUnits,
          ),
        };
      }
    }
    // Deletion + the accepted ledger event are COMMIT-phase (the consent
    // persist above is durable-by-design and idempotent, so a crash-replay
    // re-applies it harmlessly while the staged file is restored).
    markSubmissionApplied(
      tx,
      incoming.path,
      incoming.ignored.length > 0
        ? describeIgnoredKeys(incoming.ignored, ANALYZER_CONSENT_VALUES)
        : undefined,
    );
    return { action: "continue" };
  }
  return { action: "return", result: { kind: "analyzer_consent", state, bundle, pending } };
}

type GraphEnrichmentBranchResult =
  | {
      /** A submission was consumed; keep folding on the carried bundle. */
      action: "continue";
      bundle: ArtifactBundle;
    }
  | { action: "return"; result: { kind: "analyzer_install"; state: AuditState; bundle: ArtifactBundle; unresolved: AnalyzerPlanEntry[] } }
  | { action: "return"; result: { kind: "edge_reasoning"; state: AuditState; bundle: ArtifactBundle; candidates: GraphEdge[] } }
  | { action: "fallthrough" };

/**
 * Handle the `graph_enrichment_executor` submission-polling block.
 * Checks for pending analyzer install decisions and edge-reasoning results.
 * Returns an action object:
 *   - `continue`    → caller should keep folding (already consumed a submission).
 *   - `return`      → caller should emit the embedded result to cmdNextStep.
 *   - `fallthrough` → nothing submitted; run the deterministic executor.
 */
export async function handleGraphEnrichmentBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since">,
  bundle: ArtifactBundle,
  state: AuditState,
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined },
  tx: FoldTransaction,
  deps: {
    /**
     * The LOCK-FREE forced-apply primitive. The fold holds the artifact-tree
     * lock for its whole drain, so the injected runner (and its default) must
     * never acquire it — the locking `runAuditStep` is banned from this module.
     */
    runStep?: typeof runAuditStepUnlocked;
    /**
     * Injectable so the analyzer-decisions branch is testable at all. The real
     * resolution asks the MACHINE which analyzers are installed, so a fixture
     * that needs `unresolved.length > 0` would pass or fail depending on the box
     * it runs on — a suite verdict must not depend on that. Same shape as the
     * final gate's injected runner: absent on every production call, where the
     * behavior is byte-identical to calling the real resolver directly.
     */
    unresolvedAnalyzers?: typeof graphEnrichmentUnresolvedAnalyzers;
  } = {},
): Promise<GraphEnrichmentBranchResult> {
  const runStep = deps.runStep ?? runAuditStepUnlocked;
  // Fold-level pause detection is single-sourced in `hostInputPause` so the
  // plan draw's classifier (`obligationPolicy.ts`) and this fold agree EXACTLY
  // on when the analyzer-install consent / edge-reasoning turns are owed.
  const pauseInputs = {
    root: params.root,
    analyzers: analyzersRef.value,
    graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
  };
  const unresolved = (deps.unresolvedAnalyzers ?? graphEnrichmentUnresolvedAnalyzers)(
    bundle,
    pauseInputs,
  );
  if (unresolved.length > 0) {
    const incoming = await consumeEnumMapSubmission<AnalyzerSetting>(
      params.artifactsDir,
      GATE_LANES.analyzer_decisions,
      ANALYZER_SETTING_VALUES,
      tx,
    );
    if (incoming.status === "quarantined") {
      // A non-object top-level value used to be neither merged, deleted, nor
      // diagnosed — the file lingered at its bound path and the analyzer_install
      // step re-emitted silently forever. Quarantined + diagnosed instead.
      return { action: "continue", bundle };
    }
    if (incoming.status === "ok") {
      const merged = await persistAnalyzerSettings(params.root, incoming.values);
      analyzersRef.value = merged.analyzers;
      markSubmissionApplied(
        tx,
        incoming.path,
        incoming.ignored.length > 0
          ? describeIgnoredKeys(incoming.ignored, ANALYZER_SETTING_VALUES)
          : undefined,
      );
      return { action: "continue", bundle };
    }
    return { action: "return", result: { kind: "analyzer_install", state, bundle, unresolved } };
  }

  // Phase 4B — optional edge-reasoning producing turn. Once analyzer installs
  // are resolved, if the flag is on and the floor carries low-confidence
  // (< 0.65) edges, emit one bounded host turn (subagent dispatch or a single
  // host step) to produce reason rewrites, then re-run. The enrichment
  // executor applies the host-supplied rewrites in the SAME advanceAudit call
  // that merges analyzer edges and writes analyzer_capability, so graph_bundle
  // and its marker stay revision-consistent (no staleness loop). Flag off or
  // no candidates → fall through and run the executor with no rewrites.
  {
    const candidates = graphEnrichmentLowConfidenceEdges(bundle, pauseInputs);
    if (candidates.length > 0) {
      const edgeReasoningIncoming = await tryConsumeSubmission<unknown>(
        params.artifactsDir,
        GATE_LANES.edge_reasoning,
        tx,
      );
      if (edgeReasoningIncoming.status === "malformed") {
        const quarantine = await quarantineSubmissionFile(
          params.artifactsDir,
          edgeReasoningIncoming.path,
          GATE_LANES.edge_reasoning,
        );
        await recordEdgeReasoningRejection(params.artifactsDir, {
          lane: GATE_LANES.edge_reasoning,
          quarantine_path: quarantine.quarantinePath,
          reason: edgeReasoningIncoming.reason,
          rejected_at: new Date().toISOString(),
        });
        await recordLaneOutcome(params.artifactsDir, GATE_LANES.edge_reasoning, {
          kind: "rejected",
          issueCode: "submission_malformed",
          message:
            edgeReasoningIncoming.reason + quarantineSurvivalNote(quarantine),
        });
        return { action: "continue", bundle };
      }
      if (edgeReasoningIncoming.status === "ok") {
        // Same hazard class as the design-review quarantine fix: a malformed
        // submission used to no-op silently inside applyEdgeReasoning (it never
        // throws), the unconditional unlink then destroyed the file, and the
        // identical edge_reasoning step re-emitted with zero signal. Tolerant-
        // unwrap first (EdgeReasoningResults is a single-array-property object,
        // so the same "exactly one array-valued top-level property" rule
        // applies, and a bare rewrites array is accepted too); anything else is
        // quarantined and named in the re-emitted step's prompt.
        const unwrapped = unwrapSubmissionArray(edgeReasoningIncoming.value);
        if (!unwrapped.ok) {
          const quarantine = await quarantineSubmissionFile(
            params.artifactsDir,
            edgeReasoningIncoming.path,
            GATE_LANES.edge_reasoning,
          );
          await recordEdgeReasoningRejection(params.artifactsDir, {
            lane: GATE_LANES.edge_reasoning,
            quarantine_path: quarantine.quarantinePath,
            reason: unwrapped.reason,
            rejected_at: new Date().toISOString(),
          });
          await recordLaneOutcome(params.artifactsDir, GATE_LANES.edge_reasoning, {
            kind: "rejected",
            issueCode: "submission_contract_invalid",
            message: unwrapped.reason + quarantineSurvivalNote(quarantine),
          });
          return { action: "continue", bundle };
        }
        // Apply BEFORE the deletion commits: if runStep throws, the staged
        // submission is RESTORED for the retry instead of being lost. The
        // executor is forced explicitly — the fold's engine selected this
        // obligation, so the selection is graph enrichment by construction,
        // and an unforced call would re-enter a drain.
        const applied = await runStep(
          {
            root: params.root,
            artifactsDir: params.artifactsDir,
            analyzers: analyzersRef.value,
            graphLlmEdgeReasoning: true,
            preferredExecutor: "graph_enrichment_executor",
            edgeReasoningResults: { rewrites: unwrapped.array as EdgeReasonRewrite[] },
            since: params.since,
          },
          bundle,
        );
        markSubmissionApplied(tx, edgeReasoningIncoming.path);
        await clearEdgeReasoningRejection(params.artifactsDir);
        return { action: "continue", bundle: applied.updated_bundle };
      }
      return { action: "return", result: { kind: "edge_reasoning", state, bundle, candidates } };
    }
  }
  // No undecided installs (and no pending edge reasoning): fall through to run
  // the executor below (it installs for ephemeral/permanent, uses repo/cache,
  // skips the rest).
  return { action: "fallthrough" };
}

type BranchActionResult =
  | {
      /** Submissions were consumed/refused; keep folding on the carried bundle. */
      action: "continue";
      bundle: ArtifactBundle;
    }
  | { action: "return"; result: { kind: "design_review_parallel"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_contract"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_conceptual"; state: AuditState; bundle: ArtifactBundle } };

/**
 * Handle the `design_review_contract` or `design_review_conceptual` submission
 * polling blocks. Checks the contract and conceptual lanes independently.
 *
 * Returns:
 *   - `continue`               → one or both lane submissions were consumed; keep folding.
 *   - `design_review_parallel` → both passes still needed; dispatch two subagents.
 *   - `design_review_contract` → only contract pass still needed.
 *   - `design_review_conceptual` → only conceptual pass still needed.
 *
 * Also handles legacy `design-review-findings.json` for backward compatibility.
 */
/** Whether a completed design-review pass has gone stale vs. its snapshot. */
function passIsStale(bundle: ArtifactBundle, pass: DesignReviewPass): boolean {
  const snapshot = bundle.design_review_snapshots?.[pass];
  return snapshot ? isDesignReviewStale(snapshot, bundle) : false;
}

// ── Submission-array quarantine (malformed-submission fix) ───────────────────
//
// `handleDesignReviewBranch` used to unconditionally `unlink` every
// design-review submission and merge ONLY when `Array.isArray(value)` — any
// other top-level shape (an object-wrapped `{findings:[...]}`, a bare string,
// two competing array properties, ...) was silently destroyed with no
// quarantine, no message, `consumed` staying false, and the identical step
// re-emitting forever. A host resubmitting the same honest mistake (most
// commonly a JSON-object-mode LLM wrapping its array in a single top-level
// key) lost its work every round with zero signal. Fixed here:
//   1. tolerant unwrap FIRST — a top-level object wrapping exactly one
//      array-valued property is unambiguous and is accepted as that array;
//   2. only a shape that survives neither the bare-array check nor the
//      unwrap is quarantined — moved to `<artifactsDir>/quarantine/`, never
//      unlinked-and-forgotten;
//   3. the quarantine is recorded on `design_assessment.rejected_submissions`
//      AND on the submission ledger so it survives the same-call `continue`
//      re-derivation, and the re-emitted design-review step names the
//      quarantined file + reason (see `renderDesignReviewRejectionNotice`,
//      threaded in nextStepCommand.ts).
//
// P25-f closes the remaining half: an ACCEPTED array is no longer deleted here.
// Deleting at unwrap time meant a submission the caller then had no target to
// merge into was gone — valid work destroyed with no quarantine and no record.
// The caller now unlinks after it has applied the value, exactly as the object
// variant has always worked, so a submission is only ever destroyed once its
// content is somewhere else.

type ConsumeArraySubmissionResult<T> =
  | { status: "absent" }
  | { status: "ok"; value: T[]; path: string }
  | {
      status: "quarantined";
      /** `null` when the copy to quarantine failed — see `QuarantineOutcome`. */
      quarantinePath: string | null;
      lane: string;
      reason: string;
    };

// `quarantineSubmissionFile` moved to `foldTransaction.ts` (the staging/commit
// module owns submission-file lifecycle mechanics); imported above.

/**
 * Quarantine a submission that failed zod validation — or failed to parse as
 * JSON at all (a plain string reason): move it off its bound path (never
 * unlink-and-discard), write a stderr diagnostic naming the quarantined file +
 * the error, and record the refusal on the submission ledger so a repaired run
 * stays distinguishable from a clean one. The single loud-quarantine path
 * shared by every schema-validated gate (`runOmittableGate` +
 * `handleIntentEquivalenceBranch` + the charter lane loop) so the "quarantine
 * loudly" property cannot drift between them. Returns the quarantine path, or
 * `null` when the copy to quarantine failed and the content is still at its
 * original path — see `QuarantineOutcome`.
 */
async function quarantineMisshapedSubmission(
  artifactsDir: string,
  filePath: string,
  lane: string,
  error: ZodError | string,
): Promise<string | null> {
  const reason = typeof error === "string"
    ? error
    : error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  const quarantine = await quarantineSubmissionFile(artifactsDir, filePath, lane);
  process.stderr.write(
    `[audit-code] ${lane} submission ${quarantineLocationPhrase(quarantine)}` +
      `${quarantineSurvivalNote(quarantine)}: ${reason}. ` +
      `Fix the shape and resubmit.\n`,
  );
  await recordLaneOutcome(artifactsDir, lane, {
    kind: "rejected",
    issueCode:
      typeof error === "string" ? "submission_malformed" : "submission_contract_invalid",
    message: reason + quarantineSurvivalNote(quarantine),
  });
  return quarantine.quarantinePath;
}

/**
 * Read a lane submission expected to be an array (or a top-level object
 * wrapping exactly one array-valued property, the tolerant unwrap). Accepts
 * either shape; any other shape is quarantined (never unlinked-and-discarded)
 * and reported with a reason.
 *
 * An accepted submission is NOT deleted here (P25-f) — the caller unlinks after
 * it has applied the value, so a submission is never destroyed before its
 * content has landed somewhere else.
 */
export async function consumeArraySubmission<T>(
  artifactsDir: string,
  lane: string,
  tx?: FoldTransaction,
): Promise<ConsumeArraySubmissionResult<T>> {
  const incoming = await tryConsumeSubmission<unknown>(artifactsDir, lane, tx);
  if (incoming.status === "absent") return { status: "absent" };
  if (incoming.status === "malformed") {
    const quarantine = await quarantineSubmissionFile(
      artifactsDir,
      incoming.path,
      lane,
    );
    await recordLaneOutcome(artifactsDir, lane, {
      kind: "rejected",
      issueCode: "submission_malformed",
      message: incoming.reason + quarantineSurvivalNote(quarantine),
    });
    return {
      status: "quarantined",
      quarantinePath: quarantine.quarantinePath,
      lane,
      reason: incoming.reason,
    };
  }
  const { value, path } = incoming;
  const unwrapped = unwrapSubmissionArray(value);
  if (unwrapped.ok) {
    return { status: "ok", value: unwrapped.array as T[], path };
  }
  const quarantine = await quarantineSubmissionFile(artifactsDir, path, lane);
  await recordLaneOutcome(artifactsDir, lane, {
    kind: "rejected",
    issueCode: "submission_contract_invalid",
    message: unwrapped.reason + quarantineSurvivalNote(quarantine),
  });
  return {
    status: "quarantined",
    quarantinePath: quarantine.quarantinePath,
    lane,
    reason: unwrapped.reason,
  };
}

type ConsumeObjectSubmissionResult =
  | { status: "absent" }
  | { status: "ok"; value: Record<string, unknown>; path: string }
  | {
      status: "quarantined";
      /** `null` when the copy to quarantine failed — see `QuarantineOutcome`. */
      quarantinePath: string | null;
      reason: string;
    };

/**
 * Read a lane submission expected to be a plain top-level object (a
 * key → value map, e.g. the analyzer decisions). A non-object value — null,
 * an array, a bare primitive — is quarantined with a stderr diagnostic rather
 * than left lingering at the bound path (where it used to make the emitting
 * step re-ask silently forever). An accepted file is NOT deleted here — the
 * caller unlinks after applying, so a crash mid-apply retains the submission
 * for the retry.
 */
export async function consumeObjectSubmission(
  artifactsDir: string,
  lane: string,
  tx?: FoldTransaction,
): Promise<ConsumeObjectSubmissionResult> {
  const incoming = await tryConsumeSubmission<unknown>(artifactsDir, lane, tx);
  if (incoming.status === "absent") return { status: "absent" };
  if (incoming.status === "malformed") {
    const quarantine = await quarantineSubmissionFile(
      artifactsDir,
      incoming.path,
      lane,
    );
    process.stderr.write(
      `[audit-code] ${lane} submission ${quarantineLocationPhrase(quarantine)}` +
        `${quarantineSurvivalNote(quarantine)}: ${incoming.reason}. ` +
        `Fix the JSON and resubmit.\n`,
    );
    await recordLaneOutcome(artifactsDir, lane, {
      kind: "rejected",
      issueCode: "submission_malformed",
      message: incoming.reason + quarantineSurvivalNote(quarantine),
    });
    return {
      status: "quarantined",
      quarantinePath: quarantine.quarantinePath,
      reason: incoming.reason,
    };
  }
  const { value, path } = incoming;
  if (isRecord(value)) {
    return { status: "ok", value, path };
  }
  const reason = describeSubmissionShapeMismatch(value);
  const quarantine = await quarantineSubmissionFile(artifactsDir, path, lane);
  process.stderr.write(
    `[audit-code] ${lane} submission ${quarantineLocationPhrase(quarantine)}` +
      `${quarantineSurvivalNote(quarantine)}: expected a JSON object, got ${reason}. ` +
      `Fix the shape and resubmit.\n`,
  );
  await recordLaneOutcome(artifactsDir, lane, {
    kind: "rejected",
    issueCode: "submission_contract_invalid",
    message: reason + quarantineSurvivalNote(quarantine),
  });
  return {
    status: "quarantined",
    quarantinePath: quarantine.quarantinePath,
    reason,
  };
}

/** The two decision vocabularies the operator-facing analyzer gates accept. */
const ANALYZER_CONSENT_VALUES = ["granted", "declined"] as const;
const ANALYZER_SETTING_VALUES = [
  "ephemeral",
  "permanent",
  "skip",
  "repo",
  "auto",
] as const;

/** Name the keys that carried no recognized value, for the ledger event. */
function describeIgnoredKeys(
  ignored: readonly string[],
  allowed: readonly string[],
): string {
  return (
    `ignored ${ignored.length} unrecognized entr${ignored.length === 1 ? "y" : "ies"} ` +
    `(${ignored.join(", ")}); recognized values are: ${allowed.join(", ")}`
  );
}

type ConsumeEnumMapResult<T extends string> =
  | { status: "absent" }
  | { status: "quarantined" }
  | {
      status: "ok";
      values: Record<string, T>;
      /** Keys whose value was not one of the recognized ones. */
      ignored: string[];
      path: string;
    };

/**
 * Read a decisions submission — a `{ "<id>": "<one of a fixed vocabulary>" }`
 * map — for the two operator-facing analyzer gates.
 *
 * The value-enum filter used to be per-gate, and both copies treated a
 * submission with ZERO recognized values as a SUCCESS: nothing was applied, the
 * file was deleted, and an `accepted` event went on the ledger, so a host that
 * answered in the wrong vocabulary had its answer destroyed, the run recorded
 * as clean, and the identical step re-emitted. A submission that says nothing
 * the gate understands is a refusal: it is quarantined (bytes kept), recorded
 * `rejected`, and re-asked. PARTIAL recognition still applies — the operator's
 * real decisions are not held hostage to one typo — with the ignored keys named
 * on the accepting event so the omission is on the record rather than in a
 * stderr line nobody kept.
 */
async function consumeEnumMapSubmission<T extends string>(
  artifactsDir: string,
  lane: string,
  allowed: readonly T[],
  tx?: FoldTransaction,
): Promise<ConsumeEnumMapResult<T>> {
  const incoming = await consumeObjectSubmission(artifactsDir, lane, tx);
  if (incoming.status === "absent") return { status: "absent" };
  if (incoming.status === "quarantined") return { status: "quarantined" };
  const values: Record<string, T> = {};
  const ignored: string[] = [];
  for (const [id, value] of Object.entries(incoming.value)) {
    if (allowed.includes(value as T)) {
      values[id] = value as T;
    } else {
      ignored.push(id);
    }
  }
  if (Object.keys(values).length > 0) {
    return { status: "ok", values, ignored, path: incoming.path };
  }
  const reason =
    `no recognized values (got: ${Object.keys(incoming.value).join(", ") || "(none)"}). ` +
    `Valid values are: ${allowed.join(", ")}.`;
  const quarantine = await quarantineSubmissionFile(
    artifactsDir,
    incoming.path,
    lane,
  );
  process.stderr.write(
    `[audit-code] ${lane} submission ${quarantineLocationPhrase(quarantine)}` +
      `${quarantineSurvivalNote(quarantine)}: ${reason} ` +
      `Fix the values and resubmit.\n`,
  );
  await recordLaneOutcome(artifactsDir, lane, {
    kind: "rejected",
    issueCode: "submission_contract_invalid",
    message: reason + quarantineSurvivalNote(quarantine),
  });
  return { status: "quarantined" };
}

// ── Edge-reasoning rejection marker ──────────────────────────────────────────
//
// graph_enrichment has no design_assessment-shaped bundle field to persist a
// rejection note on, so a quarantined edge-reasoning submission is recorded in
// a lightweight sibling marker file the re-emitted edge_reasoning step's
// prompt reads (the graph artifacts themselves are content-hashed — writing a
// note into them would churn the staleness DAG).

interface EdgeReasoningRejection {
  lane: string;
  /**
   * Where the refused submission was moved, and `null` when the copy to
   * quarantine failed so nothing was written there. Nullable in the PERSISTED
   * record too: a durable rejection that names a path holding no file is worse
   * than one that states plainly that the content was never moved.
   */
  quarantine_path: string | null;
  reason: string;
  rejected_at: string;
}

function edgeReasoningRejectionPath(artifactsDir: string): string {
  return join(artifactsDir, "quarantine", "edge-reasoning.rejection.json");
}

async function recordEdgeReasoningRejection(
  artifactsDir: string,
  rejection: EdgeReasoningRejection,
): Promise<void> {
  await mkdir(join(artifactsDir, "quarantine"), { recursive: true });
  await writeJsonFile(edgeReasoningRejectionPath(artifactsDir), rejection);
}

async function clearEdgeReasoningRejection(artifactsDir: string): Promise<void> {
  await unlink(edgeReasoningRejectionPath(artifactsDir)).catch(() => {});
}

/**
 * Render the host-facing notice for a pending quarantined edge-reasoning
 * submission, naming the quarantined file and the shape error — so the
 * re-emitted edge_reasoning step tells the host its prior submission was
 * rejected and why, rather than silently asking again. Returns `undefined`
 * when there is nothing to report.
 */
export async function renderEdgeReasoningRejectionNotice(
  artifactsDir: string,
): Promise<string | undefined> {
  let rejection: EdgeReasoningRejection;
  try {
    rejection = await readJsonFile<EdgeReasoningRejection>(
      edgeReasoningRejectionPath(artifactsDir),
    );
  } catch (error) {
    if (isFileMissingError(error)) return undefined;
    throw error;
  }
  return [
    "## Prior submission rejected",
    "",
    "Your last edge-reasoning submission did not match the expected shape and was " +
      "quarantined (not applied, not silently discarded). Fix the shape and resubmit:",
    "",
    `- lane \`${rejection.lane}\` ${describeQuarantineLocation(rejection.quarantine_path)} (${rejection.rejected_at}): ${rejection.reason}`,
    "",
    'Expected shape: {"rewrites":[{"from":"...","to":"...","kind":"...","reason":"..."}]} — ' +
      "a bare JSON array of rewrites is also accepted.",
  ].join("\n");
}

/**
 * Record a quarantined design-review submission.
 *
 * TWO homes, because they answer different questions and one of them can be
 * absent. `design_assessment.rejected_submissions` is what the re-emitted step
 * reads back to tell the host WHY its last submission was refused — so it is
 * written whenever there is an assessment to write it on. The submission ledger
 * is the durable record that a refusal happened at all, and it is written
 * unconditionally.
 *
 * This function used to open `if (!existing) return;`, which meant the one case
 * where a submission had no merge target — exactly the case where the host most
 * needs to be told something went wrong — recorded nothing anywhere. The
 * ledger closes that hole without inventing a partial `design_assessment.json`
 * for an assessment that does not exist yet: every quarantine reaches it, but
 * through the ONE site that performs the quarantine (`consumeArraySubmission`,
 * or `holdWithoutTarget` for the no-merge-target case), never a second append
 * here. Two appends per refusal made a single rejection read as two on a record
 * whose whole value is counting them.
 */
function withRejectedDesignReviewSubmission(
  existing: DesignAssessment | undefined,
  pass: RejectedDesignReviewSubmission["pass"],
  quarantined: Extract<
    ConsumeArraySubmissionResult<unknown>,
    { status: "quarantined" }
  >,
): DesignAssessment | undefined {
  if (!existing) return undefined;
  const entry: RejectedDesignReviewSubmission = {
    pass,
    lane: quarantined.lane,
    quarantine_path: quarantined.quarantinePath,
    reason: quarantined.reason,
    rejected_at: new Date().toISOString(),
  };
  // PURE rebuild — never a mutation of the carried assessment. Both derive
  // memos key on bundle identity, so an in-place edit would let an earlier
  // carry observe a later change (the aliasing hazard CX-02's record pins);
  // the persisted write is the fold's single core commit, not this site.
  return {
    ...existing,
    rejected_submissions: [
      ...(existing.rejected_submissions ?? []).filter((r) => r.pass !== pass),
      entry,
    ],
  };
}

/**
 * Render a host-facing notice for any pending quarantined design-review
 * submissions matching the given passes, naming the quarantined file and the
 * shape error — so a re-emitted design-review step tells the host its prior
 * submission was rejected and why, rather than silently asking again.
 * Returns `undefined` when there is nothing to report.
 */
export function renderDesignReviewRejectionNotice(
  bundle: ArtifactBundle,
  passes: readonly RejectedDesignReviewSubmission["pass"][],
): string | undefined {
  const rejected = (bundle.design_assessment?.rejected_submissions ?? []).filter((r) =>
    passes.includes(r.pass),
  );
  if (rejected.length === 0) return undefined;
  const lines = [
    "## Prior submission rejected",
    "",
    "Your last submission for this pass did not match the expected shape and was " +
      "quarantined (not merged, not silently discarded). Fix the shape and resubmit:",
    "",
  ];
  for (const r of rejected) {
    lines.push(
      `- **${r.pass}** — lane \`${r.lane}\` ${describeQuarantineLocation(r.quarantine_path)} (${r.rejected_at}): ${r.reason}`,
    );
  }
  lines.push(
    "",
    "Expected shape: a JSON array of findings, or a top-level object wrapping exactly " +
      'one array-valued property (e.g. `{"findings": [...]}`).',
  );
  return lines.join("\n");
}

export async function handleDesignReviewBranch(
  params: Pick<NextStepParams, "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<BranchActionResult> {
  // Working copies, replaced IMMUTABLY on every change — never a mutation of
  // the carried bundle's nested objects (the aliasing hazard the CX-02 record
  // pins: both derive memos key on bundle identity, and an in-place edit lets
  // an earlier carry observe a later change). `carried()` assembles the fresh
  // bundle every path hands back.
  let assessment = bundle.design_assessment;
  let snapshots = bundle.design_review_snapshots;
  const carried = (): ArtifactBundle => {
    const next: ArtifactBundle = { ...bundle };
    if (assessment !== undefined) next.design_assessment = assessment;
    if (snapshots !== undefined) next.design_review_snapshots = snapshots;
    return next;
  };

  /**
   * P25-f: a valid submission with nowhere to merge it is HELD and RECORDED,
   * never consumed-and-dropped. `design_assessment` is normally present by the
   * time this branch runs (`design_assessment_current` outranks both review
   * passes in PRIORITY) — but that is a reasoning argument, and the old code
   * relied on it: it deleted the file at unwrap time and then skipped the merge
   * on `&& existing`, destroying valid work and re-emitting the identical step
   * with zero signal to the host. Quarantining keeps the bytes and puts the
   * refusal on the record, so the next pass can still use them.
   */
  const holdWithoutTarget = async (
    pass: RejectedDesignReviewSubmission["pass"],
    lane: string,
    path: string,
  ): Promise<void> => {
    const reason = "no design assessment exists yet to merge this submission into";
    const quarantine = await quarantineSubmissionFile(
      params.artifactsDir,
      path,
      lane,
    );
    process.stderr.write(
      `[audit-code] ${lane} submission ${quarantineLocationPhrase(quarantine)}` +
        `${quarantineSurvivalNote(quarantine)}: no design ` +
        `assessment exists yet to merge it into. Re-run next-step; the assessment is ` +
        `built by a higher-priority obligation.\n`,
    );
    // The ledger append belongs to the site that performs the quarantine — this
    // is the one quarantine `consumeArraySubmission` does not do — so a refusal
    // is recorded exactly once no matter which path refused it. With no
    // assessment on disk there is no `rejected_submissions` note to write, and
    // this event is the only durable record that the submission was received.
    await recordLaneOutcome(params.artifactsDir, lane, {
      kind: "rejected",
      issueCode: "submission_rejected",
      message: `${pass} pass: ${reason}` + quarantineSurvivalNote(quarantine),
    });
    assessment =
      withRejectedDesignReviewSubmission(assessment, pass, {
        status: "quarantined",
        quarantinePath: quarantine.quarantinePath,
        lane,
        reason,
      }) ?? assessment;
  };

  // Legacy: consume the old combined findings submission. Tolerant-unwrap or
  // quarantine (never a bare unconditional delete) — see the block comment above.
  const legacyResult = await consumeArraySubmission<Finding>(
    params.artifactsDir,
    GATE_LANES.design_review_legacy,
    tx,
  );
  if (legacyResult.status === "quarantined") {
    assessment =
      withRejectedDesignReviewSubmission(assessment, "legacy", legacyResult) ??
      assessment;
    return { action: "continue", bundle: carried() };
  }
  if (legacyResult.status === "ok") {
    if (assessment) {
      assessment = {
        ...assessment,
        review_findings: groundDesignFindings(legacyResult.value, bundle.repo_manifest),
        reviewed: true,
        rejected_submissions: (assessment.rejected_submissions ?? []).filter(
          (r) => r.pass !== "legacy",
        ),
      };
      markSubmissionApplied(tx, legacyResult.path);
      return { action: "continue", bundle: carried() };
    }
    await holdWithoutTarget("legacy", GATE_LANES.design_review_legacy, legacyResult.path);
    return { action: "continue", bundle: carried() };
  }
  // absent: fall through to the contract/conceptual check.

  // New: consume contract-findings and/or conceptual-findings independently.
  const contractResult = await consumeArraySubmission<Finding>(
    params.artifactsDir,
    GATE_LANES.design_review_contract,
    tx,
  );
  const conceptualResult = await consumeArraySubmission<Finding>(
    params.artifactsDir,
    GATE_LANES.design_review_conceptual,
    tx,
  );

  let consumed = false;

  if (contractResult.status === "quarantined") {
    assessment =
      withRejectedDesignReviewSubmission(assessment, "contract", contractResult) ??
      assessment;
  } else if (contractResult.status === "ok" && assessment) {
    assessment = {
      ...assessment,
      contract_findings: groundDesignFindings(contractResult.value, bundle.repo_manifest),
      contract_reviewed: true,
      rejected_submissions: (assessment.rejected_submissions ?? []).filter(
        (r) => r.pass !== "contract",
      ),
    };
    consumed = true;
  } else if (contractResult.status === "ok") {
    await holdWithoutTarget(
      "contract",
      GATE_LANES.design_review_contract,
      contractResult.path,
    );
  }

  if (conceptualResult.status === "quarantined") {
    assessment =
      withRejectedDesignReviewSubmission(assessment, "conceptual", conceptualResult) ??
      assessment;
  } else if (conceptualResult.status === "ok" && assessment) {
    assessment = {
      ...assessment,
      conceptual_findings: groundDesignFindings(conceptualResult.value, bundle.repo_manifest),
      conceptual_reviewed: true,
      rejected_submissions: (assessment.rejected_submissions ?? []).filter(
        (r) => r.pass !== "conceptual",
      ),
    };
    consumed = true;
  } else if (conceptualResult.status === "ok") {
    await holdWithoutTarget(
      "conceptual",
      GATE_LANES.design_review_conceptual,
      conceptualResult.path,
    );
  }

  if (consumed && assessment) {
    // Snapshot each just-completed pass (B2 parity port): record the verdict +
    // the semantic projection of the structural inputs it reviewed, so a later
    // upstream change re-stales the pass and the re-emit can be diff-scoped
    // rather than a blind full re-run. The snapshot VALUE rides the carried
    // bundle (so this fold's own staleness derivation sees the pass fresh) and
    // its WRITE is staged on the transaction, committing WITH the core — a
    // snapshot lost between fold and commit would silently mark a completed
    // pass satisfied (CX-02 landing 2).
    const reviewedAt = new Date().toISOString();
    if (contractResult.status === "ok") {
      const snapshot = buildDesignReviewSnapshot(
        "contract",
        assessment.contract_findings ?? [],
        carried(),
        reviewedAt,
      );
      tx.pendingSnapshots.push(snapshot);
      snapshots = { ...(snapshots ?? {}), contract: snapshot };
      markSubmissionApplied(tx, contractResult.path);
    }
    if (conceptualResult.status === "ok") {
      const snapshot = buildDesignReviewSnapshot(
        "conceptual",
        assessment.conceptual_findings ?? [],
        carried(),
        reviewedAt,
      );
      tx.pendingSnapshots.push(snapshot);
      snapshots = { ...(snapshots ?? {}), conceptual: snapshot };
      markSubmissionApplied(tx, conceptualResult.path);
    }
    return { action: "continue", bundle: carried() };
  }

  // Determine which passes still need to run. A completed pass whose snapshot has
  // gone stale (a structural input changed in projection) is NOT done — it must
  // re-run as a diff-based re-review. This mirrors the obligation staleness in
  // `designReviewPassState`. Checked against the CARRIED bundle so a rejection
  // note recorded above reaches the re-emitted step's renderer.
  const current = carried();
  const contractDone =
    current.design_assessment?.contract_reviewed === true &&
    !passIsStale(current, "contract");
  const conceptualDone =
    current.design_assessment?.conceptual_reviewed === true &&
    !passIsStale(current, "conceptual");

  if (!contractDone && !conceptualDone) {
    return { action: "return", result: { kind: "design_review_parallel", state, bundle: current } };
  }
  if (!contractDone) {
    return { action: "return", result: { kind: "design_review_contract", state, bundle: current } };
  }
  if (!conceptualDone) {
    return { action: "return", result: { kind: "design_review_conceptual", state, bundle: current } };
  }

  // Both done — should not normally reach here (obligations would be satisfied).
  return { action: "continue", bundle: current };
}

// ── Tier C2: consolidated "omittable host gate" engine ─────────────────────────
//
// Five of the seven host-gate branch handlers below share ONE shape: poll a
// single lane's bound submission; if present, apply it via runAuditStep and
// `continue`; else, if a ceiling/flag says no host turn is owed this pass,
// `run_omit` (so the deterministic omit executor satisfies the obligation);
// else `return` the one host step this gate ever emits. `runOmittableGate`
// below is the single parameterized driver for that shape; each handler is a
// thin descriptor naming its filename, its apply side effect, and its
// omission predicate — the actual judgment (which ceiling, which flag, which
// step) still lives per-gate, just no longer copy-pasted 5×.
//
// graph_enrichment and design_review do NOT fit this shape and are
// intentionally NOT routed through `runOmittableGate` — forcing them in would
// paper over real differences rather than carry them:
//   - graph_enrichment polls TWO independent lane submissions in sequence, each
//     gated by its own "is a decision still owed" predicate CHECKED BEFORE
//     attempting to consume (the opposite order from the shape above, which
//     always tries to consume first, ceiling-check second). Its stage-1 apply
//     is `persistAnalyzerSettings` + a value-validation stderr diagnostic, not
//     a `runAuditStep` dispatch; its "nothing to do" terminal state is named
//     `fallthrough`, not `run_omit` (same caller-side effect, kept as its own
//     literal so `handleGraphEnrichmentBranch`'s existing action union — and
//     the tests asserting `"fallthrough"` — stay untouched).
//   - design_review polls THREE lane submissions: a legacy one handled and
//     returned on its own first, then two (contract/conceptual) polled
//     INDEPENDENTLY of each other (both are checked and, if valid, applied —
//     not first-match-wins) and merged into a single write plus a
//     per-just-applied-pass snapshot capture; its final decision picks one of
//     THREE step kinds off TWO independent booleans, not one ceiling check
//     against one step kind. There is no `run_omit` branch at all — an
//     unsatisfied pass always returns a host step, never an autonomous omit.

/** The common action shape all four `runOmittableGate`-driven branches return. */
type OmittableGateAction<TStepKind extends string> =
  | {
      /** A submission was consumed + applied; keep folding on the carried bundle. */
      action: "continue";
      bundle: ArtifactBundle;
    }
  | { action: "run_omit" }
  | { action: "return"; result: { kind: TStepKind; state: AuditState; bundle: ArtifactBundle } };

type CriticalFlowFallbackBranchResult = OmittableGateAction<"critical_flow_fallback">;
type IntentEquivalenceBranchResult = OmittableGateAction<"intent_equivalence">;
type SynthesisNarrativeBranchResult = OmittableGateAction<"synthesis_narrative">;
type CharterExtractionBranchResult = OmittableGateAction<"charter_extraction">;
type CharterDeltaBranchResult = OmittableGateAction<"charter_delta">;
type CharterClarificationBranchResult = OmittableGateAction<"charter_clarification">;
type SystemicChallengeBranchResult = OmittableGateAction<"systemic_challenge">;

interface OmittableGateDescriptor<TIncoming, TStepKind extends string> {
  /** The step kind this gate returns when a host turn is owed. */
  kind: TStepKind;
  /** The lane whose bound submission path this gate polls. */
  lane: string;
  /**
   * Schema the consumed submission MUST satisfy before it is applied. REQUIRED —
   * the compiler enumerates every gate so a new one cannot forget it. A mis-shaped
   * submission is quarantined loudly (moved to `quarantine/`, stderr diagnostic
   * naming the lane + shape error) and the gate falls through to shouldOmit/return;
   * it is NEVER handed to the executor to crash on (raw `.parse()`) or silently
   * degrade (bare cast). Single-sources the quarantine-loudly property for every
   * gate this engine drives.
   */
  schema: ZodTypeAny;
  /**
   * Apply the consumed value: the LOCK-FREE forced single-step dispatch this
   * gate's host turn feeds, run against the fold's carried bundle. Returns the
   * advance result so the fold transitions on `updated_bundle` — a disk reload
   * here would read the fold's own unwritten state and roll it back.
   */
  apply: (
    value: TIncoming,
    path: string,
    params: Pick<NextStepParams, "root" | "artifactsDir">,
    bundle: ArtifactBundle,
    staged: { contentHash?: string },
  ) => Promise<AdvanceAuditResult>;
  /**
   * True when no host turn is owed this pass — the caller should run the
   * deterministic omit executor instead of surfacing the step. Evaluated only
   * when nothing was consumed; may itself encode several sequential checks
   * (charter_clarification and systemic_challenge each fold 2-3 short-circuit
   * checks into this one predicate — behavior-identical to evaluating them in
   * sequence, since none of them has a side effect).
   */
  shouldOmit: (bundle: ArtifactBundle) => boolean;
}

/**
 * Drive one "poll the lane → apply+continue, else omit-or-return" gate — the
 * shape common to synthesis_narrative, charter_extraction,
 * charter_clarification, and systemic_challenge. See the section comment
 * above for the two gates that deviate and are not run through this engine.
 */
async function runOmittableGate<TIncoming, TStepKind extends string>(
  descriptor: OmittableGateDescriptor<TIncoming, TStepKind>,
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<OmittableGateAction<TStepKind>> {
  const incoming = await tryConsumeSubmission<unknown>(
    params.artifactsDir,
    descriptor.lane,
    tx,
  );
  if (incoming.status === "malformed") {
    // Not-JSON submission: same quarantine-loudly lifecycle as a mis-shaped one.
    await quarantineMisshapedSubmission(
      params.artifactsDir,
      incoming.path,
      descriptor.lane,
      incoming.reason,
    );
  } else if (incoming.status === "ok") {
    const parsed = descriptor.schema.safeParse(incoming.value);
    if (parsed.success) {
      const applied = await descriptor.apply(
        parsed.data as TIncoming,
        incoming.path,
        params,
        bundle,
        { contentHash: incoming.contentHash },
      );
      // Deletion + the accepted event commit WITH the core write; a throw
      // between here and the commit restores the staged submission instead.
      markSubmissionApplied(tx, incoming.path);
      return { action: "continue", bundle: applied.updated_bundle };
    }
    // Mis-shaped submission: quarantine loudly and fall through to
    // shouldOmit/return — never hand it to the executor to crash on or silently
    // treat as an empty "reviewed, found nothing" result.
    await quarantineMisshapedSubmission(
      params.artifactsDir,
      incoming.path,
      descriptor.lane,
      parsed.error,
    );
  }
  if (descriptor.shouldOmit(bundle)) {
    return { action: "run_omit" };
  }
  return { action: "return", result: { kind: descriptor.kind, state, bundle } };
}

/**
 * Handle the `synthesis_narrative_executor` submission-polling block.
 * Returns:
 *   - `continue`  → a narrative submission was consumed + applied (progress
 *     made); re-scan on the reloaded bundle.
 *   - `return`    → a host turn is still needed (narrative enabled, none supplied
 *     yet); emit the synthesis_narrative step.
 *   - `run_omit`  → narrative disabled; run the deterministic omit executor (it
 *     writes the `status:omitted` marker, satisfying synthesis_narrative_current).
 *     This MUST make progress, never a no-op reload — otherwise the obligation
 *     stays actionable and the fold spins (the guards do not cover this branch).
 */
export async function handleSynthesisNarrativeBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "narrativeEnabled">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<SynthesisNarrativeBranchResult> {
  return runOmittableGate<SynthesisNarrative, "synthesis_narrative">(
    {
      kind: "synthesis_narrative",
      lane: GATE_LANES.synthesis_narrative,
      schema: LANE_SUBMISSION_SCHEMAS[GATE_LANES.synthesis_narrative]!,
      apply: (_value, path, p, foldBundle) =>
        runAuditStepUnlocked(
          {
            root: p.root,
            artifactsDir: p.artifactsDir,
            preferredExecutor: "synthesis_narrative_executor",
            narrativeResultsPath: path,
          },
          foldBundle,
        ),
      // Narrative disabled: omit (run the deterministic omit executor below).
      // Single-sourced with the plan draw's classifier (obligationPolicy.ts).
      shouldOmit: () =>
        synthesisNarrativeOmits({ narrativeEnabled: params.narrativeEnabled }),
    },
    params,
    bundle,
    state,
    tx,
  );
}

/**
 * Handle the `intent_equivalence_executor` polling block (DD-9). Deviates from
 * `runOmittableGate` in ONE way: the consumed verdict is SCHEMA-validated here
 * and a mis-shaped submission is QUARANTINED with a stderr diagnostic (the
 * quarantine-loudly property) instead of being handed to the executor to crash
 * on. Returns:
 *   - `continue`  → a valid verdict was consumed + committed; re-scan.
 *   - `run_omit`  → a deterministic arm owns the resolution (baseline stamp /
 *     gate-version-stale / structured delta) — run the executor, stay drainable.
 *   - `return`    → a prose-only delta awaits the host judge; emit the step.
 */
export async function handleIntentEquivalenceBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<IntentEquivalenceBranchResult> {
  const lane = GATE_LANES.intent_equivalence;
  const incoming = await tryConsumeSubmission<unknown>(params.artifactsDir, lane, tx);
  if (incoming.status === "malformed") {
    await quarantineMisshapedSubmission(
      params.artifactsDir,
      incoming.path,
      lane,
      incoming.reason,
    );
    // Fall through: no valid submission — re-emit or deterministically resolve.
  } else if (incoming.status === "ok") {
    const parsed = LANE_SUBMISSION_SCHEMAS[lane]!.safeParse(incoming.value);
    if (parsed.success) {
      const applied = await runAuditStepUnlocked(
        {
          root: params.root,
          artifactsDir: params.artifactsDir,
          preferredExecutor: "intent_equivalence_executor",
          intentEquivalenceVerdictPath: incoming.path,
        },
        bundle,
      );
      markSubmissionApplied(tx, incoming.path);
      return { action: "continue", bundle: applied.updated_bundle };
    }
    await quarantineMisshapedSubmission(
      params.artifactsDir,
      incoming.path,
      lane,
      parsed.error,
    );
    // Fall through: no valid submission — re-emit or deterministically resolve.
  }
  // Single-sourced with the plan draw's classifier (obligationPolicy.ts).
  if (intentEquivalenceOmits(bundle)) {
    return { action: "run_omit" };
  }
  return { action: "return", result: { kind: "intent_equivalence", state, bundle } };
}

/**
 * Handle the `critical_flow_fallback_executor` submission-polling block.
 * The obligation is only ever selected when the deterministic flow inference
 * marked itself below the confidence bar (`critical_flows.fallback_required`),
 * so — unlike the synthesis-narrative / charter gates — there is NO autonomous
 * omit: the host (always the LLM, conversation-first) is expected to author the
 * enrichment. Returns:
 *   - `continue`  → a submission file was consumed + persisted; re-scan (structure
 *     then re-stales + rebuilds critical_flows off the merged flows).
 *   - `return`    → no submission yet; emit the critical_flow_fallback host step.
 * `run_omit` is never returned (shouldOmit is constant-false).
 */
export async function handleCriticalFlowFallbackBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<CriticalFlowFallbackBranchResult> {
  return runOmittableGate<CriticalFlowFallbackResult, "critical_flow_fallback">(
    {
      kind: "critical_flow_fallback",
      lane: GATE_LANES.critical_flow_fallback,
      schema: LANE_SUBMISSION_SCHEMAS[GATE_LANES.critical_flow_fallback]!,
      apply: (_value, path, p, foldBundle) =>
        runAuditStepUnlocked(
          {
            root: p.root,
            artifactsDir: p.artifactsDir,
            preferredExecutor: "critical_flow_fallback_executor",
            criticalFlowFallbackResultsPath: path,
          },
          foldBundle,
        ),
      // Never omit: the obligation is only reached when the deterministic bar
      // failed, and the host is always available to author the enrichment.
      shouldOmit: () => false,
    },
    params,
    bundle,
    state,
    tx,
  );
}

/**
 * Handle the `charter_extraction_executor` submission-polling block
 * (Phase C). Mirrors the synthesis-narrative branch:
 *   - every per-kind lane present and valid → assemble+gate the merge via the
 *     preferred executor (ingest), then `continue`;
 *   - otherwise a `shallow` ceiling → `run_omit` (the deterministic executor
 *     writes an empty `status:omitted` register — the conversation-first default,
 *     no host turn);
 *   - a `deep`/`deepest` ceiling with no submission yet → `return` the host step
 *     that renders the charter-extraction prompt.
 */
export async function handleCharterExtractionBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<CharterExtractionBranchResult> {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  // Shallow ceiling (default): omit deterministically, no host turn, no lanes.
  // Single-sourced with the plan draw's classifier (obligationPolicy.ts).
  if (charterExtractionOmits(bundle)) {
    return { action: "run_omit" };
  }
  // Per-kind blind lanes (design resolution 2): one submission file per kind,
  // each validated at THIS chokepoint — schema shape + kind purity (a lane may
  // only carry its own kind; anything else is a mis-routed submission) + scope
  // grounding (design resolution 4: every teleology node's file scope must be
  // repo paths — a lane citing files the repo does not contain is refused
  // whole, naming them, never silently narrowed). An invalid lane is
  // quarantined loudly and the step re-emits naming it; valid lanes stay on
  // disk untouched (K-of-N resume), and only when EVERY lane is present and
  // valid does the tool merge them into the single submission the executor
  // ingests (`assembleCharters` joins teleologies by file-set overlap).
  const kinds = charterExtractionKindsForCeiling(ceiling);
  const universe = new Set(
    (bundle.repo_manifest?.files ?? []).map((file) => file.path),
  );
  const laneValues = new Map<CharterKind, { value: CharterSubmission; path: string }>();
  let quarantinedAny = false;
  for (const kind of kinds) {
    const lane = charterExtractionLane(kind);
    // Staged per lane; an INCOMPLETE set is restored to its bound paths at
    // commit (un-applied), which is exactly the K-of-N resume the design
    // wants — pending lanes survive on disk until every lane is present.
    const incoming = await tryConsumeSubmission<unknown>(params.artifactsDir, lane, tx);
    if (incoming.status === "absent") continue;
    if (incoming.status === "malformed") {
      quarantinedAny = true;
      await quarantineMisshapedSubmission(
        params.artifactsDir,
        incoming.path,
        lane,
        incoming.reason,
      );
      continue;
    }
    const parsed = charterLaneSchema(kind, universe).safeParse(incoming.value);
    if (parsed.success) {
      laneValues.set(kind, { value: parsed.data as CharterSubmission, path: incoming.path });
    } else {
      quarantinedAny = true;
      await quarantineMisshapedSubmission(
        params.artifactsDir,
        incoming.path,
        lane,
        parsed.error,
      );
    }
  }
  if (!quarantinedAny && laneValues.size === kinds.length) {
    // Complete + valid: tool-side merge (stable by lane order = canonical kind
    // order), then one executor ingest; unlink lane files only after apply.
    // The post-apply unlink is the standard consumed-submission lifecycle
    // (every gate unlinks after a successful apply) — K-of-N persistence
    // applies only WHILE lanes are pending. Leaving consumed lane files behind
    // would make a later staleness-triggered re-extraction read them as fresh
    // results and silently skip re-authoring.
    const merged: CharterSubmission = {
      nodes: kinds.flatMap((kind) => laneValues.get(kind)!.value.nodes),
    };
    // The merged submission is TOOL-written, so it lives with the other lane
    // assets rather than under `submissions/` (which holds only what a host
    // wrote). It is handed to the executor by path and deleted after ingest.
    const mergedPath = join(
      laneAssetsDir(params.artifactsDir),
      CHARTER_EXTRACTION_MERGED_FILENAME,
    );
    await writeJsonFile(mergedPath, merged);
    const applied = await runAuditStepUnlocked(
      {
        root: params.root,
        artifactsDir: params.artifactsDir,
        preferredExecutor: "charter_extraction_executor",
        charterSubmissionPath: mergedPath,
      },
      bundle,
    );
    await unlink(mergedPath).catch(() => {});
    for (const lane of laneValues.values()) {
      // Deletion + accepted events commit WITH the core write (lane.path is
      // the STAGED file — a throw before the commit restores every lane).
      markSubmissionApplied(tx, lane.path);
    }
    // Evidence packets are consumed inputs like the lane submissions — a stale
    // packet left behind would feed a later re-extraction yesterday's evidence.
    for (const kind of kinds) {
      await unlink(
        join(
          laneAssetsDir(params.artifactsDir),
          charterExtractionPacketFilename(kind),
        ),
      ).catch(() => {});
    }
    return { action: "continue", bundle: applied.updated_bundle };
  }
  // Missing or quarantined lane(s): a host turn is still owed — the emitter
  // re-materializes only the missing lanes (completed lane results stay).
  return { action: "return", result: { kind: "charter_extraction", state, bundle } };
}

/**
 * Handle the `charter_delta_executor` submission-polling block (Phase C.2 —
 * the INDEPENDENT delta-miner). Mirrors the charter-extraction branch:
 *   - a pending `charter_delta` lane submission → route+gate it via the preferred
 *     executor (ingest), then `continue`;
 *   - otherwise, when the register is NOT `deltas_pending` (extraction omitted, or
 *     found no subsystems to mine) → `run_omit` (the deterministic executor settles
 *     the register — no host turn);
 *   - a `deltas_pending` register with no submission yet → `return` the host step
 *     that renders the charter-delta prompt for the independent miner.
 */
export async function handleCharterDeltaBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<CharterDeltaBranchResult> {
  return runOmittableGate<unknown, "charter_delta">(
    {
      kind: "charter_delta",
      lane: GATE_LANES.charter_delta,
      schema: LANE_SUBMISSION_SCHEMAS[GATE_LANES.charter_delta]!,
      apply: (_value, path, p, foldBundle) =>
        runAuditStepUnlocked(
          {
            root: p.root,
            artifactsDir: p.artifactsDir,
            preferredExecutor: "charter_delta_executor",
            charterDeltaSubmissionPath: path,
          },
          foldBundle,
        ),
      // Nothing to mine (extraction omitted or no subsystems): settle
      // deterministically, no host turn.
      shouldOmit: (b) => !(b.charter_register?.deltas_pending === true),
    },
    params,
    bundle,
    state,
    tx,
  );
}

/**
 * Handle the `charter_clarification_executor` obligation (Phase D triangulation
 * loop). Mirrors the charter-extraction branch, but the loop is DETERMINISTIC — the
 * executor assembles asked/banked from the Phase-C `charter_register` deltas, so the
 * host turn only surfaces the VOI-ranked interactive queue for relay:
 *   - a pending `charter_clarification` lane submission (host answers) → assemble via
 *     the deterministic runner, then `continue`;
 *   - a `shallow` ceiling OR zero attention → `run_omit` (the runner writes the
 *     register autonomously — every question banks as a finding, no host turn);
 *   - a `deep`/`deepest` ceiling WITH attention > 0 that has NOT yet produced a
 *     register → `run_omit` first to COMPUTE the loop (partition/rank/gate/split);
 *   - once the register exists with ≥1 interactive `asked` question and no answers
 *     yet → `return` the host step that relays the VOI queue.
 */
export async function handleCharterClarificationBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<CharterClarificationBranchResult> {
  return runOmittableGate<unknown, "charter_clarification">(
    {
      kind: "charter_clarification",
      lane: GATE_LANES.charter_clarification,
      schema: LANE_SUBMISSION_SCHEMAS[GATE_LANES.charter_clarification]!,
      apply: (_value, path, p, foldBundle) =>
        runAuditStepUnlocked(
          {
            root: p.root,
            artifactsDir: p.artifactsDir,
            preferredExecutor: "charter_clarification_executor",
            clarificationAnswersPath: path,
          },
          foldBundle,
        ),
      // The omit predicate is single-sourced with the plan draw's classifier
      // (obligationPolicy.ts) — the two draws must agree on the boundary.
      shouldOmit: charterClarificationOmits,
    },
    params,
    bundle,
    state,
    tx,
  );
}

/**
 * Handle the `systemic_challenge_executor` obligation (Phase E — the second-order
 * adversary loop-until-dry pass). Mirrors the charter-clarification branch:
 *   - a pending `systemic_challenge` lane submission (an adversary round's findings) →
 *     fold it via the deterministic runner, then `continue`;
 *   - a `shallow` ceiling → `run_omit` (the runner writes an omitted register
 *     autonomously, no host turn);
 *   - a `deep`/`deepest` ceiling that has NOT yet produced a register → `run_omit`
 *     first to compute the metrics digest + open the loop;
 *   - once the register exists and has NOT converged → `return` the host step that
 *     dispatches the next adversary round.
 * A converged register satisfies the obligation, so this branch is never reached for
 * it (the priority scan skips a satisfied obligation).
 */
export async function handleSystemicChallengeBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
  tx: FoldTransaction,
): Promise<SystemicChallengeBranchResult> {
  return runOmittableGate<unknown, "systemic_challenge">(
    {
      kind: "systemic_challenge",
      lane: GATE_LANES.systemic_challenge,
      schema: LANE_SUBMISSION_SCHEMAS[GATE_LANES.systemic_challenge]!,
      apply: (_value, path, p, foldBundle, staged) =>
        runAuditStepUnlocked(
          {
            root: p.root,
            artifactsDir: p.artifactsDir,
            preferredExecutor: "systemic_challenge_executor",
            systemicChallengePath: path,
            // The iterative-fold duplicate guard: the executor's register
            // records every folded submission's content hash and IGNORES a
            // duplicate, so a crash-restored already-folded round can never
            // read as a quiet round and converge the adversary loop falsely.
            systemicChallengeSubmissionHash: staged.contentHash,
          },
          foldBundle,
        ),
      // Single-sourced with the plan draw's classifier (obligationPolicy.ts).
      shouldOmit: systemicChallengeOmits,
    },
    params,
    bundle,
    state,
    tx,
  );
}

/**
 * Execute one deterministic audit step and record its progress. Throws (with
 * cause) if the executor fails, preserving the existing throw-with-cause
 * pattern. `index` is the 0-based deterministic-dispatch ordinal of this fold
 * call, surfaced as the 1-based `iteration` in the
 * `deterministic-progress.json` marker a filesystem-watching host reads
 * (semantics stated in the marker-protocol note on the fold driver: under one
 * drain it counts DISPATCHES of this call, no longer outer transitions).
 *
 * The dispatch is `runSingleAdvanceStep` on the fold's CARRIED bundle — one
 * step, no lock (the fold holds the one lock), no persist (the fold commits
 * once), no reload (disk holds the fold's pre-state). Failure attribution is
 * dispatch-local: a single step's failing identity IS its selection, recorded
 * on `failureRef` so the fold's commit-on-throw persists it without a second
 * lock acquisition (the deleted O2 RMW).
 */
export async function executeAndRecord(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "externalAcquisition" | "since">,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  decision: ReturnType<typeof decideNextStep>,
  index: number,
  lastSummary: string,
  bundle: ArtifactBundle,
  ctx: {
    manifestIndexCache: WeakMap<object, { lineIndex?: Record<string, number>; sizeIndex?: Record<string, number> }>;
    failureRef: { value: { executor: string | null; obligation: string | null } | null };
  },
): Promise<AdvanceAuditResult> {
  try {
    // Write a "started" marker before execution so a host watching the filesystem
    // can tell which executor is active during a long-running step (OBS-0d4c2311).
    const startedAt = new Date().toISOString();
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      executor: decision.selected_executor,
      obligation: decision.selected_obligation,
      status: "running",
      started_at: startedAt,
    });
    const indexes = await manifestIndexes(params.root, bundle, ctx.manifestIndexCache);
    const result = await runSingleAdvanceStep(bundle, {
      root: params.root,
      artifactsDir: params.artifactsDir,
      analyzers,
      graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
      externalAcquisition: params.externalAcquisition,
      since: params.since,
      lineIndex: indexes.lineIndex,
      sizeIndex: indexes.sizeIndex,
    });
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      last_executor: result.selected_executor,
      last_obligation: decision.selected_obligation,
      progress_made: result.progress_made,
      summary: result.progress_summary,
      status: "complete",
      started_at: startedAt,
      timestamp: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    // Dispatch-local attribution: this call ran ONE step, so its selection is
    // the failing identity; `findExecutorFailure` still reads a wrapped
    // `ExecutorFailure` when the runner threw one (a forced nested dispatch's
    // structured error contract survives).
    const failure = findExecutorFailure(error);
    const failedExecutor = failure?.executor ?? decision.selected_executor;
    const failedObligation = failure?.obligation ?? decision.selected_obligation;
    // The fold's commit-on-throw persists this attribution in the SINGLE core
    // commit — the old second lock acquisition here would deadlock against the
    // fold's own hold (`withFileLock` is non-reentrant).
    ctx.failureRef.value = { executor: failedExecutor, obligation: failedObligation };
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      last_executor: failedExecutor,
      last_obligation: failedObligation,
      // The obligation the fold selected for this dispatch, kept alongside the
      // failing one so the fold position stays reconstructable from the marker.
      selected_executor: decision.selected_executor,
      selected_obligation: decision.selected_obligation,
      prior_summary: lastSummary || null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Deterministic executor ${failedExecutor} failed on obligation ${failedObligation} (iteration ${index + 1}, prior progress: ${lastSummary || "none"}): ${detail}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/**
 * Line/size indexes for a dispatch, memoized on `repo_manifest` IDENTITY: the
 * fold dispatches many steps per call and `buildLineIndex` walks real files,
 * so recomputing per dispatch would regress the drain's cost profile; the
 * manifest object is replaced whenever intake re-derives it, which is exactly
 * when the indexes must be rebuilt.
 */
async function manifestIndexes(
  root: string,
  bundle: ArtifactBundle,
  cache: WeakMap<object, { lineIndex?: Record<string, number>; sizeIndex?: Record<string, number> }>,
): Promise<{ lineIndex?: Record<string, number>; sizeIndex?: Record<string, number> }> {
  const manifest = bundle.repo_manifest;
  if (!manifest) return {};
  const cached = cache.get(manifest);
  if (cached) return cached;
  const built = {
    lineIndex: await buildLineIndex(root, manifest),
    sizeIndex: sizeIndexFromManifest(manifest),
  };
  cache.set(manifest, built);
  return built;
}

// ── Cycle guards (kept in audit's Ctx; NOT routed through advance) ─────────────
//
// HANDOFF approach-B: the shared `advance` engine is inherently 0-tolerance (it
// signs `current` at the top of every loop and stops on the FIRST revisit), so it
// cannot express the finalization-cycle tolerance window or the no-metadata-skip
// the hand loop relied on. Approach A collapsed both guards into advance's
// `stateSignature` and false-tripped on a fresh-Linux floor-only chain. So the two
// guards stay HERE, invoked from inside the deterministic-executor obligation, and
// `advance` runs with no `stateSignature` (its `maxTransitions` is the pure
// runaway backstop only).

/**
 * Pre-dispatch no-progress guard (ARC-b8fed771).
 *
 * Runs BEFORE a deterministic executor is dispatched. If the fold is about to
 * re-dispatch the SAME executor for the SAME obligation from an artifact-state
 * signature it has ALREADY dispatched that exact (executor, obligation) pair
 * from this run, the prior dispatch left the content-state unchanged (same
 * signature) — so dispatching it again cannot make progress and would spin.
 * Stop the fold with a terminal step instead of re-dispatching.
 *
 * The dispatch IDENTITY (signature + executor + obligation), not the signature
 * alone, is the recurrence key. A recurring signature across DIFFERENT executors
 * is legitimate: no-op-but-satisfying steps (auto-fix with nothing to fix,
 * syntax-resolution with no errors) leave the artifact content unchanged while
 * still advancing the obligation chain — those must NOT trip the guard. Only a
 * literal re-entry of the same executor on the same unchanged state is the
 * infinite loop this catches.
 *
 * This is the immediate-recurrence complement to `checkFinalizationCycle` (the
 * post-dispatch tolerance-based thrash detector across many executors): this
 * guard refuses to re-enter the SAME executor on a state it already failed to
 * advance, rather than waiting for the tolerance window to fill. Returns a
 * terminal-step result when the guard fires, or undefined to proceed.
 *
 * `dispatchedSignatures` is mutated: the current dispatch identity is recorded
 * so a later iteration that returns to this exact (state, executor, obligation)
 * trips the guard.
 */
export async function checkNoProgressBeforeDispatch(ctx: {
  index: number;
  dispatchedSignatures: Set<string>;
  params: Pick<NextStepParams, "artifactsDir" | "root">;
  bundle: ArtifactBundle;
  state: AuditState;
  selectedObligation: string | null | undefined;
  selectedExecutor: string | null | undefined;
}): Promise<TerminalFoldIntent | undefined> {
  const signature = computeArtifactStateSignature(ctx.bundle);
  const dispatchKey = `${signature}|${ctx.selectedExecutor ?? ""}|${ctx.selectedObligation ?? ""}`;
  // "no-metadata" is the pre-artifact bootstrap state (no artifact_metadata yet
  // — e.g. before the first executor stamps any metadata). Many early
  // deterministic steps legitimately dispatch from it before metadata exists, so
  // it is not a no-progress signal; only a real, metadata-bearing signature
  // recurring for the SAME executor means an executor already ran here without
  // changing content.
  if (signature !== "no-metadata" && ctx.dispatchedSignatures.has(dispatchKey)) {
    await writeJsonFile(
      join(ctx.params.artifactsDir, "steps", "deterministic-progress.json"),
      {
        iteration: ctx.index + 1,
        no_progress_detected: true,
        repeated_obligation: ctx.selectedObligation ?? "unknown",
        repeated_executor: ctx.selectedExecutor ?? "unknown",
        summary:
          "Pre-dispatch no-progress guard: about to re-dispatch " +
          `${ctx.selectedExecutor ?? "an executor"} for obligation ` +
          `${ctx.selectedObligation ?? "unknown"} from an artifact state already ` +
          "dispatched this run without net progress; stopping instead of looping.",
        timestamp: new Date().toISOString(),
      },
    );
    // A terminal INTENT, not the built terminal: `buildTerminalStep` can
    // PROMOTE (which deletes artifactsDir), so it must run after the fold's
    // commit and outside its hold. The marker above is the in-fold record.
    return {
      kind: "terminal_intent",
      bundle: ctx.bundle,
      state: ctx.state,
      reason:
        "No-progress guard: a deterministic executor was about to re-run on an " +
        "artifact state it already processed this run without changing it " +
        `(obligation ${ctx.selectedObligation ?? "unknown"}, executor ` +
        `${ctx.selectedExecutor ?? "unknown"}). Stopping to avoid an infinite ` +
        "no-progress loop.",
    };
  }
  ctx.dispatchedSignatures.add(dispatchKey);
  return undefined;
}

/**
 * Check for a finalization cycle: when fold transitions outrun distinct artifact
 * states by FINALIZATION_CYCLE_TOLERANCE, the deterministic executors are
 * revisiting states rather than progressing. Returns a terminal-step result
 * when a cycle is detected, or undefined when the run is still progressing.
 */
export async function checkFinalizationCycle(ctx: {
  index: number;
  obligationTrail: string[];
  seenStateSignatures: Set<string>;
  tolerance: number;
  params: Pick<NextStepParams, "artifactsDir" | "root">;
  bundle: ArtifactBundle;
  state: AuditState;
  result: AdvanceAuditResult;
  selectedObligation: string | null | undefined;
}): Promise<TerminalFoldIntent | undefined> {
  ctx.obligationTrail.push(ctx.selectedObligation ?? "unknown");
  ctx.seenStateSignatures.add(computeArtifactStateSignature(ctx.result.updated_bundle));
  if (ctx.index + 1 - ctx.seenStateSignatures.size < ctx.tolerance) {
    return undefined;
  }
  const cycle = Array.from(
    new Set(ctx.obligationTrail.slice(-ctx.tolerance)),
  );
  await writeJsonFile(
    join(ctx.params.artifactsDir, "steps", "deterministic-progress.json"),
    {
      iteration: ctx.index + 1,
      cycle_detected: true,
      cycling_obligations: cycle,
      summary:
        "Finalization kept revisiting prior artifact states without net " +
        `progress; stopping. Cycling obligations: ${cycle.join(" -> ")}.`,
      timestamp: new Date().toISOString(),
    },
  );
  // Intent, not the built terminal — see checkNoProgressBeforeDispatch.
  return {
    kind: "terminal_intent",
    bundle: ctx.result.updated_bundle,
    state: ctx.result.audit_state,
    reason:
      "Finalization is not converging: deterministic executors kept revisiting " +
      `prior artifact states (${cycle.join(" -> ")}). Review whether these ` +
      "obligations are erroneously invalidating each other.",
  };
}

// ── advance engine binding ────────────────────────────────────────────────────

/**
 * Per-call execution dependencies threaded to every audit obligation executor.
 * Mirrors remediate-code's `RemediateCtx`: the shared engine stays agnostic;
 * audit-code picks its own `Ctx`. The refs carry the fold-local mutable state the
 * hand-rolled `for` loop kept in closures — the analyzer settings a decisions
 * file can update mid-fold, the last progress summary surfaced in the terminal
 * block, and the cycle-guard bookkeeping (transition counter + the no-progress /
 * finalization-cycle sets the two guards mutate).
 */
/**
 * The advisory payload one fold iteration classified but could not render: an
 * ingest that ends in a `transition` (accepted results for still-pending
 * tasks) returns before any emission, so its `validation_warnings` and
 * classified ingest `issues` would otherwise die with the outcome. The carry is
 * fold-local (a `{ value }` ref on {@link AuditNextStepCtx}), never persisted —
 * the ledger (`recordHostResultOutcomes`) remains the only durable record, and
 * this only defers the PROMPT statement of what it already recorded to the next
 * emission within the same call.
 */
interface FoldAdvisories {
  ingestIssues: AuditHostIngestIssue[];
  validationWarnings: AuditHostValidationWarning[];
}

const EMPTY_FOLD_ADVISORIES: FoldAdvisories = {
  ingestIssues: [],
  validationWarnings: [],
};

/**
 * Append one fold iteration's advisories to the pending carry. Dedupe by
 * identity signature keeps an issue the SAME ingest re-classifies on a later
 * iteration (it will, while the submission stays broken) from rendering twice;
 * the consuming drain ({@link takeFoldAdvisories}) is the once-per-emit half.
 */
function mergeFoldAdvisoriesInto(
  carried: FoldAdvisories,
  fresh: {
    readonly issues: readonly AuditHostIngestIssue[];
    readonly validationWarnings: readonly AuditHostValidationWarning[];
  },
): void {
  for (const issue of fresh.issues) {
    const signature = advisorySignature(issue);
    if (
      carried.ingestIssues.some((existing) => advisorySignature(existing) === signature)
    ) {
      continue;
    }
    carried.ingestIssues.push(issue);
  }
  for (const warning of fresh.validationWarnings) {
    const signature = advisorySignature(warning);
    if (
      carried.validationWarnings.some(
        (existing) => advisorySignature(existing) === signature,
      )
    ) {
      continue;
    }
    carried.validationWarnings.push(warning);
  }
}

/** Drain the carry: what the NEXT emission must state, now consumed. */
function takeFoldAdvisories(ref: { value: FoldAdvisories }): FoldAdvisories {
  const taken: FoldAdvisories = {
    ingestIssues: ref.value.ingestIssues,
    validationWarnings: ref.value.validationWarnings,
  };
  ref.value = {
    ingestIssues: [...EMPTY_FOLD_ADVISORIES.ingestIssues],
    validationWarnings: [...EMPTY_FOLD_ADVISORIES.validationWarnings],
  };
  return taken;
}

/** Content identity of one advisory, across both channels. */
function advisorySignature(
  advisory: AuditHostIngestIssue | AuditHostValidationWarning,
): string {
  const workItemId =
    "work_item_id" in advisory ? (advisory.work_item_id ?? "") : "";
  const code = "code" in advisory ? advisory.code : "warning";
  return `${code}|${workItemId}|${advisory.message}`;
}

interface AuditNextStepCtx {
  params: NextStepParams;
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined };
  lastSummaryRef: { value: string };
  /**
   * Advisories an ingest classified on a fold iteration that ended in a
   * `transition` (see {@link runHostDelegationObligation}): the transition
   * returns before any emission, and the next ingest skips already-accepted
   * bindings, so without this carry the warnings and that fold's classified
   * issues never reach the emitted prompt. The next semantic-review emit
   * merges + consumes them (once — see {@link mergeFoldAdvisories}).
   */
  foldAdvisoriesRef: { value: FoldAdvisories };
  /**
   * 0-based ordinal of DETERMINISTIC DISPATCHES this fold call has made — the
   * guards' `index` and the marker protocol's `iteration` source. Under the
   * one drain (CX-02, constraint-1 re-answer) the guards observe PER DISPATCH:
   * a policy body's transition mints no new artifact state, so it neither
   * counts nor signs. Incremented by `runDeterministicExecutor` after a
   * successful (transitioning) dispatch.
   */
  dispatchOrdinalRef: { value: number };
  /** Pre-dispatch no-progress guard state (ARC-b8fed771): dispatched identities. */
  dispatchedSignatures: Set<string>;
  /** Finalization-cycle guard state: distinct post-execute artifact signatures. */
  seenStateSignatures: Set<string>;
  /** Finalization-cycle guard state: obligation order, for the cycle report. */
  obligationTrail: string[];
  /** The fold's pending side effects, committed once at the boundary. */
  tx: FoldTransaction;
  /**
   * The last carried bundle — what the commit-on-throw persists. Maintained by
   * `trackFoldBundle` on every outcome, because a throw unwinds the engine
   * before it can return its state.
   */
  currentBundleRef: { value: ArtifactBundle };
  /** Dispatch-local failure attribution for the commit-on-throw. */
  failureRef: { value: { executor: string | null; obligation: string | null } | null };
  /** Per-manifest-identity line/size index memo (see `manifestIndexes`). */
  manifestIndexCache: WeakMap<
    object,
    { lineIndex?: Record<string, number>; sizeIndex?: Record<string, number> }
  >;
}

/** The engine state audit folds on: the in-memory CARRIED bundle (never reloaded). */
type AuditEngineState = ArtifactBundle;

/** What a fold obligation can emit: a host step, or a guard's terminal intent. */
type AuditFoldStep = NextStepResult | TerminalFoldIntent;

type AuditObligationDef = ObligationDef<
  AuditEngineState,
  AuditNextStepCtx,
  AuditFoldStep
>;

type AuditOutcome = ObligationOutcome<AuditEngineState, AuditFoldStep>;

/**
 * A deterministic-executor `emit` of a blocked step — the `!progress_made`
 * dead-end the hand loop returned directly from `executeAndRecord`.
 */
function blockedFromResult(result: AdvanceAuditResult): AuditOutcome {
  return {
    kind: "emit",
    step: {
      kind: "blocked",
      state: result.audit_state,
      bundle: result.updated_bundle,
      reason: result.progress_summary,
    },
    // The emit carries the advanced bundle so the fold's single commit
    // persists what this dispatch produced (audit_state included).
    state: result.updated_bundle,
  };
}

/**
 * Run one deterministic executor for the selected obligation, reproducing the
 * hand loop's normal-path arm: the pre-dispatch no-progress guard, then
 * record + dispatch, then the post-dispatch finalization-cycle guard. A guard
 * that fires `emit`s its terminal step (so `advance` returns it); a
 * `!progress_made` dead-end emits a blocked step; otherwise clear dispatch
 * staging and `transition` on the reloaded bundle so the fold continues.
 *
 * The two guards stay HERE (not in `advance.opts.stateSignature`) so the
 * no-metadata-skip and the FINALIZATION_CYCLE_TOLERANCE window are preserved —
 * see the cycle-guard section comment.
 */
async function runDeterministicExecutor(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  // Emit-off: the fold's driver emits ONE consolidated staleness record at its
  // boundary (the preserve-list contract), so no in-fold derivation may emit.
  const decision = decideNextStep(bundle, { emitStaleness: false });

  const noProgress = await checkNoProgressBeforeDispatch({
    index: ctx.dispatchOrdinalRef.value,
    dispatchedSignatures: ctx.dispatchedSignatures,
    params: ctx.params,
    bundle,
    state: decision.state,
    selectedObligation: decision.selected_obligation,
    selectedExecutor: decision.selected_executor,
  });
  if (noProgress !== undefined) {
    return { kind: "emit", step: noProgress, state: bundle };
  }

  const result = await executeAndRecord(
    ctx.params,
    ctx.analyzersRef.value,
    decision,
    ctx.dispatchOrdinalRef.value,
    ctx.lastSummaryRef.value,
    bundle,
    ctx,
  );
  ctx.lastSummaryRef.value = result.progress_summary;
  if (!result.progress_made) {
    return blockedFromResult(result);
  }

  const cycle = await checkFinalizationCycle({
    index: ctx.dispatchOrdinalRef.value,
    obligationTrail: ctx.obligationTrail,
    seenStateSignatures: ctx.seenStateSignatures,
    tolerance: FINALIZATION_CYCLE_TOLERANCE,
    params: ctx.params,
    bundle,
    state: decision.state,
    result,
    selectedObligation: decision.selected_obligation,
  });
  if (cycle !== undefined) {
    return { kind: "emit", step: cycle, state: result.updated_bundle };
  }

  // One counted, signed dispatch — the guards' unit (CX-02 constraint 1).
  ctx.dispatchOrdinalRef.value += 1;
  // The IN-MEMORY carry: the dispatch's own updated bundle, fresh identity by
  // construction. A disk reload here would read the fold's pre-state and
  // silently roll back everything the fold has done (persist-once).
  return { kind: "transition", state: result.updated_bundle };
}

/**
 * `derive` for an audit obligation: look up its precomputed satisfaction state
 * from `deriveAuditState` — the holistic content-hash staleness pass that
 * computes EVERY obligation's state in one scan (`state.ts`). A pruned/absent
 * obligation is satisfied. `decideNextStep`'s persisted-`complete` short-circuit
 * yields an all-satisfied scan (no actionable obligation), which `advance`
 * surfaces as `step === null` → the post-fold terminal.
 */
function deriveObligationState(
  id: string,
  cache: WeakMap<ArtifactBundle, AuditState>,
): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied" {
  return (bundle) => {
    if (bundle.audit_state?.status === "complete") return "satisfied";
    let state = cache.get(bundle);
    if (!state) {
      // MEMOIZED per bundle IDENTITY, exactly as the plan draw's namesake in
      // `orchestrator/advance.ts` is — and for the same reason. `advance` scans
      // by calling EVERY registered def's `derive`, so without this the fold
      // ran the holistic `deriveAuditState` once PER OBLIGATION per scan: 25
      // full staleness passes to answer one question (the regression
      // `6145a1a3` measured and memoized away).
      //
      // The key is safe for the same reason it is safe there: identity changes
      // at every transition (each one carries a fresh bundle), and the
      // `complete` gate above can only flip via a transition. So an entry can
      // never outlive the state it was derived under.
      //
      // EMIT-OFF, like every in-fold derivation (CX-02): the fold's DRIVER
      // emits the ONE consolidated staleness record at its boundary — the
      // preserve-list contract — so a derive that emitted per scan miss would
      // turn one call's cascade back into a record per carried bundle.
      state = deriveAuditState(bundle, { emitStaleness: false });
      cache.set(bundle, state);
    }
    const found = state.obligations.find((o) => o.id === id);
    if (!found) return "satisfied";
    return found.state === "missing" || found.state === "stale"
      ? found.state
      : "satisfied";
  };
}

/**
 * Build the audit obligation definitions in `PRIORITY` order. Each `execute`
 * relocates the corresponding arm of the hand-rolled `for` loop:
 * deterministic executors `transition` (fold), host-delegation / dispatch /
 * terminal points `emit` the host-actionable step. Selection stays single-sourced
 * (`deriveObligationState` reads `deriveAuditState`, and `decideNextStep` resolves
 * the executor for the selected id), so the obligation list cannot drift from the
 * priority scan it mirrors.
 */
export function buildAuditObligations(
): AuditObligationDef[] {
  // One memo per registry construction, shared by every def in it. Scoped to
  // the call so it dies with the fold it was built for, and keyed on bundle
  // identity so it cannot outlive a transition.
  const cache = new WeakMap<ArtifactBundle, AuditState>();

  // The 13 BESPOKE per-obligation host-boundary policy bodies — the content
  // the one registry carries beyond its PRIORITY-derived skeleton. Their
  // branch predicates are single-sourced with the plan draw's classifier
  // (`obligationPolicy.ts`), so the two draws agree on WHERE the boundary is;
  // what only this draw may do is CONSUME (stage/apply/quarantine) and EMIT.
  //
  // Every `emit` carries `state:` — the engine persists the outcome's state at
  // the fold's single commit, so an emit that advanced the bundle and omitted
  // it would silently roll its own work back. Every `transition` carries the
  // handler's returned bundle (an in-memory carry, never a disk reload).
  const bespoke: Readonly<Record<string, AuditObligationDef["execute"]>> = {
    // External analyzers: the Item B consent fold runs FIRST — applicable
    // consent-gated candidates with no recorded decision surface ONE batched
    // operator offer (or consume the arrived decisions file), and only then
    // does the deterministic acquisition executor run.
    external_analyzers_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleAnalyzerConsentBranch(
        ctx.params,
        bundle,
        state,
        ctx.analyzersRef,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "continue") {
        return { kind: "transition", state: bundle };
      }
      return runDeterministicExecutor(bundle, ctx);
    },
    // Critical-flow fallback: when deterministic flow inference fell below the
    // confidence bar, apply the host submission against the carried bundle or
    // emit the host step. No autonomous omit — the host is always available to
    // author the enrichment.
    critical_flow_fallback_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleCriticalFlowFallbackBranch(
        ctx.params,
        bundle,
        state,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        return runDeterministicExecutor(bundle, ctx);
      }
      return { kind: "transition", state: branch.bundle };
    },
    // Graph enrichment: poll the analyzer-decision / edge-reasoning lane
    // artifacts first (emit a host step when one is needed), otherwise run the
    // deterministic enrichment executor.
    graph_enrichment_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleGraphEnrichmentBranch(
        ctx.params,
        bundle,
        state,
        ctx.analyzersRef,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "continue") {
        return { kind: "transition", state: branch.bundle };
      }
      return runDeterministicExecutor(bundle, ctx);
    },
    // Confirm-intent host step: the host writes intent_checkpoint.json (read by
    // deriveAuditState on re-invocation), so there is no submission to
    // consume — emit the step directly.
    intent_checkpoint_current: async (bundle): Promise<AuditOutcome> => ({
      kind: "emit",
      step: {
        kind: "confirm_intent",
        state: deriveAuditState(bundle, { emitStaleness: false }),
        bundle,
      },
      state: bundle,
    }),
    // DD-9 intent-equivalence gate: consume a judge verdict (validated +
    // quarantined-loudly), resolve the deterministic arms in-fold, or emit the
    // bounded prose-equivalence judge step.
    intent_equivalence_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleIntentEquivalenceBranch(
        ctx.params,
        bundle,
        state,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        return runDeterministicExecutor(bundle, ctx);
      }
      return { kind: "transition", state: branch.bundle };
    },
    // Charter extraction (Phase C): consume the lane submissions (ingest+gate),
    // omit at a shallow ceiling, or emit the host charter-extraction step.
    charter_extraction_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleCharterExtractionBranch(
        ctx.params,
        bundle,
        state,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        return runDeterministicExecutor(bundle, ctx);
      }
      return { kind: "transition", state: branch.bundle };
    },
    // Charter delta-mining (Phase C.2): consume the delta lane submission,
    // settle deterministically when the register is not deltas_pending, or
    // emit the independent delta-miner's host step.
    charter_delta_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleCharterDeltaBranch(ctx.params, bundle, state, ctx.tx);
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        return runDeterministicExecutor(bundle, ctx);
      }
      return { kind: "transition", state: branch.bundle };
    },
    // The two design-review passes share one submission-poll handler (it
    // resolves which pass remains).
    design_review_contract_completed: (bundle, ctx) =>
      runDesignReviewObligation(bundle, ctx),
    design_review_conceptual_completed: (bundle, ctx) =>
      runDesignReviewObligation(bundle, ctx),
    // Charter clarification (Phase D triangulation loop).
    charter_clarification_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleCharterClarificationBranch(
        ctx.params,
        bundle,
        state,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        return runDeterministicExecutor(bundle, ctx);
      }
      return { kind: "transition", state: branch.bundle };
    },
    // Systemic challenge (Phase E loop-until-dry).
    systemic_challenge_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleSystemicChallengeBranch(
        ctx.params,
        bundle,
        state,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        return runDeterministicExecutor(bundle, ctx);
      }
      return { kind: "transition", state: branch.bundle };
    },
    // The audit-task dispatch obligation maps to the host-delegation
    // semantic_review_executor (no deterministic runner) → host review.
    audit_tasks_completed: (bundle, ctx) => runHostDelegationObligation(bundle, ctx),
    // Synthesis narrative: consume the narrative lane; emit the host step when
    // narrative is enabled and not yet supplied, otherwise the deterministic
    // omit runs (fold on).
    synthesis_narrative_current: async (bundle, ctx): Promise<AuditOutcome> => {
      const state = deriveAuditState(bundle, { emitStaleness: false });
      const branch = await handleSynthesisNarrativeBranch(
        ctx.params,
        bundle,
        state,
        ctx.tx,
      );
      if (branch.action === "return") {
        return { kind: "emit", step: branch.result, state: bundle };
      }
      if (branch.action === "run_omit") {
        // Narrative disabled: run the deterministic omit executor so the
        // status:omitted marker is written and the obligation is satisfied.
        return runDeterministicExecutor(bundle, ctx);
      }
      // continue: a narrative submission was consumed + applied — re-scan.
      return { kind: "transition", state: branch.bundle };
    },
  };

  // The registry's membership and order DERIVE from PRIORITY — never a second
  // hand-enumerated list, so an id cannot be in the scan and absent from the
  // registry (this derivation dissolved the fold-array⇄PRIORITY sync tests).
  // `friction_capture_current` gets a plain def and stays inert by absence:
  // `deriveAuditState` never emits it, so its derive is always satisfied.
  for (const id of Object.keys(bespoke)) {
    if (!PRIORITY.includes(id)) {
      throw new Error(
        `buildAuditObligations: bespoke policy body for "${id}" names an id absent from PRIORITY — the registry derives from PRIORITY, so this body could never run`,
      );
    }
  }
  return PRIORITY.map((id) => ({
    id,
    derive: deriveObligationState(id, cache),
    execute:
      bespoke[id] ??
      ((bundle: ArtifactBundle, ctx: AuditNextStepCtx) =>
        runDeterministicExecutor(bundle, ctx)),
  }));
}

/** Shared design-review-pass executor (both pass obligations route here). */
async function runDesignReviewObligation(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const state = deriveAuditState(bundle, { emitStaleness: false });
  const branch = await handleDesignReviewBranch(ctx.params, bundle, state, ctx.tx);
  if (branch.action === "return") {
    // The handler's carried bundle rides BOTH the step (the renderer reads the
    // rejection notes off it) and the emit's state (the commit persists them).
    return { kind: "emit", step: branch.result, state: branch.result.bundle };
  }
  return { kind: "transition", state: branch.bundle };
}

/**
 * Host-delegation dispatch obligation (`audit_tasks_completed` →
 * semantic_review_executor, no deterministic runner): materialize the semantic
 * review run and emit it. Guards on the executor actually being host-delegation,
 * mirroring the hand loop's `isHostDelegationExecutor` branch; a missing/non-
 * delegation executor emits the same blocked step the no-executor branch did.
 */
async function runHostDelegationObligation(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const decision = decideNextStep(bundle, { emitStaleness: false });
  const state = decision.state;
  if (!decision.selected_executor) {
    return emitNoExecutorBlocked(bundle, ctx, decision);
  }
  if (!isHostDelegationExecutor(decision.selected_executor)) {
    return runDeterministicExecutor(bundle, ctx);
  }

  // First fold every strictly-bound result that still belongs to the pending
  // set. Filtering against bundle truth makes crash recovery idempotent: an
  // accepted ledger written before core ingestion is retried, while results
  // already reflected in coverage are not replayed.
  const currentRun = await loadCurrentActiveReviewRun(ctx.params.artifactsDir);
  let ingestIssues: readonly AuditHostIngestIssue[] = [];
  let validationWarnings: readonly AuditHostValidationWarning[] = [];
  if (currentRun) {
    let acceptedResults: Awaited<
      ReturnType<typeof ingestAuditHostResults>
    >["accepted_results"] = [];
    let completedIds: readonly string[] = [];
    // The line index is built HERE (once per fold) rather than inside the ingest
    // so the accept decision sees the same disk truth `runAuditStep`'s batch gate
    // validates against; the audit-task manifest comes from the same bundle.
    const lineIndexForIngest = bundle.repo_manifest
      ? await buildLineIndex(ctx.params.root, bundle.repo_manifest)
      : undefined;
    try {
      const ingested = await ingestAuditHostResults({
        root: ctx.params.root,
        artifactsDir: ctx.params.artifactsDir,
        runId: currentRun.run_id,
        auditTasks: bundle.audit_tasks ?? [],
        lineIndex: lineIndexForIngest,
      });
      acceptedResults = ingested.accepted_results;
      ingestIssues = ingested.issues;
      validationWarnings = ingested.validation_warnings;
      completedIds = ingested.completed_work_item_ids;
    } catch (error) {
      // No handoff exists on the first visit, or prepare was interrupted before
      // all binding artifacts landed. Re-preparing below restores it exactly.
      if (!isFileMissingError(error)) throw error;
    }
    // The ingest CLASSIFIES every failed read — a submission that never
    // arrived, unreadable bytes (an EACCES or a directory at the bound path
    // reads as malformed WITH the OS detail in its message), a body that fails
    // the contract, a replayed result id. Those classifications used to die in
    // the caller that computed them; they now land on the ledger and, below,
    // in the re-emitted step the host actually reads. The completed set rides
    // along so a repaired item closes its own record.
    await recordHostResultOutcomes(ctx.params.artifactsDir, currentRun.run_id, {
      issues: ingestIssues,
      acceptedIds: completedIds,
    });

    const pendingIds = new Set(
      buildPendingAuditTasks(bundle).map((task) => task.task_id),
    );
    const pendingAccepted = acceptedResults.filter((result) =>
      pendingIds.has(result.task_id),
    );
    if (pendingAccepted.length > 0) {
      // Forced, lock-free, against the CARRIED bundle: the fold owns the one
      // hold and the one persist.
      const ingested = await runAuditStepUnlocked(
        {
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          preferredExecutor: "result_ingestion_executor",
          auditResultsData: [...pendingAccepted],
        },
        bundle,
      );
      // The transition returns before any emission, and the NEXT ingest skips
      // already-accepted bindings — so this fold's advisories would be a
      // one-shot loss. Carry them in the ctx ref; the semantic-review emit
      // below (this call or a later iteration of the same drain) merges and
      // consumes them exactly once.
      mergeFoldAdvisoriesInto(ctx.foldAdvisoriesRef.value, {
        issues: ingestIssues,
        validationWarnings,
      });
      return { kind: "transition", state: ingested.updated_bundle };
    }
  }

  // The UNLOCKED variant: the fold already holds the artifact-tree lock, and
  // `withFileLock` is non-reentrant — the locking `ensureSemanticReviewRun`
  // here would be a deterministic FileLockTimeoutError on the audit loop's
  // most common exit path. Its blocked core state rides the emit's `state`
  // below, so the fold's single commit persists it (the pause's own persist
  // was the split's other half).
  const review = await ensureSemanticReviewRunUnlocked({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle,
    state,
    obligationId: decision.selected_obligation,
    selfCliPath: ctx.params.selfCliPath,
    timeoutMs: ctx.params.timeoutMs,
  });
  // Consume whatever earlier fold iterations of THIS call carried: each
  // advisory is stated on exactly one emitted step (never duplicated on later
  // folds), and an emit with nothing carried renders only what THIS ingest saw.
  const carried = takeFoldAdvisories(ctx.foldAdvisoriesRef);
  const emitted = {
    kind: "semantic_review" as const,
    selectedExecutor: decision.selected_executor,
    ...review,
    ...(ingestIssues.length > 0 ? { ingestIssues } : {}),
    ...(validationWarnings.length > 0 ? { validationWarnings } : {}),
  };
  return {
    kind: "emit",
    step:
      carried.ingestIssues.length > 0 || carried.validationWarnings.length > 0
        ? {
            ...emitted,
            ingestIssues: [
              ...(ingestIssues as AuditHostIngestIssue[]),
              ...carried.ingestIssues,
            ],
            validationWarnings: [
              ...(validationWarnings as AuditHostValidationWarning[]),
              ...carried.validationWarnings,
            ],
          }
        : emitted,
    // The pause's blocked core state — the fold's single commit persists it
    // (the locking variant's own write was the other half of the split).
    state: review.bundle,
  };
}

/** Emit the no-executor blocked step (the hand loop's `!selected_executor` arm). */
async function emitNoExecutorBlocked(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
  decision: ReturnType<typeof decideNextStep>,
): Promise<AuditOutcome> {
  const state = decision.state;
  const reason = ctx.lastSummaryRef.value || decision.reason;
  await writeHandoffOnly({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle,
    audit_state: state,
    progress_summary: reason,
  });
  return { kind: "emit", step: { kind: "blocked", state, bundle, reason }, state: bundle };
}

/**
 * Wrap each obligation so the fold's CURRENT carried bundle is always
 * observable on the ctx — the commit-on-throw path persists it, and a throw
 * unwinds the engine before it can return its state. Single point of truth so
 * a new obligation cannot forget to track. (The dispatch ordinal the guards
 * read is counted at the dispatch site, `runDeterministicExecutor` — a policy
 * transition mints no new artifact state, so it does not count.)
 */
function trackFoldBundle(obligations: AuditObligationDef[]): AuditObligationDef[] {
  return obligations.map((obligation) => ({
    ...obligation,
    execute: async (bundle: ArtifactBundle, ctx: AuditNextStepCtx) => {
      const outcome = await obligation.execute(bundle, ctx);
      if (outcome.kind === "transition") {
        ctx.currentBundleRef.value = outcome.state;
      } else if (outcome.state !== undefined) {
        ctx.currentBundleRef.value = outcome.state;
      }
      return outcome;
    },
  }));
}

// ── Coordinator ───────────────────────────────────────────────────────────────

/**
 * Drive the deterministic fold for one `next-step` call.
 *
 * Structure mirrors remediate-code's `decideNextStepLoop` (the proven engine
 * consumer): a PREAMBLE (the `index===0` file-integrity re-intake, the analog of
 * remediate's `forceReplan`) then the shared `advance` running audit's `PRIORITY`
 * obligations. Each deterministic executor `transition`s (folding the whole chain
 * into one host round-trip); host-delegation / dispatch / terminal obligations
 * `emit` the host-actionable step.
 *
 * Cycle detection stays in audit's `Ctx` (the pre-dispatch no-progress guard +
 * the FINALIZATION_CYCLE_TOLERANCE finalization-cycle guard, both invoked from
 * inside `runDeterministicExecutor`), NOT in `advance.opts.stateSignature` — the
 * shared engine is inherently 0-tolerance and cannot express the tolerance window
 * or the no-metadata-skip (HANDOFF approach B). `advance`'s `maxTransitions` is
 * left as its pure runaway backstop. A `step === null` result (no actionable
 * obligation, e.g. synthesis flipped the state to complete) resolves to the
 * terminal step (present_report when a report is rendered, else blocked).
 */
export async function runDeterministicForNextStep(
  params: NextStepParams,
): Promise<NextStepResult> {
  const analyzersRef: { value: Record<string, AnalyzerSetting> | undefined } = {
    value: params.analyzers,
  };

  // PREAMBLE — file-integrity re-intake (runs once, like remediate's
  // forceReplan). When pending audit-task files have changed/vanished since the
  // manifest was built, re-run intake so planning re-grounds. advanceAudit does
  // not persist (only runAuditStep does), so this is the same diagnostic-then-
  // reload the hand loop performed on its first iteration: the warning fires and
  // the fold below starts from the freshly-loaded disk bundle.
  {
    const bundle = await loadArtifactBundle(params.artifactsDir);
    if (bundle.audit_state?.status !== "complete" && bundle.repo_manifest) {
      const pendingTasks = buildPendingAuditTasks(bundle);
      const taskFiles = new Set<string>();
      for (const task of pendingTasks) {
        for (const fp of Object.keys(task.file_line_counts ?? {})) taskFiles.add(fp);
      }
      if (taskFiles.size > 0) {
        const integrity = await checkFileIntegrity(params.root, bundle.repo_manifest, [...taskFiles]);
        if (!integrity.is_clean) {
          // Route this diagnostic OFF stdout: cmdNextStep emits the step
          // contract as the sole stdout payload via console.log(JSON.stringify),
          // so a console.log here would corrupt the JSON-on-stdout contract.
          process.stderr.write(
            `[audit-code] nextStep: integrity check — ${integrity.changed_files.length} changed, ` +
              `${integrity.missing_files.length} missing, ${integrity.io_errors.length} io-error(s); re-running intake.\n`,
          );
          await advanceAudit(bundle, {
            root: params.root,
            artifactsDir: params.artifactsDir,
            preferredExecutor: "intake_executor",
          });
        }
      }
    }
  }

  const ctx: AuditNextStepCtx = {
    params,
    analyzersRef,
    lastSummaryRef: { value: "" },
    foldAdvisoriesRef: {
      value: {
        ingestIssues: [...EMPTY_FOLD_ADVISORIES.ingestIssues],
        validationWarnings: [...EMPTY_FOLD_ADVISORIES.validationWarnings],
      },
    },
    dispatchOrdinalRef: { value: 0 },
    dispatchedSignatures: new Set<string>(),
    seenStateSignatures: new Set<string>(),
    obligationTrail: [],
    tx: createFoldTransaction(),
    currentBundleRef: { value: {} },
    failureRef: { value: null },
    manifestIndexCache: new WeakMap(),
  };

  // ONE hold, ONE core commit (CX-02 constraint 3): the whole drain runs under
  // a single artifact-tree lock, carries its bundle in memory, and lands ONE
  // authoritative core write at the boundary — on EVERY exit, the throw path
  // included (a persist only on success would drop the failure attribution the
  // recovery path reads). Non-core writes (markers, handoff, quarantine, the
  // durable analyzer stores) stay mid-fold by design: the delivered property
  // is one CORE write boundary, not one persist boundary.
  resetStalenessDedup();
  const foldLogger = new RunLogger(join(params.artifactsDir, "run.log.jsonl"), {
    enabled: true,
  });
  const outcome = await withArtifactTreeHold(
    params.artifactsDir,
    foldLogger,
    async () => {
      // CX-02 hold measurement: time the IN-HOLD span (acquire→release, this
      // callback), and record the engine's own charged-execution count. The
      // `finally` below runs on the throw path too, still under the hold.
      const holdStartMs = Date.now();
      let chargedExecutions: number | undefined;
      await recoverStagedSubmissions(params.artifactsDir);
      const startBundle = await loadArtifactBundle(params.artifactsDir);
      ctx.currentBundleRef.value = startBundle;
      try {
        const engineOutcome = await advance(
          {
            priority: PRIORITY,
            obligations: trackFoldBundle(buildAuditObligations()),
          },
          startBundle,
          ctx,
          {
            maxTransitions: engineMaxTransitions(),
            maxExecutions: MAX_DRAIN_STEPS,
          },
        );
        chargedExecutions = engineOutcome.executions;
        await commitFold(params.artifactsDir, engineOutcome.state, ctx.tx);
        return engineOutcome;
      } catch (error) {
        // Commit-on-throw: persist the carried bundle WITH dispatch-local
        // failure attribution, then rethrow. This replaces the old catch's
        // second lock acquisition (a deterministic timeout under one hold).
        const bundle = ctx.currentBundleRef.value;
        const failure =
          ctx.failureRef.value ??
          (() => {
            const found = findExecutorFailure(error);
            return found
              ? { executor: found.executor, obligation: found.obligation }
              : null;
          })();
        const failedState = deriveAuditState(bundle, { emitStaleness: false });
        failedState.last_executor = failure?.executor ?? undefined;
        failedState.last_obligation = failure?.obligation ?? undefined;
        await commitFold(
          params.artifactsDir,
          { ...bundle, audit_state: failedState },
          ctx.tx,
        );
        throw error;
      } finally {
        foldLogger.event({
          kind: "outcome",
          note: "fold_hold",
          duration_ms: Date.now() - holdStartMs,
          ...(chargedExecutions === undefined
            ? {}
            : { executions: chargedExecutions }),
        });
      }
    },
  );

  // The ONE consolidated staleness record for the whole fold (preserve list):
  // every in-fold derivation ran emit-off, so this is the only scan-level
  // record this call emits (forced applies keep their own per-apply records,
  // exactly as each per-transition runAuditStep call did before the collapse).
  const finalStale = computeStaleArtifacts(outcome.state, { emit: false });
  emitStalenessRecord(
    finalStale,
    isMetadataMigrationStaleness(outcome.state)
      ? "metadata_schema_version_migration"
      : undefined,
  );

  if (outcome.step) {
    if (outcome.step.kind === "terminal_intent") {
      // Guard terminals convert POST-commit, POST-hold: buildTerminalStep can
      // promote, and promotion deletes artifactsDir.
      return await buildTerminalStep(
        params,
        outcome.step.bundle,
        outcome.step.state,
        outcome.step.reason,
      );
    }
    return outcome.step;
  }

  if (outcome.stopped === "budget") {
    // The pacing cap (MAX_DRAIN_STEPS charged executions), spent gracefully:
    // the run is paused resumably — the committed state resumes on the next
    // call. Never non-convergence; never routed through the stalled branch.
    const bundle = outcome.state;
    const state =
      bundle.audit_state ?? deriveAuditState(bundle, { emitStaleness: false });
    const reason =
      `Pacing cap: this call spent its ${MAX_DRAIN_STEPS}-execution budget and paused. ` +
      "Nothing is wrong — the fold's work is committed; re-run next-step to resume.";
    await writeHandoffOnly({
      root: params.root,
      artifactsDir: params.artifactsDir,
      bundle,
      audit_state: state,
      progress_summary: reason,
    });
    return { kind: "blocked", state, bundle, reason };
  }

  // The engine stamps the limit that fired on the result (`stoppedBound`), so
  // `describeStoppedFold` reports the number in force with nothing restated
  // here. Budget stops were handled above; what reaches this branch is genuine
  // non-convergence (the derived transition backstop, which the execution
  // budget makes unreachable in practice — a backstop firing IS the anomaly).
  const stalled = describeStoppedFold(outcome);
  if (stalled) {
    // The engine's bound is its runaway backstop, and audit deliberately
    // supplies no stateSignature (cycle detection lives in ctx-level guards with
    // tolerance windows). A cause those guards miss — observed 2026-07-30: an
    // errored rolling packet left `audit_tasks_completed` actionable while its
    // error-shaped result files made the pending frontier look answered — used
    // to CRASH next-step with exit 1, where the same class of stall
    // (no_capable_pool) gets a graceful resumable pause. The engine now REPORTS
    // the non-convergence instead of throwing it, so the pause is built from the
    // outcome's own fields — no error message is parsed to learn either that the
    // bound fired or which obligation was spinning.
    const bundle = await loadArtifactBundle(params.artifactsDir);
    const decision = decideNextStep(bundle);
    return {
      kind: "blocked",
      state: decision.state,
      bundle,
      reason:
        `The deterministic fold ${stalled.cause} — an obligation is re-selecting without clearing its own ` +
        `actionable state (${stalled.spinning}). ` +
        "The run is paused resumably, not crashed: inspect the run's task-results/ for error-shaped " +
        "result files whose tasks never completed (delete them to re-dispatch those tasks), or hand " +
        "results in with `audit-code ingest-results --results <file>`; then re-run next-step.",
    };
  }

  // No actionable obligation: the fold reached completion (e.g. synthesis flipped
  // the state to complete and every obligation is now satisfied). Build the
  // terminal: present_report when the state is complete / a report is rendered,
  // else blocked.
  const bundle = await loadArtifactBundle(params.artifactsDir);
  const decision = decideNextStep(bundle);
  const state = decision.state;

  if (state.status === "complete") {
    await writeHandoffOnly({
      root: params.root,
      artifactsDir: params.artifactsDir,
      bundle,
      audit_state: state,
      progress_summary: decision.reason,
    });
    // Evaluate friction triage BEFORE promotion, then promote only once triage
    // is satisfied (see promoteIfFrictionSatisfied). Promoting while triage is
    // still pending would delete the friction record the host must finish writing
    // and wipe audit_state/audit_report (→ confirm_intent replay on re-entry).
    const triage = await decideAuditFrictionCloseout(params.artifactsDir, AUDIT_FRICTION_RUN_ID);
    const finalReportPath = await promoteIfFrictionSatisfied(params.artifactsDir, triage);
    return {
      kind: "complete",
      state,
      bundle,
      finalReportPath,
      triage,
    };
  }

  return buildTerminalStep(
    params,
    bundle,
    state,
    ctx.lastSummaryRef.value || decision.reason,
  );
}
