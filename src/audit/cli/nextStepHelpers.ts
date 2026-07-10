/**
 * Extracted helpers for the next-step command.
 *
 * Splitting these out of nextStepCommand.ts reduces that file to just the
 * top-level cmdNextStep dispatcher, keeping each module focused on a single
 * concern.
 */

import { access, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  advance,
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
  readProviderConfirmationInput,
  type ObligationDef,
  type ObligationOutcome,
} from "audit-tools/shared";
import type {
  AnalyzerSetting,
  GraphEdge,
  SessionConfig,
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
  shouldDemotePrimaryInProcess,
  withFileLock,
} from "audit-tools/shared";
import type { AuditState } from "../types/auditState.js";
import type { Finding } from "../types.js";
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
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";
import type { EdgeReasoningResults } from "../orchestrator/edgeReasoning.js";
import {
  graphEnrichmentUnresolvedAnalyzers,
  graphEnrichmentLowConfidenceEdges,
} from "../orchestrator/hostInputPause.js";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import {
  persistAnalyzerSettings,
} from "../supervisor/sessionConfig.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import { WORKER_COMMAND_PROVIDER_NAME } from "../providers/constants.js";
import { clearDispatchFiles } from "../io/runArtifacts.js";
import { runAuditStep } from "./auditStep.js";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";
import {
  writeHandoffOnly,
  ensureSemanticReviewRun,
  materializeReviewRun,
} from "./reviewRun.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import {
  driveRollingAuditDispatch,
  resolveAuditRollingEngineEnabled,
  resolvesToInProcessDispatchProvider,
} from "./rollingAuditDispatch.js";
import {
  buildAuditSourcePools,
  isInProcessAuditPool,
  auditNodeClaimRegistry,
  auditHybridSettledPath,
} from "./hybridDispatch.js";
import { planHybridDispatch, readSettledPools, addSettledPool } from "audit-tools/shared";
import { resolveHostDispatchCapability } from "./args.js";

// ── In-process dispatch: bounded no-progress retry (D1, NIM/Codex fix set) ─────

/** Injectable clock — tests pass no-ops so the retry loop is instant and deterministic. */
export interface DriveNoProgressRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Re-drive an in-process rolling dispatch up to `maxRetries` times with exponential
 * backoff WHILE `isNoProgress` holds. A fully-unproductive pass — every review packet
 * errored at the provider so nothing ingested, nothing stranded, no pause — otherwise
 * trips the no-progress guard and HALTS the run; a transient provider overload (a
 * burst of fast 5xx/errors) should self-heal instead. Bounded (terminates on
 * persistent failure) and paced, so a genuinely stuck pass still falls through to the
 * blocked handoff. Re-driving is exactly what the whole next-step loop does across
 * invocations — the still-pending tasks re-dispatch — collapsed into one step so an
 * autonomous loop that treats `blocked` as terminal doesn't halt on a blip.
 *
 * `maxTotalMs` bounds the added wall-time: retries stop once the cumulative elapsed
 * time reaches it. Set to the dispatch timeout so an all-TIMEOUT pass (where the first
 * drive alone already consumes ~one timeout window) spawns no expensive extra passes —
 * the retry stays targeted at fast-failing passes, which is where it self-heals.
 */
export async function driveWithNoProgressRetry<T>(
  drive: () => Promise<T>,
  isNoProgress: (result: T) => boolean,
  opts: { maxRetries: number; baseBackoffMs: number; maxTotalMs?: number; deps?: DriveNoProgressRetryDeps },
): Promise<T> {
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.deps?.now ?? (() => Date.now());
  const start = now();
  let result = await drive();
  for (let attempt = 1; attempt <= opts.maxRetries && isNoProgress(result); attempt += 1) {
    if (opts.maxTotalMs != null && now() - start >= opts.maxTotalMs) break;
    await sleep(opts.baseBackoffMs * 2 ** (attempt - 1));
    result = await drive();
  }
  return result;
}

// ── Incoming-artifact helper ──────────────────────────────────────────────────

/**
 * Read a JSON file from the `incoming/` subdirectory of `artifactsDir`.
 * Returns `{ value, path }` when the file exists and parses successfully.
 * Returns `undefined` when the file is absent (ENOENT-family errors).
 * Re-throws all other IO errors unchanged.
 */
export async function tryConsumeIncoming<T>(
  artifactsDir: string,
  filename: string,
): Promise<{ value: T; path: string } | undefined> {
  const filePath = join(artifactsDir, "incoming", filename);
  try {
    const value = await readJsonFile<T>(filePath);
    return { value, path: filePath };
  } catch (error) {
    if (isFileMissingError(error)) return undefined;
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
  /**
   * Active session config. Threaded so the semantic-review dispatch obligation can
   * route to the in-process rolling driver (A8(a)) when the rolling engine is
   * enabled AND an explicit backend provider is configured.
   */
  sessionConfig?: SessionConfig;
  /**
   * Defect-1: whether an attended conversation host is driving this invocation and can
   * fan out subagents (the already-resolved `resolveHostDispatchCapability` value from
   * the CLI, folding the explicit `--host-can-dispatch-subagents` flag). When TRUE
   * (default, conversation-first), a configured in-process backend is DEMOTED to a
   * source pool so the host + backend + any NIM source fan out concurrently instead of
   * the backend monopolizing the frontier. When FALSE (declared headless), the backend
   * self-drives the whole frontier. Unset here falls back to the sessionConfig field /
   * env / true via `resolveHostDispatchCapability` in the fold.
   */
  hostCanDispatch?: boolean;
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
  | { kind: "semantic_review"; state: AuditState; bundle: ArtifactBundle; activeReviewRun: ActiveReviewRun; selectedExecutor?: string | null }
  | { kind: "design_review"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_parallel"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_contract"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "design_review_conceptual"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "charter_extraction"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "charter_delta"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "charter_clarification"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "systemic_challenge"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "confirm_intent"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "provider_confirmation"; state: AuditState; bundle: ArtifactBundle }
  | { kind: "analyzer_install"; state: AuditState; bundle: ArtifactBundle; unresolved: AnalyzerPlanEntry[] }
  | { kind: "edge_reasoning"; state: AuditState; bundle: ArtifactBundle; candidates: GraphEdge[] }
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
  const alreadyPromoted = await access(promotedPath).then(() => true).catch(() => false);
  if (alreadyPromoted) return promotedPath;
  if (triage.action === "dispose") {
    // Friction triage still pending — keep the in-place report, do not delete.
    return auditReportPath(artifactsDir);
  }
  const promoted = await promoteFinalAuditReport({ artifactsDir });
  return promoted.promoted ? promotedPath : auditReportPath(artifactsDir);
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
    providerName: WORKER_COMMAND_PROVIDER_NAME,
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
): Promise<GraphEnrichmentBranchResult> {
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
    const incoming = await tryConsumeIncoming<Record<string, unknown>>(
      params.artifactsDir,
      "analyzer-decisions.json",
    );
    if (incoming && incoming.value !== null && typeof incoming.value === "object") {
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
        const merged = await persistAnalyzerSettings(
          params.artifactsDir,
          settings,
        );
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
      const edgeReasoningIncoming = await tryConsumeIncoming<EdgeReasoningResults>(
        params.artifactsDir,
        "edge-reasoning.json",
      );
      if (edgeReasoningIncoming) {
        await runAuditStep({
          root: params.root,
          artifactsDir: params.artifactsDir,
          analyzers: analyzersRef.value,
          graphLlmEdgeReasoning: true,
          edgeReasoningResultsPath: edgeReasoningIncoming.path,
          since: params.since,
        });
        await unlink(edgeReasoningIncoming.path).catch(() => {});
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
  | { action: "return"; result: { kind: "design_review"; state: AuditState; bundle: ArtifactBundle } }
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

export async function handleDesignReviewBranch(
  params: Pick<NextStepParams, "artifactsDir">,
  bundle: ArtifactBundle,
  state: AuditState,
): Promise<BranchActionResult> {
  const existing = bundle.design_assessment;

  // Legacy: consume old combined findings file. Always unlink when present to
  // prevent accumulation, even when design_assessment is absent (COR-68f07c3e).
  const legacyIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-findings.json",
  );
  if (legacyIncoming) {
    await unlink(legacyIncoming.path).catch(() => {});
    if (Array.isArray(legacyIncoming.value) && existing) {
      existing.review_findings = groundDesignFindings(legacyIncoming.value, bundle.repo_manifest);
      existing.reviewed = true;
      await writeJsonFile(
        join(params.artifactsDir, "design_assessment.json"),
        existing,
      );
      return { action: "continue" };
    }
    // File consumed (deleted) but no target to merge into — keep folding.
    return { action: "continue" };
  }

  // New: consume contract-findings and/or conceptual-findings independently.
  const contractIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-contract-findings.json",
  );
  const conceptualIncoming = await tryConsumeIncoming<Finding[]>(
    params.artifactsDir,
    "design-review-conceptual-findings.json",
  );

  let consumed = false;

  // Always delete incoming files when present; only merge data when existing
  // design_assessment is present (COR-68f07c3e).
  if (contractIncoming) {
    await unlink(contractIncoming.path).catch(() => {});
    if (Array.isArray(contractIncoming.value) && existing) {
      existing.contract_findings = groundDesignFindings(contractIncoming.value, bundle.repo_manifest);
      existing.contract_reviewed = true;
      consumed = true;
    }
  }

  if (conceptualIncoming) {
    await unlink(conceptualIncoming.path).catch(() => {});
    if (Array.isArray(conceptualIncoming.value) && existing) {
      existing.conceptual_findings = groundDesignFindings(conceptualIncoming.value, bundle.repo_manifest);
      existing.conceptual_reviewed = true;
      consumed = true;
    }
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
    if (contractIncoming) {
      await captureDesignReviewSnapshot(
        params.artifactsDir,
        "contract",
        existing.contract_findings ?? [],
        bundle,
        reviewedAt,
      );
    }
    if (conceptualIncoming) {
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
  const incoming = await tryConsumeIncoming<TIncoming>(params.artifactsDir, descriptor.filename);
  if (incoming) {
    await descriptor.apply(incoming.value, incoming.path, params);
    await unlink(incoming.path).catch(() => {});
    return { action: "continue" };
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
  return runOmittableGate<unknown, "charter_extraction">(
    {
      kind: "charter_extraction",
      filename: "charter-extraction.json",
      apply: async (_value, path, p) => {
        await runAuditStep({
          root: p.root,
          artifactsDir: p.artifactsDir,
          preferredExecutor: "charter_extraction_executor",
          charterSubmissionPath: path,
        });
      },
      // Shallow ceiling (default): omit deterministically, no host turn.
      shouldOmit: (b) => !ceilingRequestsCharters(resolveCharterCeiling(b.intent_checkpoint)),
    },
    params,
    bundle,
    state,
  );
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
 * Coverage registry for the 7 audit host-gate branch handlers targeted by the
 * Tier C2 consolidation. `driven: "generic"` gates are fully parameterized
 * through `runOmittableGate`; `driven: "custom"` gates keep their own bespoke
 * body because their shape genuinely deviates from that common one — see the
 * section comment above `runOmittableGate` for exactly what deviates and why.
 * Exists so one source of truth enumerates all 7 gate kinds (asserted by a
 * coverage test) rather than the count being implicit in which functions
 * happen to exist.
 */
export type HostGateKind =
  | "graph_enrichment"
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
  synthesis_narrative: { driven: "generic", incomingFiles: ["synthesis-narrative.json"] },
  charter_extraction: { driven: "generic", incomingFiles: ["charter-extraction.json"] },
  charter_delta: { driven: "generic", incomingFiles: ["charter-delta.json"] },
  charter_clarification: { driven: "generic", incomingFiles: ["charter-clarification.json"] },
  systemic_challenge: { driven: "generic", incomingFiles: ["systemic-challenge.json"] },
};

export const HOST_GATE_KINDS: readonly HostGateKind[] = [
  "graph_enrichment",
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
  if (!isHostDelegationExecutor(result.selected_executor ?? "")) {
    await clearDispatchFiles(ctx.params.artifactsDir);
  }
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
    const state = deriveAuditState(bundle);
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
export function buildAuditObligations(): AuditObligationDef[] {
  const deterministic = (id: string): AuditObligationDef => ({
    id,
    derive: deriveObligationState(id),
    execute: (bundle, ctx) => runDeterministicExecutor(bundle, ctx),
  });

  return [
    // Provider confirmation gate (Gate-0, interactive on the conversation-first
    // CLI path): pause for the operator to confirm/reorder the priced provider
    // pool + optionally self-report a host model roster. The operator writes
    // `provider-confirmation.input.json`; its presence flips this obligation from
    // "emit the step" to "consume the input" — the deterministic executor then
    // promotes it into both canonical artifacts (per-tool seam + shared
    // confirmation). Headless (`advanceAudit`, no CLI) never reaches here and
    // auto-completes with the tool's price-ascending suggestion. See
    // spec/cost-first-routing.md.
    {
      id: "provider_confirmation",
      derive: deriveObligationState("provider_confirmation"),
      execute: async (bundle, ctx): Promise<AuditOutcome> => {
        const input = await readProviderConfirmationInput(ctx.params.artifactsDir);
        if (input) {
          // Operator has submitted → consume it (writes both canonical artifacts).
          return runDeterministicExecutor(bundle, ctx);
        }
        // Otherwise pause for the operator — ALWAYS on the interactive CLI path,
        // even with one (or zero) auto-detected provider: the operator may want to
        // ADD a provider discovery missed, exclude one, or reorder. Headless
        // (`advanceAudit`, no CLI host) never reaches here and auto-completes.
        return {
          kind: "emit",
          step: {
            kind: "provider_confirmation",
            state: deriveAuditState(bundle),
            bundle,
          },
        };
      },
    },
    deterministic("repo_manifest"),
    deterministic("file_disposition"),
    deterministic("auto_fixes_applied"),
    deterministic("syntax_resolved"),
    deterministic("external_analyzers_current"),
    deterministic("structure_artifacts"),
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
      // rolling_dispatch_executor (no deterministic runner) → semantic review.
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
 * rolling_dispatch_executor, no deterministic runner): materialize the semantic
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
    // Not host-delegation and no deterministic graph_enrichment/design-review
    // handler claimed it: fall back to the deterministic executor path (which
    // emits blocked when the runner is absent / makes no progress).
    return runDeterministicExecutor(bundle, ctx);
  }

  // Defect-1 attended/headless gate: an attended conversation host (host can dispatch
  // subagents — the conversation-first default) drives the fan-out ITSELF and DEMOTES a
  // configured in-process backend to a source pool (the hybrid path below), so host +
  // backend + NIM run concurrently. The in-process whole-frontier driver fires ONLY when
  // the run is headless (`host_can_dispatch_subagents:false` — no attended dispatcher),
  // where the backend legitimately self-drives.
  const sessionConfig = ctx.params.sessionConfig;
  const hostCanDispatch = resolveHostDispatchCapability({
    explicit: ctx.params.hostCanDispatch,
    sessionConfig: sessionConfig ?? ({} as SessionConfig),
  });

  // A8(a) in-process provider driver: when the rolling engine is enabled, the run is
  // HEADLESS, AND the operator EXPLICITLY configured a programmatic backend provider
  // (openai-compatible / codex / opencode), the orchestrator drives the WHOLE
  // semantic-review dispatch ITSELF — the provider is the per-packet worker —
  // instead of emitting a host-subagent dispatch step. It `transition`s once the
  // results are ingested so the fold re-derives state (the obligation-engine analog
  // of the hand loop's `continue`), mirroring remediate's decideNextStep transition
  // after driveRollingImplementDispatch.
  if (
    resolveAuditRollingEngineEnabled({ sessionConfig }) &&
    !hostCanDispatch &&
    resolvesToInProcessDispatchProvider(sessionConfig)
  ) {
    const { activeReviewRun } = await materializeReviewRun({
      root: ctx.params.root,
      artifactsDir: ctx.params.artifactsDir,
      bundle,
      obligationId: decision.selected_obligation,
      selfCliPath: ctx.params.selfCliPath,
      timeoutMs: ctx.params.timeoutMs,
    });
    // D1: a transient all-errored pass (nothing ingested/stranded, not paused) is
    // retried with backoff before we honour the no-progress guard, so a burst of
    // provider 5xx/timeouts self-heals instead of halting the autonomous loop.
    const driven = await driveWithNoProgressRetry(
      () =>
        driveRollingAuditDispatch({
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          activeReviewRun,
          sessionConfig: sessionConfig!,
          timeoutMs: ctx.params.timeoutMs,
        }),
      (d) => d.status !== "paused" && !d.ingest && d.stranded_ids.length === 0,
      // Bound total added wall-time to one dispatch-timeout window: an all-timeout
      // pass (first drive ≈ timeoutMs) then spawns no extra passes; only a fast-failing
      // pass, where the retry actually helps, gets re-driven.
      { maxRetries: 2, baseBackoffMs: 500, maxTotalMs: ctx.params.timeoutMs },
    );
    await clearDispatchFiles(ctx.params.artifactsDir);
    // Resumable pause (DC-4): the pool exhausted after spill and the run is paused
    // on a `waiting_for_provider` state, persisted on the active-dispatch artifact.
    // Emit a resumable blocked handoff — re-invoking `next-step` re-discovers
    // capacity and `advancePausedState` resumes or, after the pause limit, promotes
    // to a partial-completion terminal. This is NOT a no-progress spin: the paused
    // state advances each pass toward resume-or-livelock.
    if (driven.status === "paused") {
      const paused = driven.paused_state;
      const pauseCount = paused?.lifecycle.pause_count ?? 0;
      return {
        kind: "emit",
        step: {
          kind: "blocked",
          state,
          bundle,
          reason:
            `In-process rolling dispatch paused waiting for provider capacity: ` +
            `${driven.stranded_ids.length} review packet(s) are stranded on an exhausted ` +
            `provider pool (provider '${sessionConfig?.provider}', pause ${pauseCount + 1}). ` +
            "The run is resumable — re-run next-step once provider capacity returns; " +
            "it will resume automatically, or yield to synthesis on partial coverage after the pause limit.",
        },
      };
    }
    // Convergence guard: a pass that ingested NO new results and stranded nothing
    // (every packet errored at the provider) made no net progress, and
    // re-dispatching the same unchanged state would loop to the maxTransitions
    // backstop. Emit the block rather than spin. Progress (ingest ran, or a strand
    // terminal was recorded) `transition`s so the fold re-derives normally.
    if (!driven.ingest && driven.stranded_ids.length === 0) {
      return {
        kind: "emit",
        step: {
          kind: "blocked",
          state,
          bundle,
          reason:
            `In-process rolling dispatch produced no results for ${driven.packet_count} ` +
            `review packet(s) (provider '${sessionConfig?.provider}' errored on every packet, and a ` +
            "bounded auto-retry did not recover); stopping to avoid a no-progress loop. " +
            "Recovery: once the backend is healthy, re-run next-step to re-dispatch; or hand the review " +
            "results in directly with `audit-code ingest-results --results <file>` (or drop AuditResult[] " +
            "files into the run's task-results/ dir, matched by task_id).",
        },
      };
    }
    return {
      kind: "transition",
      state: await loadArtifactBundle(ctx.params.artifactsDir),
    };
  }

  // A-8 hybrid: when the rolling engine is enabled AND a backend (NIM) pool is
  // configured alongside the conversation host, split the pending review tasks via the
  // SAME shared coordinator remediate drives — review the NIM partition IN-PROCESS this
  // cycle (claimed, exactly-one-claimant), then materialize the host review over the
  // COMPLEMENT so the two never review the same task (coverage folds both by task_id).
  // When NIM covers the whole frontier, transition to the fold; otherwise fall through
  // to the host-review emit below over the freshly-ingested coverage. Inert when no NIM
  // pool is confirmed (the existing host-review path is unchanged).
  let reviewBundle = bundle;
  let reviewState = state;
  const hybridCfg = sessionConfig ?? ({} as SessionConfig);
  // Defect-1: an attended host (reached here because the headless in-process branch
  // above was skipped) demotes its configured primary in-process backend into the
  // source-pool set, so the hybrid split fans the frontier across host + backend + NIM.
  const auditSourcePools = await buildAuditSourcePools(hybridCfg, {
    // B1 same-agent guard: don't demote the primary backend to a source when the
    // conversation host IS that provider (one account ⇒ host self-drives; else the
    // host pool and the demoted-source pool double-book a single meter).
    demotePrimaryInProcess: shouldDemotePrimaryInProcess({
      sessionConfig: hybridCfg,
      hostCanDispatch,
    }),
  });
  if (resolveAuditRollingEngineEnabled({ sessionConfig }) && auditSourcePools.length > 0) {
    const pending = buildPendingAuditTasks(bundle);
    if (pending.length > 0) {
      // DC-4: read the cross-cycle settled-pool set; a NIM pool exhausted on a prior
      // cycle is excluded from this split, so its stranded tasks route to the host.
      const settledPath = auditHybridSettledPath(ctx.params.artifactsDir);
      const settled = await readSettledPools(settledPath);
      const partition = await planHybridDispatch({
        // Flat estimate: the coordinator bounds NIM by SLOTS, so uniform is sufficient.
        frontier: pending.map((t) => ({ id: t.task_id, estimatedTokens: 2000 })),
        // Audit passes ONLY the NIM pool(s): the coordinator bounds NIM to its capacity
        // and claims those tasks; the rest stay pending for the batch host review.
        pools: auditSourcePools,
        sessionConfig: hybridCfg,
        claimRegistry: auditNodeClaimRegistry(ctx.params.artifactsDir),
        readSettled: () => settled,
        onSettle: async (id) => {
          settled.add(id);
          await addSettledPool(settledPath, id);
        },
        isInProcess: isInProcessAuditPool,
      });
      if (partition.inProcess.length > 0) {
        const nimIds = new Set(partition.inProcess.map((a) => a.nodeId));
        const nimTasks = pending.filter((t) => nimIds.has(t.task_id));
        const complement = pending.filter((t) => !nimIds.has(t.task_id));
        // Materialize the in-process review run over the NIM PARTITION — its
        // `pending-audit-tasks.json` is what `driveRollingAuditDispatch`'s mergeAndIngest
        // reads to know which results to fold, so it MUST list the NIM tasks (else the
        // NIM results are reviewed but never ingested). The host then reviews the
        // coverage-driven complement below: once these NIM tasks are ingested+covered,
        // `buildPendingAuditTasks` excludes them, so `ensureSemanticReviewRun` re-derives
        // exactly the complement. (`complement` is computed only for the skip-host guard.)
        const { activeReviewRun } = await materializeReviewRun({
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          bundle,
          obligationId: decision.selected_obligation,
          selfCliPath: ctx.params.selfCliPath,
          timeoutMs: ctx.params.timeoutMs,
          tasksOverride: nimTasks,
          // This in-process run is EPHEMERAL — it must not own the host-facing dispatch
          // pointer, or `ensureSemanticReviewRun` below would reuse this NIM partition's
          // task set instead of re-deriving the full coverage-driven host complement.
          updateDispatch: false,
        });
        // Review the NIM partition in-process into the SAME run's task-results/ + ingest.
        const driven = await driveRollingAuditDispatch({
          root: ctx.params.root,
          artifactsDir: ctx.params.artifactsDir,
          activeReviewRun,
          sessionConfig: hybridCfg,
          timeoutMs: ctx.params.timeoutMs,
          tasksOverride: nimTasks,
          poolsOverride: auditSourcePools,
        });
        // Terminal accept for each in-process task → free its coordinator claim.
        for (const a of partition.inProcess) {
          await partition.coordinator.release(a);
        }
        // DC-4: the NIM pool exhausted (paused / livelock-partial) and could not carry
        // its partition → settle it (cross-cycle) so the next cycle excludes it and the
        // stranded review tasks fall back to the batch host review instead of re-looping.
        if (driven.status !== "complete") {
          for (const pool of auditSourcePools) {
            await partition.coordinator.settlePool(pool.id);
          }
        }
        if (complement.length === 0) {
          // NIM reviewed the whole frontier — nothing left for the host this obligation.
          await clearDispatchFiles(ctx.params.artifactsDir);
          return { kind: "transition", state: await loadArtifactBundle(ctx.params.artifactsDir) };
        }
        // Reload so the host-review emits over coverage that now reflects the NIM results
        // (and never writes the stale pre-NIM bundle back over them).
        reviewBundle = await loadArtifactBundle(ctx.params.artifactsDir);
        reviewState = deriveAuditState(reviewBundle);
      }
    }
  }

  const review = await ensureSemanticReviewRun({
    root: ctx.params.root,
    artifactsDir: ctx.params.artifactsDir,
    bundle: reviewBundle,
    state: reviewState,
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
    providerName: WORKER_COMMAND_PROVIDER_NAME,
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
  const outcome = await advance(
    { priority: PRIORITY, obligations: countTransitions(buildAuditObligations()) },
    startBundle,
    ctx,
  );

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
      providerName: WORKER_COMMAND_PROVIDER_NAME,
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
