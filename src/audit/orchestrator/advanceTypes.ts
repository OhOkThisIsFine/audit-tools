import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditResult } from "../types.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { AnalyzerSetting, SynthesisNarrative, RunLogger, CharterSubmission, CharterDeltaSubmission, ClarificationAnswersSubmission, SystemicChallengeSubmission, CriticalFlowFallbackResult, SessionConfig } from "audit-tools/shared";
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
