import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditResult } from "../types.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { AnalyzerSetting, SynthesisNarrative, RunLogger, CharterSubmission, CharterDeltaSubmission, ClarificationAnswersSubmission, SystemicChallengeSubmission, CriticalFlowFallbackResult, SessionConfig, NewlyReachableBackend } from "audit-tools/shared";
import type { EdgeReasoningResults } from "./edgeReasoning.js";
import type { ExternalAcquisitionAdvanceOptions } from "./acquisitionExecutor.js";

/**
 * Public input/output contract of `advanceAudit`. Lives in this leaf module —
 * imported by both `advance.ts` and `executorRunners.ts` — so the executor runners
 * can type their `AuditExecutorCtx.options` on `AdvanceAuditOptions` without a
 * back-import into `advance.ts`, keeping the orchestrator import graph acyclic
 * (ARC-1fa005bb: madge counts type-only edges).
 */
export interface AdvanceAuditOptions {
  root?: string;
  /**
   * Directory the artifact bundle is persisted to (`.audit-tools/audit/`). The
   * intake executor writes `scope_summary.json` here directly (a side-artifact,
   * not a typed bundle field) so the host loader can read the scope it advertises;
   * absent → the side-write is skipped (the typed `scope_summary` channel still
   * carries it in-process).
   */
  artifactsDir?: string;
  lineIndex?: Record<string, number>;
  /** Path → size_bytes (from the repo manifest); drives byte-based packet token sizing. */
  sizeIndex?: Record<string, number>;
  auditResults?: AuditResult[];
  runtimeValidationUpdates?: RuntimeValidationReport;
  /** Single imported tool payload (one file = one tool); the import executor upserts it into the bundle's per-tool array. */
  externalAnalyzerResults?: ExternalAnalyzerResults;
  /** Host/provider-supplied synthesis narrative; merged by synthesis_narrative_executor. */
  narrativeResults?: SynthesisNarrative;
  /** Host-supplied critical-flow fallback enrichment; persisted by critical_flow_fallback_executor (the structure phase then merges it). */
  criticalFlowFallbackResults?: CriticalFlowFallbackResult;
  /** Host-supplied charter-extraction submission (Phase C.1); assembled by charter_extraction_executor. */
  charterSubmission?: CharterSubmission;
  /** Host-supplied charter-delta submission (Phase C.2); mined by charter_delta_executor (independent delta-miner). */
  charterDeltaSubmission?: CharterDeltaSubmission;
  /** Host-supplied charter-clarification answers (Phase D); applied by charter_clarification_executor. */
  clarificationAnswers?: ClarificationAnswersSubmission;
  /** Host-supplied second-order-adversary challenge round (Phase E); folded by systemic_challenge_executor. */
  systemicChallenge?: SystemicChallengeSubmission;
  /** Per-analyzer resolution policy for the optional graph-enrichment pass. */
  analyzers?: Record<string, AnalyzerSetting>;
  /**
   * External-analyzer acquisition gate (Slice D). Absent/`enabled:false` ⇒ the
   * acquisition executor writes an empty marker and spawns nothing (hermetic;
   * the unit/integration suite always leaves it off). The real CLI next-step path
   * sets `enabled:true` + a global-`fetch` adapter so gitleaks (+ consent-gated
   * semgrep/eslint) acquire + run.
   */
  externalAcquisition?: ExternalAcquisitionAdvanceOptions;
  /** Phase 4B gate (session-config `graph.llm_edge_reasoning`); default off. */
  graphLlmEdgeReasoning?: boolean;
  /** Phase 4B host-supplied reason rewrites for low-confidence graph edges. */
  edgeReasoningResults?: EdgeReasoningResults;
  /**
   * Git ref for Phase 3 delta mode (the `--since` flag). When set and resolvable
   * against a git repo, planning scopes coverage to the changed files and their
   * graph neighbours; otherwise the run is a full audit.
   */
  since?: string;
  preferredExecutor?: string;
  runLogger?: RunLogger;
  /**
   * G2: the EFFECTIVE dispatch config (the per-auditor descriptor resolved over the
   * repo INTENT; `resolveSessionConfig`). Threaded so the executors that read dispatch
   * inventory — `provider_confirmation_executor`, which CONSUMES the operator
   * confirmation and PERSISTS the routed pool — build/persist from the descriptor, not a
   * re-read of the raw repo config. Absent ⇒ the executor falls back to the repo INTENT
   * resolved to driver-self-only. See `spec/unified-dispatch-worker-model.md`.
   */
  sessionConfig?: SessionConfig;
  /**
   * G3 reconciliation gate state, threaded BY REFERENCE. See
   * {@link ProviderConfirmationGateState} for why it is mutable rather than a value.
   * Absent ⇒ nothing to reconcile (every non-CLI caller).
   */
  providerConfirmationGate?: ProviderConfirmationGateState;
}

/**
 * The G3 reconciliation gate's per-invocation state — deliberately MUTABLE, and
 * threaded by reference through every layer that derives or dispatches.
 *
 * Why not a frozen value: the delta is `REACH-NOW \ CONFIRMED`. REACH-NOW is
 * invocation-stable (env/PATH does not move mid-run) and expensive (~6 `spawnSync`),
 * so it is computed once. CONFIRMED, however, CHANGES the moment
 * `provider_confirmation_executor` promotes — and the only thing that ever changes it
 * is that executor. A frozen delta therefore stays non-empty for the rest of the
 * drain even after the backends have been folded into the confirmed pool, and since
 * `provider_confirmation` is `PRIORITY[0]` the obligation is re-selected forever:
 * autonomous re-promotes until `advance` throws on `maxTransitions`, attended
 * re-emits a delta prompt that is now a lie. The delta genuinely clears only via the
 * promotion, so the promotion is what must clear it.
 *
 * `deriveAuditState` stays pure: it receives the delta as an argument. This object is
 * the thing that carries the CURRENT value to each derivation — including the ones
 * inside `advanceAudit`'s own nested drain, which the CLI engine's closure cannot
 * reach.
 */
export interface ProviderConfirmationGateState {
  /**
   * Backends reachable now that the operator's confirmation never mentioned.
   * CLEARED to `[]` by the executor on a successful promotion: the rebuild folds
   * every reachable backend into `provider_pool` (an excluded entry stays IN the
   * pool), so all of REACH-NOW is in CONFIRMED and the delta is empty by
   * construction.
   */
  newlyReachable: NewlyReachableBackend[];
  /**
   * Model ids of dispatchable pools whose capability lookup does not resolve — the
   * capability-evidence delta. Same mutable-by-reference discipline and the same
   * clearing rule as {@link newlyReachable}: CLEARED to `[]` by the executor on a
   * successful promotion, because the promotion is the only thing that can add the
   * missing ranks. A frozen delta here is the identical `PRIORITY[0]` livelock.
   *
   * Only ever holds models the dispatch join CAN reach (`pool.hostModel` non-null).
   * A model-less pool is unjoinable, so pinning it could never clear the delta and it
   * would re-prompt forever — it is excluded at computation, not here.
   */
  unevidencedCapability: string[];
  /**
   * Unattended run ⇒ nobody to prompt ⇒ the delta fails closed instead. Read by the
   * EXECUTOR itself, not just its caller — the fail-closed write must be impossible
   * to trigger on an attended run regardless of which entrypoint calls it.
   */
  autonomous: boolean;
}

export interface AdvanceAuditResult {
  audit_state: AuditState;
  selected_obligation: string | null;
  selected_executor: string | null;
  progress_made: boolean;
  artifacts_written: string[];
  progress_summary: string;
  next_likely_step: string | null;
  updated_bundle: ArtifactBundle;
}
