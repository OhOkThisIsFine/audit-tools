/**
 * Extracted helpers for the next-step command.
 *
 * Splitting these out of nextStepCommand.ts reduces that file to just the
 * top-level cmdNextStep dispatcher, keeping each module focused on a single
 * concern.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  advance,
  DEFAULT_MAX_TRANSITIONS,
  isFileMissingError,
  isJsonParseError,
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
  writeCoreArtifacts,
} from "../io/artifacts.js";
import {
  artifactTreeLockPath,
  auditReportPath,
  groundDesignFindings,
  promotedAuditReportPath,
  withFileLock,
} from "audit-tools/shared";
import {
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
  ClarificationAnswersSubmissionSchema,
  CriticalFlowFallbackResultSchema,
  SynthesisNarrativeSchema,
  SystemicChallengeSubmissionSchema,
} from "audit-tools/shared";
import type { CharterKind, CharterSubmission } from "audit-tools/shared";
import { charterExtractionKindsForCeiling } from "./charterExtractionPrompt.js";
import type { ZodError, ZodTypeAny } from "zod";
import type { AuditState } from "../types/auditState.js";
import type { Finding } from "../types.js";
import type {
  DesignAssessment,
  RejectedDesignReviewSubmission,
} from "../types/designAssessment.js";
import { advanceAudit, type AdvanceAuditResult } from "../orchestrator/advance.js";
import {
  captureDesignReviewSnapshot,
  isDesignReviewStale,
  type DesignReviewPass,
} from "../orchestrator/designReviewSnapshot.js";
import { computeArtifactStateSignature } from "../orchestrator/artifactMetadata.js";
import { decideNextStep, PRIORITY, decideAuditFrictionCloseout } from "../orchestrator/nextStep.js";
import { isHostDelegationExecutor } from "../orchestrator/executors.js";
import {
  resolveCharterCeiling,
  ceilingRequestsCharters,
} from "../orchestrator/charterExtractionExecutor.js";
import { resolveClarificationAttention } from "../orchestrator/charterClarificationExecutor.js";
import { deriveAuditState } from "../orchestrator/state.js";
import {
  deriveIntentEquivalenceStatus,
  IntentEquivalenceVerdictSchema,
} from "../orchestrator/intentEquivalenceExecutor.js";
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
import { runAuditStep } from "./auditStep.js";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";
import {
  writeHandoffOnly,
  ensureSemanticReviewRun,
  loadCurrentActiveReviewRun,
} from "./reviewRun.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import { ingestAuditHostResults } from "./dispatch/hostHandoff.js";

// ── Incoming-artifact helper ──────────────────────────────────────────────────

/**
 * One poll attempt over an `incoming/<filename>` submission. Every gate that
 * consumes host/worker submissions narrows on `status`, so a malformed lane can
 * never hard-fail the whole next-step call (the 2026-08-06 design-review loss:
 * a SyntaxError thrown out of one lane destroyed the sibling lane's consumed,
 * not-yet-persisted results).
 */
export type IncomingConsumeAttempt<T> =
  | { status: "ok"; value: T; path: string }
  | { status: "absent" }
  | { status: "malformed"; path: string; reason: string };

/**
 * Read a JSON file from the `incoming/` subdirectory of `artifactsDir`.
 * `ok` when the file exists and parses; `absent` on ENOENT-family errors;
 * `malformed` when the file exists but is not JSON — submitted content is the
 * CALLER's to quarantine, never an infrastructure failure. All other IO errors
 * re-throw unchanged.
 */
export async function tryConsumeIncoming<T>(
  artifactsDir: string,
  filename: string,
): Promise<IncomingConsumeAttempt<T>> {
  const filePath = join(artifactsDir, "incoming", filename);
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
 * The host-actionable outcome of one `next-step` deterministic fold — the
 * discriminated union `runDeterministicForNextStep` returns and `cmdNextStep`
 * renders (one branch per kind). Each audit `ObligationDef.execute` returns this
 * inside an `emit` outcome (or a `transition` carrying the reloaded bundle when
 * the fold continues).
 */
export type NextStepResult =
  | { kind: "semantic_review"; state: AuditState; bundle: ArtifactBundle; activeReviewRun: ActiveReviewRun; selectedExecutor?: string | null; inProcessMadeProgress?: boolean }
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
  const triage = await decideAuditFrictionCloseout(params.artifactsDir, "run");
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
 *   - nothing pending (acquisition off / token present / all decided) → run the
 *     deterministic acquisition executor (`fallthrough`);
 *   - a decisions file arrived (`incoming/analyzer-consent-decisions.json`,
 *     `{ "<id>": "granted" | "declined" }`) → persist the decisions into
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
): Promise<AnalyzerConsentBranchResult> {
  const pending = pendingAnalyzerConsent({
    root: params.root,
    analyzers: analyzersRef.value,
    externalAcquisitionEnabled: params.externalAcquisition?.enabled,
    analyzerConsent: params.externalAcquisition?.analyzerConsent,
    acquisitionConsentToken: params.externalAcquisition?.consentToken,
  });
  if (pending.length === 0) return { action: "fallthrough" };
  const incoming = await consumeObjectIncoming(
    params.artifactsDir,
    "analyzer-consent-decisions.json",
  );
  if (incoming.status === "quarantined") {
    return { action: "continue" };
  }
  if (incoming.status === "ok") {
    const decisions: Record<string, "granted" | "declined"> = {};
    for (const [id, value] of Object.entries(incoming.value)) {
      if (value === "granted" || value === "declined") {
        decisions[id] = value;
      }
    }
    if (Object.keys(decisions).length > 0) {
      await persistAnalyzerConsent(params.root, decisions);
      if (params.externalAcquisition) {
        params.externalAcquisition.analyzerConsent = {
          ...(params.externalAcquisition.analyzerConsent ?? {}),
          ...decisions,
        };
      }
    } else {
      const invalidEntries = Object.keys(incoming.value).join(", ") || "(none)";
      process.stderr.write(
        `[audit-code] analyzer-consent-decisions.json ignored: no recognized values (got: ${invalidEntries}). ` +
          `Valid values are: granted, declined.\n`,
      );
    }
    await unlink(incoming.path).catch(() => {});
    return { action: "continue" };
  }
  return { action: "return", result: { kind: "analyzer_consent", state, bundle, pending } };
}

type GraphEnrichmentBranchResult =
  | { action: "continue" }
  | { action: "return"; result: { kind: "analyzer_install"; state: AuditState; bundle: ArtifactBundle; unresolved: AnalyzerPlanEntry[] } }
  | { action: "return"; result: { kind: "edge_reasoning"; state: AuditState; bundle: ArtifactBundle; candidates: GraphEdge[] } }
  | { action: "fallthrough" };

/**
 * Handle the `graph_enrichment_executor` incoming-artifact polling block.
 * Checks for pending analyzer install decisions and edge-reasoning results.
 * Returns an action object:
 *   - `continue`    → caller should keep folding (already consumed an artifact).
 *   - `return`      → caller should emit the embedded result to cmdNextStep.
 *   - `fallthrough` → no incoming artifacts; run the deterministic executor.
 */
export async function handleGraphEnrichmentBranch(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since">,
  bundle: ArtifactBundle,
  state: AuditState,
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined },
  deps: { runStep?: typeof runAuditStep } = {},
): Promise<GraphEnrichmentBranchResult> {
  const runStep = deps.runStep ?? runAuditStep;
  // Fold-level pause detection is single-sourced in `hostInputPause` so the drain
  // stop predicate (`nextStepPausesForHostInput`) and this fold agree EXACTLY on
  // when the analyzer-install consent / edge-reasoning turns are owed.
  const pauseInputs = {
    root: params.root,
    analyzers: analyzersRef.value,
    graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
  };
  const unresolved = graphEnrichmentUnresolvedAnalyzers(bundle, pauseInputs);
  if (unresolved.length > 0) {
    const incoming = await consumeObjectIncoming(
      params.artifactsDir,
      "analyzer-decisions.json",
    );
    if (incoming.status === "quarantined") {
      // A non-object top-level value used to be neither merged, deleted, nor
      // diagnosed — the file lingered in incoming/ and the analyzer_install
      // step re-emitted silently forever. Quarantined + diagnosed instead.
      return { action: "continue" };
    }
    if (incoming.status === "ok") {
      const settings: Record<string, AnalyzerSetting> = {};
      for (const [id, value] of Object.entries(incoming.value)) {
        if (
          value === "ephemeral" ||
          value === "permanent" ||
          value === "skip" ||
          value === "repo" ||
          value === "auto"
        ) {
          settings[id] = value;
        }
      }
      if (Object.keys(settings).length > 0) {
        const merged = await persistAnalyzerSettings(params.root, settings);
        analyzersRef.value = merged.analyzers;
      } else {
        // All entries in analyzer-decisions.json failed the recognized-value
        // check (ephemeral|permanent|skip|repo|auto). Emit a diagnostic so the
        // operator knows why no settings were applied (COR-03418a9f fix).
        const invalidEntries = Object.keys(incoming.value).join(", ") || "(none)";
        process.stderr.write(
          `[audit-code] analyzer-decisions.json ignored: no recognized values (got: ${invalidEntries}). ` +
            `Valid values are: ephemeral, permanent, skip, repo, auto.\n`,
        );
      }
      await unlink(incoming.path).catch(() => {});
      return { action: "continue" };
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
      const edgeReasoningIncoming = await tryConsumeIncoming<unknown>(
        params.artifactsDir,
        "edge-reasoning.json",
      );
      if (edgeReasoningIncoming.status === "malformed") {
        const quarantinePath = await quarantineIncomingFile(
          params.artifactsDir,
          edgeReasoningIncoming.path,
          "edge-reasoning.json",
        );
        await recordEdgeReasoningRejection(params.artifactsDir, {
          filename: "edge-reasoning.json",
          quarantine_path: quarantinePath,
          reason: edgeReasoningIncoming.reason,
          rejected_at: new Date().toISOString(),
        });
        return { action: "continue" };
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
        const unwrapped = unwrapIncomingArray(edgeReasoningIncoming.value);
        if (!unwrapped.ok) {
          const quarantinePath = await quarantineIncomingFile(
            params.artifactsDir,
            edgeReasoningIncoming.path,
            "edge-reasoning.json",
          );
          await recordEdgeReasoningRejection(params.artifactsDir, {
            filename: "edge-reasoning.json",
            quarantine_path: quarantinePath,
            reason: unwrapped.reason,
            rejected_at: new Date().toISOString(),
          });
          return { action: "continue" };
        }
        // Apply BEFORE deleting the incoming file: if runStep throws (locks,
        // crash), the submission survives for the retry instead of being lost.
        await runStep({
          root: params.root,
          artifactsDir: params.artifactsDir,
          analyzers: analyzersRef.value,
          graphLlmEdgeReasoning: true,
          edgeReasoningResults: { rewrites: unwrapped.array as EdgeReasonRewrite[] },
          since: params.since,
        });
        await unlink(edgeReasoningIncoming.path).catch(() => {});
        await clearEdgeReasoningRejection(params.artifactsDir);
        return { action: "continue" };
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
  | { action: "continue" }
  | { action: "return"; result: { kind: "design_review_parallel"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_contract"; state: AuditState; bundle: ArtifactBundle } }
  | { action: "return"; result: { kind: "design_review_conceptual"; state: AuditState; bundle: ArtifactBundle } };

/**
 * Handle the `design_review_contract` or `design_review_conceptual` incoming-artifact
 * polling blocks. Checks for contract and/or conceptual findings files independently.
 *
 * Returns:
 *   - `continue`               → one or both incoming files were consumed; keep folding.
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

// ── Design-review incoming-array quarantine (malformed-submission fix) ───────
//
// `handleDesignReviewBranch` used to unconditionally `unlink` every incoming
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
//      so it survives the same-call `continue` re-derivation, and the
//      re-emitted design-review step names the quarantined file + reason
//      (see `renderDesignReviewRejectionNotice`, threaded in nextStepCommand.ts).

type ConsumeArrayIncomingResult<T> =
  | { status: "absent" }
  | { status: "ok"; value: T[]; path: string }
  | {
      status: "quarantined";
      quarantinePath: string;
      originalFilename: string;
      reason: string;
    };

/** Human-readable description of why an incoming value is neither an array nor a single-array-wrapped object. */
function describeIncomingShapeMismatch(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array"; // reachable from consumeObjectIncoming (an array is not a key→value map)
  const t = typeof value;
  if (t !== "object") return `a bare ${t}`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "an empty object";
  const arrayKeys = entries.filter(([, v]) => Array.isArray(v)).map(([k]) => k);
  const allKeys = entries.map(([k]) => k).join(", ");
  if (arrayKeys.length === 0) {
    return `an object with no array-valued properties (keys: ${allKeys})`;
  }
  return (
    `an object with ${arrayKeys.length} array-valued propert${arrayKeys.length === 1 ? "y" : "ies"} ` +
    `out of ${entries.length} total key(s) (${allKeys}) — exactly one top-level array property is ` +
    `required for the tolerant unwrap`
  );
}

/**
 * Move a malformed incoming submission to `<artifactsDir>/quarantine/` rather
 * than deleting it. Falls back to copy+unlink if `rename` fails (e.g. a
 * cross-device incoming/ mount) so the content is never lost.
 */
async function quarantineIncomingFile(
  artifactsDir: string,
  filePath: string,
  originalFilename: string,
): Promise<string> {
  const quarantineDir = join(artifactsDir, "quarantine");
  await mkdir(quarantineDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(quarantineDir, `${originalFilename}.${timestamp}.json`);
  try {
    await rename(filePath, quarantinePath);
  } catch {
    try {
      const content = await readFile(filePath, "utf8");
      await writeFile(quarantinePath, content, "utf8");
    } catch {
      // Best-effort: nothing left to quarantine if even the read failed.
    }
    await unlink(filePath).catch(() => {});
  }
  return quarantinePath;
}

/**
 * Quarantine a submission that failed zod validation — or failed to parse as
 * JSON at all (a plain string reason): move it out of `incoming/` (never
 * unlink-and-discard) and write a stderr diagnostic naming the quarantined
 * file + the error. The single loud-quarantine path shared by every
 * schema-validated incoming gate (`runOmittableGate` + `handleIntentEquivalenceBranch`
 * + the charter lane loop) so the "quarantine loudly" property cannot drift
 * between them. Returns the quarantine path.
 */
async function quarantineMisshapedIncoming(
  artifactsDir: string,
  filePath: string,
  filename: string,
  error: ZodError | string,
): Promise<string> {
  const reason = typeof error === "string"
    ? error
    : error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  const quarantinePath = await quarantineIncomingFile(artifactsDir, filePath, filename);
  process.stderr.write(
    `[audit-code] ${filename} quarantined to ${quarantinePath}: ${reason}. ` +
      `Fix the shape and resubmit.\n`,
  );
  return quarantinePath;
}

/**
 * The single tolerant-unwrap rule: a bare array is accepted as-is; a top-level
 * object wrapping exactly one array-valued property is unambiguous and is
 * accepted as that array. Anything else fails with a shape description.
 * Single-sourced so `consumeArrayIncoming` and the edge-reasoning gate cannot
 * drift on what shapes are accepted.
 */
function unwrapIncomingArray(
  value: unknown,
): { ok: true; array: unknown[] } | { ok: false; reason: string } {
  if (Array.isArray(value)) return { ok: true, array: value };
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && Array.isArray(entries[0][1])) {
      return { ok: true, array: entries[0][1] };
    }
  }
  return { ok: false, reason: describeIncomingShapeMismatch(value) };
}

/**
 * Read a JSON `incoming/` file expected to be an array (or a top-level object
 * wrapping exactly one array-valued property, the tolerant unwrap). Accepts
 * either shape and deletes the source file; any other shape is quarantined
 * (never unlinked-and-discarded) and reported with a reason.
 */
export async function consumeArrayIncoming<T>(
  artifactsDir: string,
  filename: string,
): Promise<ConsumeArrayIncomingResult<T>> {
  const incoming = await tryConsumeIncoming<unknown>(artifactsDir, filename);
  if (incoming.status === "absent") return { status: "absent" };
  if (incoming.status === "malformed") {
    const quarantinePath = await quarantineIncomingFile(artifactsDir, incoming.path, filename);
    return { status: "quarantined", quarantinePath, originalFilename: filename, reason: incoming.reason };
  }
  const { value, path } = incoming;
  const unwrapped = unwrapIncomingArray(value);
  if (unwrapped.ok) {
    await unlink(path).catch(() => {});
    return { status: "ok", value: unwrapped.array as T[], path };
  }
  const quarantinePath = await quarantineIncomingFile(artifactsDir, path, filename);
  return { status: "quarantined", quarantinePath, originalFilename: filename, reason: unwrapped.reason };
}

type ConsumeObjectIncomingResult =
  | { status: "absent" }
  | { status: "ok"; value: Record<string, unknown>; path: string }
  | { status: "quarantined"; quarantinePath: string; reason: string };

/**
 * Read a JSON `incoming/` file expected to be a plain top-level object (a
 * key → value map, e.g. analyzer-decisions.json). A non-object value — null,
 * an array, a bare primitive — is quarantined with a stderr diagnostic rather
 * than left lingering in `incoming/` (where it used to make the emitting step
 * re-ask silently forever). Unlike `consumeArrayIncoming`, an accepted file is
 * NOT deleted here — the caller unlinks after applying, so a crash mid-apply
 * retains the submission for the retry.
 */
export async function consumeObjectIncoming(
  artifactsDir: string,
  filename: string,
): Promise<ConsumeObjectIncomingResult> {
  const incoming = await tryConsumeIncoming<unknown>(artifactsDir, filename);
  if (incoming.status === "absent") return { status: "absent" };
  if (incoming.status === "malformed") {
    const quarantinePath = await quarantineIncomingFile(artifactsDir, incoming.path, filename);
    process.stderr.write(
      `[audit-code] ${filename} quarantined to ${quarantinePath}: ${incoming.reason}. ` +
        `Fix the JSON and resubmit.\n`,
    );
    return { status: "quarantined", quarantinePath, reason: incoming.reason };
  }
  const { value, path } = incoming;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { status: "ok", value: value as Record<string, unknown>, path };
  }
  const reason = describeIncomingShapeMismatch(value);
  const quarantinePath = await quarantineIncomingFile(artifactsDir, path, filename);
  process.stderr.write(
    `[audit-code] ${filename} quarantined to ${quarantinePath}: expected a JSON object, got ${reason}. ` +
      `Fix the shape and resubmit.\n`,
  );
  return { status: "quarantined", quarantinePath, reason };
}

// ── Edge-reasoning rejection marker ──────────────────────────────────────────
//
// graph_enrichment has no design_assessment-shaped bundle field to persist a
// rejection note on, so a quarantined edge-reasoning submission is recorded in
// a lightweight sibling marker file the re-emitted edge_reasoning step's
// prompt reads (the graph artifacts themselves are content-hashed — writing a
// note into them would churn the staleness DAG).

interface EdgeReasoningRejection {
  filename: string;
  quarantine_path: string;
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
    `- \`${rejection.filename}\` quarantined to \`${rejection.quarantine_path}\` (${rejection.rejected_at}): ${rejection.reason}`,
    "",
    'Expected shape: {"rewrites":[{"from":"...","to":"...","kind":"...","reason":"..."}]} — ' +
      "a bare JSON array of rewrites is also accepted.",
  ].join("\n");
}

/**
 * Record a quarantined design-review submission on `design_assessment` (and
 * persist immediately) so the note survives the same-call `continue`
 * re-derivation. A no-op when `design_assessment` doesn't exist yet — in
 * practice unreachable, since `design_assessment_current` is a
 * higher-priority obligation than either design-review pass (PRIORITY in
 * nextStep.ts), so `design_assessment` always exists by the time this branch
 * runs.
 */
async function recordRejectedDesignReviewSubmission(
  artifactsDir: string,
  existing: DesignAssessment | undefined,
  pass: RejectedDesignReviewSubmission["pass"],
  quarantined: Extract<ConsumeArrayIncomingResult<unknown>, { status: "quarantined" }>,
): Promise<void> {
  if (!existing) return;
  const entry: RejectedDesignReviewSubmission = {
    pass,
    filename: quarantined.originalFilename,
    quarantine_path: quarantined.quarantinePath,
    reason: quarantined.reason,
    rejected_at: new Date().toISOString(),
  };
  existing.rejected_submissions = [
    ...(existing.rejected_submissions ?? []).filter((r) => r.pass !== pass),
    entry,
  ];
  await writeJsonFile(join(artifactsDir, "design_assessment.json"), existing);
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
      `- **${r.pass}** — \`${r.filename}\` quarantined to \`${r.quarantine_path}\` (${r.rejected_at}): ${r.reason}`,
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
): Promise<BranchActionResult> {
  const existing = bundle.design_assessment;

  // Legacy: consume old combined findings file. Tolerant-unwrap or quarantine
  // (never a bare unconditional delete) — see the quarantine block comment above.
  const legacyResult = await consumeArrayIncoming<Finding>(
    params.artifactsDir,
    "design-review-findings.json",
  );
  if (legacyResult.status === "quarantined") {
    await recordRejectedDesignReviewSubmission(params.artifactsDir, existing, "legacy", legacyResult);
    return { action: "continue" };
  }
  if (legacyResult.status === "ok") {
    if (existing) {
      existing.review_findings = groundDesignFindings(legacyResult.value, bundle.repo_manifest);
      existing.reviewed = true;
      existing.rejected_submissions = (existing.rejected_submissions ?? []).filter(
        (r) => r.pass !== "legacy",
      );
      await writeJsonFile(
        join(params.artifactsDir, "design_assessment.json"),
        existing,
      );
      return { action: "continue" };
    }
    // File consumed but no target to merge into — keep folding.
    return { action: "continue" };
  }
  // absent: fall through to the contract/conceptual check.

  // New: consume contract-findings and/or conceptual-findings independently.
  const contractResult = await consumeArrayIncoming<Finding>(
    params.artifactsDir,
    "design-review-contract-findings.json",
  );
  const conceptualResult = await consumeArrayIncoming<Finding>(
    params.artifactsDir,
    "design-review-conceptual-findings.json",
  );

  let consumed = false;

  if (contractResult.status === "quarantined") {
    await recordRejectedDesignReviewSubmission(params.artifactsDir, existing, "contract", contractResult);
  } else if (contractResult.status === "ok" && existing) {
    existing.contract_findings = groundDesignFindings(contractResult.value, bundle.repo_manifest);
    existing.contract_reviewed = true;
    existing.rejected_submissions = (existing.rejected_submissions ?? []).filter(
      (r) => r.pass !== "contract",
    );
    consumed = true;
  }

  if (conceptualResult.status === "quarantined") {
    await recordRejectedDesignReviewSubmission(params.artifactsDir, existing, "conceptual", conceptualResult);
  } else if (conceptualResult.status === "ok" && existing) {
    existing.conceptual_findings = groundDesignFindings(conceptualResult.value, bundle.repo_manifest);
    existing.conceptual_reviewed = true;
    existing.rejected_submissions = (existing.rejected_submissions ?? []).filter(
      (r) => r.pass !== "conceptual",
    );
    consumed = true;
  }

  if (consumed && existing) {
    await writeJsonFile(
      join(params.artifactsDir, "design_assessment.json"),
      existing,
    );
    // Snapshot each just-completed pass (B2 parity port): record the verdict +
    // the semantic projection of the structural inputs it reviewed, so a later
    // upstream change re-stales the pass and the re-emit can be diff-scoped
    // rather than a blind full re-run. Capture after the design_assessment write
    // so the projection reflects the persisted findings.
    const reviewedAt = new Date().toISOString();
    if (contractResult.status === "ok") {
      await captureDesignReviewSnapshot(
        params.artifactsDir,
        "contract",
        existing.contract_findings ?? [],
        bundle,
        reviewedAt,
      );
    }
    if (conceptualResult.status === "ok") {
      await captureDesignReviewSnapshot(
        params.artifactsDir,
        "conceptual",
        existing.conceptual_findings ?? [],
        bundle,
        reviewedAt,
      );
    }
    return { action: "continue" };
  }

  // Determine which passes still need to run. A completed pass whose snapshot has
  // gone stale (a structural input changed in projection) is NOT done — it must
  // re-run as a diff-based re-review. This mirrors the obligation staleness in
  // `designReviewPassState`.
  const contractDone =
    existing?.contract_reviewed === true && !passIsStale(bundle, "contract");
  const conceptualDone =
    existing?.conceptual_reviewed === true && !passIsStale(bundle, "conceptual");

  if (!contractDone && !conceptualDone) {
    return { action: "return", result: { kind: "design_review_parallel", state, bundle } };
  }
  if (!contractDone) {
    return { action: "return", result: { kind: "design_review_contract", state, bundle } };
  }
  if (!conceptualDone) {
    return { action: "return", result: { kind: "design_review_conceptual", state, bundle } };
  }

  // Both done — should not normally reach here (obligations would be satisfied).
  return { action: "continue" };
}

// ── Tier C2: consolidated "omittable host gate" engine ─────────────────────────
//
// Five of the seven host-gate branch handlers below share ONE shape: poll a
// single `incoming/<file>.json`; if present, apply it via runAuditStep and
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
//   - graph_enrichment polls TWO independent incoming files in sequence, each
//     gated by its own "is a decision still owed" predicate CHECKED BEFORE
//     attempting to consume (the opposite order from the shape above, which
//     always tries to consume first, ceiling-check second). Its stage-1 apply
//     is `persistAnalyzerSettings` + a value-validation stderr diagnostic, not
//     a `runAuditStep` dispatch; its "nothing to do" terminal state is named
//     `fallthrough`, not `run_omit` (same caller-side effect, kept as its own
//     literal so `handleGraphEnrichmentBranch`'s existing action union — and
//     the tests asserting `"fallthrough"` — stay untouched).
//   - design_review polls THREE incoming files: a legacy one handled and
//     returned on its own first, then two (contract/conceptual) polled
//     INDEPENDENTLY of each other (both are checked and, if valid, applied —
//     not first-match-wins) and merged into a single write plus a
//     per-just-applied-pass snapshot capture; its final decision picks one of
//     THREE step kinds off TWO independent booleans, not one ceiling check
//     against one step kind. There is no `run_omit` branch at all — an
//     unsatisfied pass always returns a host step, never an autonomous omit.

/** The common action shape all four `runOmittableGate`-driven branches return. */
type OmittableGateAction<TStepKind extends string> =
  | { action: "continue" }
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
  /** Filename under `incoming/` this gate polls. */
  filename: string;
  /**
   * Schema the consumed submission MUST satisfy before it is applied. REQUIRED —
   * the compiler enumerates every gate so a new one cannot forget it. A mis-shaped
   * submission is quarantined loudly (moved to `quarantine/`, stderr diagnostic
   * naming the file + shape error) and the gate falls through to shouldOmit/return;
   * it is NEVER handed to the executor to crash on (raw `.parse()`) or silently
   * degrade (bare cast). Single-sources the quarantine-loudly property for every
   * incoming gate this engine drives.
   */
  schema: ZodTypeAny;
  /** Apply the consumed value (the executor dispatch this gate's host turn feeds). */
  apply: (
    value: TIncoming,
    path: string,
    params: Pick<NextStepParams, "root" | "artifactsDir">,
  ) => Promise<void>;
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
 * Drive one "poll incoming → apply+continue, else omit-or-return" gate — the
 * shape common to synthesis_narrative, charter_extraction,
 * charter_clarification, and systemic_challenge. See the section comment
 * above for the two gates that deviate and are not run through this engine.
 */
async function runOmittableGate<TIncoming, TStepKind extends string>(
  descriptor: OmittableGateDescriptor<TIncoming, TStepKind>,
  params: Pick<NextStepParams, "root" | "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
): Promise<OmittableGateAction<TStepKind>> {
  const incoming = await tryConsumeIncoming<unknown>(params.artifactsDir, descriptor.filename);
  if (incoming.status === "malformed") {
    // Not-JSON submission: same quarantine-loudly lifecycle as a mis-shaped one.
    await quarantineMisshapedIncoming(
      params.artifactsDir,
      incoming.path,
      descriptor.filename,
      incoming.reason,
    );
  } else if (incoming.status === "ok") {
    const parsed = descriptor.schema.safeParse(incoming.value);
    if (parsed.success) {
      await descriptor.apply(parsed.data as TIncoming, incoming.path, params);
      await unlink(incoming.path).catch(() => {});
      return { action: "continue" };
    }
    // Mis-shaped submission: quarantine loudly and fall through to
    // shouldOmit/return — never hand it to the executor to crash on or silently
    // treat as an empty "reviewed, found nothing" result.
    await quarantineMisshapedIncoming(
      params.artifactsDir,
      incoming.path,
      descriptor.filename,
      parsed.error,
    );
  }
  if (descriptor.shouldOmit(bundle)) {
    return { action: "run_omit" };
  }
  return { action: "return", result: { kind: descriptor.kind, state, bundle } };
}

/**
 * Handle the `synthesis_narrative_executor` incoming-artifact polling block.
 * Returns:
 *   - `continue`  → an incoming narrative file was consumed + applied (progress
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
): Promise<SynthesisNarrativeBranchResult> {
  return runOmittableGate<SynthesisNarrative, "synthesis_narrative">(
    {
      kind: "synthesis_narrative",
      filename: "synthesis-narrative.json",
      schema: SynthesisNarrativeSchema,
      apply: async (_value, path, p) => {
        await runAuditStep({
          root: p.root,
          artifactsDir: p.artifactsDir,
          preferredExecutor: "synthesis_narrative_executor",
          narrativeResultsPath: path,
        });
      },
      // Narrative disabled: omit (run the deterministic omit executor below).
      shouldOmit: () => !params.narrativeEnabled,
    },
    params,
    bundle,
    state,
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
): Promise<IntentEquivalenceBranchResult> {
  const filename = "intent-equivalence-verdict.json";
  const incoming = await tryConsumeIncoming<unknown>(params.artifactsDir, filename);
  if (incoming.status === "malformed") {
    await quarantineMisshapedIncoming(
      params.artifactsDir,
      incoming.path,
      filename,
      incoming.reason,
    );
    // Fall through: no valid submission — re-emit or deterministically resolve.
  } else if (incoming.status === "ok") {
    const parsed = IntentEquivalenceVerdictSchema.safeParse(incoming.value);
    if (parsed.success) {
      await runAuditStep({
        root: params.root,
        artifactsDir: params.artifactsDir,
        preferredExecutor: "intent_equivalence_executor",
        intentEquivalenceVerdictPath: incoming.path,
      });
      await unlink(incoming.path).catch(() => {});
      return { action: "continue" };
    }
    await quarantineMisshapedIncoming(
      params.artifactsDir,
      incoming.path,
      filename,
      parsed.error,
    );
    // Fall through: no valid submission — re-emit or deterministically resolve.
  }
  if (deriveIntentEquivalenceStatus(bundle).kind !== "prose_judgment_pending") {
    return { action: "run_omit" };
  }
  return { action: "return", result: { kind: "intent_equivalence", state, bundle } };
}

/**
 * Handle the `critical_flow_fallback_executor` incoming-artifact polling block.
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
): Promise<CriticalFlowFallbackBranchResult> {
  return runOmittableGate<CriticalFlowFallbackResult, "critical_flow_fallback">(
    {
      kind: "critical_flow_fallback",
      filename: "critical-flow-fallback.json",
      schema: CriticalFlowFallbackResultSchema,
      apply: async (_value, path, p) => {
        await runAuditStep({
          root: p.root,
          artifactsDir: p.artifactsDir,
          preferredExecutor: "critical_flow_fallback_executor",
          criticalFlowFallbackResultsPath: path,
        });
      },
      // Never omit: the obligation is only reached when the deterministic bar
      // failed, and the host is always available to author the enrichment.
      shouldOmit: () => false,
    },
    params,
    bundle,
    state,
  );
}

/**
 * Handle the `charter_extraction_executor` incoming-artifact polling block
 * (Phase C). Mirrors the synthesis-narrative branch:
 *   - a pending `incoming/charter-extraction.json` → assemble+gate it via the
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
): Promise<CharterExtractionBranchResult> {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  // Shallow ceiling (default): omit deterministically, no host turn, no lanes.
  if (!ceilingRequestsCharters(ceiling)) {
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
    const filename = `charter-extraction-${kind}.json`;
    const incoming = await tryConsumeIncoming<unknown>(params.artifactsDir, filename);
    if (incoming.status === "absent") continue;
    if (incoming.status === "malformed") {
      quarantinedAny = true;
      await quarantineMisshapedIncoming(
        params.artifactsDir,
        incoming.path,
        filename,
        incoming.reason,
      );
      continue;
    }
    const laneSchema = CharterSubmissionSchema.superRefine((submission, ctx) => {
      submission.nodes.forEach((node, ni) => {
        if (node.kind !== kind) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", ni, "kind"],
            message: `lane '${kind}' may only carry kind '${kind}', got '${node.kind}'`,
          });
        }
        const unknown = node.files.filter((f) => !universe.has(f));
        if (unknown.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", ni, "files"],
            message:
              `teleology node cites file(s) outside the repo: ${unknown.sort().join(", ")} — ` +
              "scopes must be repo-relative paths exactly as the evidence packet names them",
          });
        }
      });
    });
    const parsed = laneSchema.safeParse(incoming.value);
    if (parsed.success) {
      laneValues.set(kind, { value: parsed.data, path: incoming.path });
    } else {
      quarantinedAny = true;
      await quarantineMisshapedIncoming(
        params.artifactsDir,
        incoming.path,
        filename,
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
    const mergedPath = join(params.artifactsDir, "incoming", "charter-extraction.json");
    await writeJsonFile(mergedPath, merged);
    await runAuditStep({
      root: params.root,
      artifactsDir: params.artifactsDir,
      preferredExecutor: "charter_extraction_executor",
      charterSubmissionPath: mergedPath,
    });
    await unlink(mergedPath).catch(() => {});
    for (const lane of laneValues.values()) {
      await unlink(lane.path).catch(() => {});
    }
    // Evidence packets are consumed inputs like the lane submissions — a stale
    // packet left behind would feed a later re-extraction yesterday's evidence.
    for (const kind of kinds) {
      await unlink(
        join(params.artifactsDir, "incoming", `charter-extraction-${kind}-packet.md`),
      ).catch(() => {});
    }
    return { action: "continue" };
  }
  // Missing or quarantined lane(s): a host turn is still owed — the emitter
  // re-materializes only the missing lanes (completed lane results stay).
  return { action: "return", result: { kind: "charter_extraction", state, bundle } };
}

/**
 * Handle the `charter_delta_executor` incoming-artifact polling block (Phase C.2 —
 * the INDEPENDENT delta-miner). Mirrors the charter-extraction branch:
 *   - a pending `incoming/charter-delta.json` → route+gate it via the preferred
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
): Promise<CharterDeltaBranchResult> {
  return runOmittableGate<unknown, "charter_delta">(
    {
      kind: "charter_delta",
      filename: "charter-delta.json",
      schema: CharterDeltaSubmissionSchema,
      apply: async (_value, path, p) => {
        await runAuditStep({
          root: p.root,
          artifactsDir: p.artifactsDir,
          preferredExecutor: "charter_delta_executor",
          charterDeltaSubmissionPath: path,
        });
      },
      // Nothing to mine (extraction omitted or no subsystems): settle
      // deterministically, no host turn.
      shouldOmit: (b) => !(b.charter_register?.deltas_pending === true),
    },
    params,
    bundle,
    state,
  );
}

/**
 * Handle the `charter_clarification_executor` obligation (Phase D triangulation
 * loop). Mirrors the charter-extraction branch, but the loop is DETERMINISTIC — the
 * executor assembles asked/banked from the Phase-C `charter_register` deltas, so the
 * host turn only surfaces the VOI-ranked interactive queue for relay:
 *   - a pending `incoming/charter-clarification.json` (host answers) → assemble via
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
): Promise<CharterClarificationBranchResult> {
  return runOmittableGate<unknown, "charter_clarification">(
    {
      kind: "charter_clarification",
      filename: "charter-clarification.json",
      schema: ClarificationAnswersSubmissionSchema,
      apply: async (_value, path, p) => {
        await runAuditStep({
          root: p.root,
          artifactsDir: p.artifactsDir,
          preferredExecutor: "charter_clarification_executor",
          clarificationAnswersPath: path,
        });
      },
      shouldOmit: (b) => {
        const ceiling = resolveCharterCeiling(b.intent_checkpoint);
        const attention = resolveClarificationAttention(b.intent_checkpoint);
        // Shallow ceiling or autonomous (zero-attention) mode: assemble the
        // register deterministically, no host turn (every question banks as
        // a finding).
        if (!ceilingRequestsCharters(ceiling) || attention === 0) return true;
        // The loop must be COMPUTED before we can relay a queue: if no register
        // exists yet, run the deterministic assembler this turn (it partitions/
        // ranks/gates/splits from the charter_register), then re-scan.
        if (!b.charter_clarification) return true;
        // Register exists: relay the interactive queue only when there is one
        // to ask.
        if ((b.charter_clarification.asked?.length ?? 0) === 0) return true;
        return false;
      },
    },
    params,
    bundle,
    state,
  );
}

/**
 * Handle the `systemic_challenge_executor` obligation (Phase E — the second-order
 * adversary loop-until-dry pass). Mirrors the charter-clarification branch:
 *   - a pending `incoming/systemic-challenge.json` (an adversary round's findings) →
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
): Promise<SystemicChallengeBranchResult> {
  return runOmittableGate<unknown, "systemic_challenge">(
    {
      kind: "systemic_challenge",
      filename: "systemic-challenge.json",
      schema: SystemicChallengeSubmissionSchema,
      apply: async (_value, path, p) => {
        await runAuditStep({
          root: p.root,
          artifactsDir: p.artifactsDir,
          preferredExecutor: "systemic_challenge_executor",
          systemicChallengePath: path,
        });
      },
      shouldOmit: (b) => {
        // Shallow ceiling (default): omit deterministically, no host turn.
        if (!ceilingRequestsCharters(resolveCharterCeiling(b.intent_checkpoint))) return true;
        // The loop must be OPENED before we can dispatch the adversary: if no
        // register exists yet, run the deterministic executor this turn (it
        // computes the metrics digest + writes an open register), then re-scan.
        if (!b.systemic_challenge) return true;
        // A converged register is already satisfied (never reaches this branch
        // in practice). An open register → dispatch the next
        // second-order-adversary round.
        if (b.systemic_challenge.converged) return true;
        return false;
      },
    },
    params,
    bundle,
    state,
  );
}

/**
 * Coverage registry for the audit host-gate branch handlers targeted by the
 * Tier C2 consolidation. `driven: "generic"` gates are fully parameterized
 * through `runOmittableGate`; `driven: "custom"` gates keep their own bespoke
 * body because their shape genuinely deviates from that common one — see the
 * section comment above `runOmittableGate` for exactly what deviates and why.
 * Exists so one source of truth enumerates all gate kinds (asserted by a
 * coverage test) rather than the count being implicit in which functions
 * happen to exist.
 */
export type HostGateKind =
  | "graph_enrichment"
  | "critical_flow_fallback"
  | "intent_equivalence"
  | "design_review"
  | "synthesis_narrative"
  | "charter_extraction"
  | "charter_delta"
  | "charter_clarification"
  | "systemic_challenge";

export const HOST_GATE_DESCRIPTORS: Record<
  HostGateKind,
  { driven: "generic" | "custom"; incomingFiles: readonly string[] }
> = {
  graph_enrichment: {
    driven: "custom",
    incomingFiles: ["analyzer-decisions.json", "edge-reasoning.json"],
  },
  design_review: {
    driven: "custom",
    incomingFiles: [
      "design-review-findings.json",
      "design-review-contract-findings.json",
      "design-review-conceptual-findings.json",
    ],
  },
  critical_flow_fallback: {
    driven: "generic",
    incomingFiles: ["critical-flow-fallback.json"],
  },
  // Custom: runOmittableGate minus the plain-consume — the verdict is
  // schema-validated + quarantined-loudly in the handler itself.
  intent_equivalence: {
    driven: "custom",
    incomingFiles: ["intent-equivalence-verdict.json"],
  },
  synthesis_narrative: { driven: "generic", incomingFiles: ["synthesis-narrative.json"] },
  // Custom: the per-kind blind-lane gate (design resolution 2) — one submission
  // file per charter kind, each validated (shape + kind purity + scope
  // grounding) and quarantined loudly per lane, tool-side merge only when every
  // lane is present + valid. The three estimator channels are the lane set at
  // every charter-authorizing ceiling; `true` is nominated by the delta miner
  // at deepest, never a lane (design resolution 4).
  charter_extraction: {
    driven: "custom",
    incomingFiles: [
      "charter-extraction-stated.json",
      "charter-extraction-structural.json",
      "charter-extraction-revealed.json",
    ],
  },
  charter_delta: { driven: "generic", incomingFiles: ["charter-delta.json"] },
  charter_clarification: { driven: "generic", incomingFiles: ["charter-clarification.json"] },
  systemic_challenge: { driven: "generic", incomingFiles: ["systemic-challenge.json"] },
};

export const HOST_GATE_KINDS: readonly HostGateKind[] = [
  "graph_enrichment",
  "critical_flow_fallback",
  "intent_equivalence",
  "design_review",
  "synthesis_narrative",
  "charter_extraction",
  "charter_delta",
  "charter_clarification",
  "systemic_challenge",
];

/**
 * Execute one deterministic audit step and record its progress. Throws (with
 * cause) if the executor fails, preserving the existing throw-with-cause pattern.
 * `index` is the 0-based fold position (the transition counter), surfaced as the
 * 1-based `iteration` in the `deterministic-progress.json` marker a
 * filesystem-watching host reads.
 */
export async function executeAndRecord(
  params: Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "externalAcquisition" | "since">,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  decision: ReturnType<typeof decideNextStep>,
  index: number,
  lastSummary: string,
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
    const result = await runAuditStep({
      root: params.root,
      artifactsDir: params.artifactsDir,
      analyzers,
      graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
      externalAcquisition: params.externalAcquisition,
      since: params.since,
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
    // O2: error-recovery is itself a load→modify→persist artifact-tree mutation
    // (runAuditStep has already released its lock by the time we reach this
    // catch), so hold the artifact-tree lock across the whole RMW.
    await withFileLock(artifactTreeLockPath(params.artifactsDir), async () => {
      const current = await loadArtifactBundle(params.artifactsDir);
      const currentState = deriveAuditState(current);
      currentState.last_executor = decision.selected_executor ?? undefined;
      currentState.last_obligation = decision.selected_obligation ?? undefined;
      await writeCoreArtifacts(params.artifactsDir, { ...current, audit_state: currentState });
    });
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      last_executor: decision.selected_executor,
      last_obligation: decision.selected_obligation,
      prior_summary: lastSummary || null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Deterministic executor ${decision.selected_executor} failed on obligation ${decision.selected_obligation} (iteration ${index + 1}, prior progress: ${lastSummary || "none"}): ${detail}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
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
}): Promise<TerminalStepResult | undefined> {
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
    return buildTerminalStep(
      ctx.params,
      ctx.bundle,
      ctx.state,
      "No-progress guard: a deterministic executor was about to re-run on an " +
        "artifact state it already processed this run without changing it " +
        `(obligation ${ctx.selectedObligation ?? "unknown"}, executor ` +
        `${ctx.selectedExecutor ?? "unknown"}). Stopping to avoid an infinite ` +
        "no-progress loop.",
    );
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
}): Promise<TerminalStepResult | undefined> {
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
  return buildTerminalStep(
    ctx.params,
    ctx.result.updated_bundle,
    ctx.result.audit_state,
    "Finalization is not converging: deterministic executors kept revisiting " +
      `prior artifact states (${cycle.join(" -> ")}). Review whether these ` +
      "obligations are erroneously invalidating each other.",
  );
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
interface AuditNextStepCtx {
  params: NextStepParams;
  analyzersRef: { value: Record<string, AnalyzerSetting> | undefined };
  lastSummaryRef: { value: string };
  /**
   * 0-based fold position == the hand loop's `index`. Incremented AFTER each
   * `transition` outcome (see `countTransitions`), so during any `execute` it
   * holds the index of the current iteration. The two guards read it as `index`.
   */
  iterationRef: { value: number };
  /** Pre-dispatch no-progress guard state (ARC-b8fed771): dispatched identities. */
  dispatchedSignatures: Set<string>;
  /** Finalization-cycle guard state: distinct post-execute artifact signatures. */
  seenStateSignatures: Set<string>;
  /** Finalization-cycle guard state: obligation order, for the cycle report. */
  obligationTrail: string[];
}

/** The engine state audit folds on: the in-memory bundle (reloaded per transition). */
type AuditEngineState = ArtifactBundle;

type AuditObligationDef = ObligationDef<
  AuditEngineState,
  AuditNextStepCtx,
  NextStepResult
>;

type AuditOutcome = ObligationOutcome<AuditEngineState, NextStepResult>;

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
  const decision = decideNextStep(bundle);

  const noProgress = await checkNoProgressBeforeDispatch({
    index: ctx.iterationRef.value,
    dispatchedSignatures: ctx.dispatchedSignatures,
    params: ctx.params,
    bundle,
    state: decision.state,
    selectedObligation: decision.selected_obligation,
    selectedExecutor: decision.selected_executor,
  });
  if (noProgress !== undefined) return { kind: "emit", step: noProgress };

  const result = await executeAndRecord(
    ctx.params,
    ctx.analyzersRef.value,
    decision,
    ctx.iterationRef.value,
    ctx.lastSummaryRef.value,
  );
  ctx.lastSummaryRef.value = result.progress_summary;
  if (!result.progress_made) {
    return blockedFromResult(result);
  }

  const cycle = await checkFinalizationCycle({
    index: ctx.iterationRef.value,
    obligationTrail: ctx.obligationTrail,
    seenStateSignatures: ctx.seenStateSignatures,
    tolerance: FINALIZATION_CYCLE_TOLERANCE,
    params: ctx.params,
    bundle,
    state: decision.state,
    result,
    selectedObligation: decision.selected_obligation,
  });
  if (cycle !== undefined) return { kind: "emit", step: cycle };

  return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
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
): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied" {
  return (bundle) => {
    if (bundle.audit_state?.status === "complete") return "satisfied";
    const state = deriveAuditState(bundle, {
    });
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
  const deterministic = (id: string): AuditObligationDef => ({
    id,
    derive: deriveObligationState(id),
    execute: (bundle, ctx) => runDeterministicExecutor(bundle, ctx),
  });

  return [
    deterministic("repo_manifest"),
    deterministic("file_disposition"),
    deterministic("auto_fixes_applied"),
    deterministic("syntax_resolved"),
    {
      // External analyzers: the Item B consent fold runs FIRST — applicable
      // consent-gated candidates with no recorded decision surface ONE batched
      // operator offer (or consume the arrived decisions file), and only then
      // does the deterministic acquisition executor run.
      id: "external_analyzers_current",
      derive: deriveObligationState("external_analyzers_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleAnalyzerConsentBranch(
          ctx.params,
          bundle,
          state,
          ctx.analyzersRef,
        );
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "continue") {
          return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
        }
        return runDeterministicExecutor(bundle, ctx);
      },
    },
    deterministic("structure_artifacts"),
    {
      // Critical-flow fallback: when deterministic flow inference fell below the
      // confidence bar, poll the host submission (persist it → structure re-merges
      // on the next fold) or emit the host step. No autonomous omit — the host is
      // always available to author the enrichment. Non-drainable (host_delegation),
      // so the drain stops here when a submission is still owed.
      id: "critical_flow_fallback_current",
      derive: deriveObligationState("critical_flow_fallback_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleCriticalFlowFallbackBranch(
          ctx.params,
          bundle,
          state,
        );
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        // continue: a submission was consumed + persisted — re-scan (structure
        // then re-stales + rebuilds critical_flows off the merged flows).
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
    {
      // Graph enrichment: poll the analyzer-decision / edge-reasoning incoming
      // artifacts first (emit a host step when one is needed), otherwise run the
      // deterministic enrichment executor.
      id: "graph_enrichment_current",
      derive: deriveObligationState("graph_enrichment_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleGraphEnrichmentBranch(
          ctx.params,
          bundle,
          state,
          ctx.analyzersRef,
        );
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "continue") {
          // A decisions/edge file was consumed (and possibly applied): re-scan on
          // the reloaded bundle without running the executor this turn.
          return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
        }
        // fallthrough: run the deterministic enrichment executor.
        return runDeterministicExecutor(bundle, ctx);
      },
    },
    deterministic("design_assessment_current"),
    deterministic("structure_decomposition_current"),
    deterministic("docs_digest_current"),
    {
      // Confirm-intent host step: the host writes intent_checkpoint.json (read by
      // deriveAuditState on re-invocation), so there is no incoming artifact to
      // consume — emit the step directly.
      id: "intent_checkpoint_current",
      derive: deriveObligationState("intent_checkpoint_current"),
      execute: async (bundle): Promise<AuditOutcome> => ({
        kind: "emit",
        step: { kind: "confirm_intent", state: deriveAuditState(bundle), bundle },
      }),
    },
    {
      // DD-9 intent-equivalence gate: consume a judge verdict (validated +
      // quarantined-loudly), resolve the deterministic arms in-fold (baseline
      // stamp / gate-version-stale / structured delta), or emit the bounded
      // prose-equivalence judge step. Sits between the intent checkpoint and
      // every consumer of it, so a pending judgment pauses the cascade instead
      // of racing it.
      id: "intent_equivalence_current",
      derive: deriveObligationState("intent_equivalence_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleIntentEquivalenceBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          return runDeterministicExecutor(bundle, ctx);
        }
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
    {
      // Charter extraction (Phase C): poll the incoming submission (ingest+gate),
      // omit at a shallow ceiling, or emit the host charter-extraction step at a
      // deep+ ceiling. Mirrors the synthesis-narrative branch.
      id: "charter_extraction_current",
      derive: deriveObligationState("charter_extraction_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleCharterExtractionBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          return runDeterministicExecutor(bundle, ctx);
        }
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
    {
      // Charter delta-mining (Phase C.2): poll the incoming delta submission
      // (route+gate it), settle deterministically when the register is not
      // deltas_pending (extraction omitted / no subsystems), or emit the host step
      // for the INDEPENDENT delta-miner when a deltas_pending register has no
      // submission yet. Mirrors the charter-extraction branch.
      id: "charter_delta_current",
      derive: deriveObligationState("charter_delta_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleCharterDeltaBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          return runDeterministicExecutor(bundle, ctx);
        }
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
    {
      // Contract design-review pass: poll incoming contract/conceptual findings;
      // emit the dispatch step when a pass still needs to run.
      id: "design_review_contract_completed",
      derive: deriveObligationState("design_review_contract_completed"),
      execute: (bundle, ctx) => runDesignReviewObligation(bundle, ctx),
    },
    {
      // Conceptual design-review pass: same incoming-poll handler (it resolves
      // which pass remains).
      id: "design_review_conceptual_completed",
      derive: deriveObligationState("design_review_conceptual_completed"),
      execute: (bundle, ctx) => runDesignReviewObligation(bundle, ctx),
    },
    {
      // Charter clarification (Phase D triangulation loop): poll incoming answers
      // (apply + re-split), assemble the loop deterministically at a shallow ceiling
      // / zero attention (autonomous), or emit the host step relaying the VOI-ranked
      // interactive queue at a deep+ ceiling with attention > 0. Non-drainable
      // (host_delegation), so the drain stops here.
      id: "charter_clarification_current",
      derive: deriveObligationState("charter_clarification_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleCharterClarificationBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          return runDeterministicExecutor(bundle, ctx);
        }
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
    {
      // Systemic challenge (Phase E loop-until-dry): poll the incoming adversary
      // round (fold it), omit at a shallow ceiling, or emit the second-order-adversary
      // host step when the loop is open at a deep+ ceiling. Non-drainable
      // (host_delegation), so the drain stops here.
      id: "systemic_challenge_current",
      derive: deriveObligationState("systemic_challenge_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleSystemicChallengeBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          return runDeterministicExecutor(bundle, ctx);
        }
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
    deterministic("planning_artifacts"),
    {
      // The audit-task dispatch obligation maps to the host-delegation
      // semantic_review_executor (no deterministic runner) → host review.
      id: "audit_tasks_completed",
      derive: deriveObligationState("audit_tasks_completed"),
      execute: (bundle, ctx) => runHostDelegationObligation(bundle, ctx),
    },
    deterministic("audit_results_ingested"),
    deterministic("runtime_validation_current"),
    deterministic("synthesis_current"),
    {
      // Synthesis narrative: poll the incoming narrative; emit the host step when
      // narrative is enabled and not yet supplied, otherwise the deterministic
      // omit runs (fold on).
      id: "synthesis_narrative_current",
      derive: deriveObligationState("synthesis_narrative_current"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const state = deriveAuditState(bundle);
        const branch = await handleSynthesisNarrativeBranch(ctx.params, bundle, state);
        if (branch.action === "return") {
          return { kind: "emit", step: branch.result };
        }
        if (branch.action === "run_omit") {
          // Narrative disabled: run the deterministic omit executor so the
          // status:omitted marker is written and the obligation is satisfied.
          // (A bare reload here would leave it actionable and spin the fold.)
          return runDeterministicExecutor(bundle, ctx);
        }
        // continue: an incoming narrative was consumed + applied — re-scan.
        return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
      },
    },
  ];
}

/** Shared design-review-pass executor (both pass obligations route here). */
async function runDesignReviewObligation(
  bundle: ArtifactBundle,
  ctx: AuditNextStepCtx,
): Promise<AuditOutcome> {
  const state = deriveAuditState(bundle);
  const branch = await handleDesignReviewBranch(ctx.params, bundle, state);
  if (branch.action === "return") {
    return { kind: "emit", step: branch.result };
  }
  return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
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
  const decision = decideNextStep(bundle);
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
  if (currentRun) {
    let acceptedResults: Awaited<
      ReturnType<typeof ingestAuditHostResults>
    >["accepted_results"] = [];
    try {
      acceptedResults = (
        await ingestAuditHostResults({
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          runId: currentRun.run_id,
        })
      ).accepted_results;
    } catch (error) {
      // No handoff exists on the first visit, or prepare was interrupted before
      // all binding artifacts landed. Re-preparing below restores it exactly.
      if (!isFileMissingError(error)) throw error;
    }

    const pendingIds = new Set(
      buildPendingAuditTasks(bundle).map((task) => task.task_id),
    );
    const pendingAccepted = acceptedResults.filter((result) =>
      pendingIds.has(result.task_id),
    );
    if (pendingAccepted.length > 0) {
      const ingested = await runAuditStep({
        root: ctx.params.root,
        artifactsDir: ctx.params.artifactsDir,
        preferredExecutor: "result_ingestion_executor",
        auditResultsData: [...pendingAccepted],
      });
      return { kind: "transition", state: ingested.updated_bundle };
    }
  }

  const review = await ensureSemanticReviewRun({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle,
    state,
    obligationId: decision.selected_obligation,
    selfCliPath: ctx.params.selfCliPath,
    timeoutMs: ctx.params.timeoutMs,
  });
  return {
    kind: "emit",
    step: {
      kind: "semantic_review",
      selectedExecutor: decision.selected_executor,
      ...review,
    },
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
  return { kind: "emit", step: { kind: "blocked", state, bundle, reason } };
}

/**
 * Wrap each obligation so the transition counter advances exactly once per fold
 * iteration — the analog of the hand loop's `index++`. Incrementing AFTER a
 * `transition` (and never on an `emit`, which exits the fold) means during any
 * `execute` the counter holds the current iteration's 0-based index, which the
 * two cycle guards read as `index`. Single point of truth so a new obligation
 * cannot forget to count.
 */
function countTransitions(obligations: AuditObligationDef[]): AuditObligationDef[] {
  return obligations.map((obligation) => ({
    ...obligation,
    execute: async (bundle: ArtifactBundle, ctx: AuditNextStepCtx) => {
      const outcome = await obligation.execute(bundle, ctx);
      if (outcome.kind === "transition") ctx.iterationRef.value += 1;
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
    iterationRef: { value: 0 },
    dispatchedSignatures: new Set<string>(),
    seenStateSignatures: new Set<string>(),
    obligationTrail: [],
  };

  const startBundle = await loadArtifactBundle(params.artifactsDir);
  let outcome: Awaited<ReturnType<typeof advance<ArtifactBundle, AuditNextStepCtx, NextStepResult>>>;
  try {
    outcome = await advance(
      {
        priority: PRIORITY,
        obligations: countTransitions(buildAuditObligations()),
      },
      startBundle,
      ctx,
    );
  } catch (err) {
    // maxTransitions is the engine's runaway backstop, and audit deliberately
    // supplies no stateSignature (cycle detection lives in ctx-level guards with
    // tolerance windows). A cause those guards miss — observed 2026-07-30: an
    // errored rolling packet left `audit_tasks_completed` actionable while its
    // error-shaped result files made the pending frontier look answered — used
    // to CRASH next-step with exit 1, where the same class of stall
    // (no_capable_pool) gets a graceful resumable pause. Convert the throw into
    // that same resumable blocked step, naming the spinning obligation so the
    // cause is actionable rather than a stack trace.
    if (err instanceof Error && err.message.includes("exceeded maxTransitions")) {
      const bundle = await loadArtifactBundle(params.artifactsDir);
      const decision = decideNextStep(bundle);
      return {
        kind: "blocked",
        state: decision.state,
        bundle,
        reason:
          `The deterministic fold made ${DEFAULT_MAX_TRANSITIONS}+ transitions without reaching a ` +
          `host-actionable step — an obligation is re-selecting without clearing its own actionable ` +
          `state (${err.message.match(/last selected obligation was "([^"]+)"/)?.[1] ?? "unknown"}). ` +
          "The run is paused resumably, not crashed: inspect the run's task-results/ for error-shaped " +
          "result files whose tasks never completed (delete them to re-dispatch those tasks), or hand " +
          "results in with `audit-code ingest-results --results <file>`; then re-run next-step.",
      };
    }
    throw err;
  }

  if (outcome.step) return outcome.step;

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
    const triage = await decideAuditFrictionCloseout(params.artifactsDir, "run");
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
