import type {
  ActiveDispatchState,
  DispatchResultMapEntry,
  DispatchResultMap,
} from "../../types/activeDispatch.js";
import {
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
} from "../../types/activeDispatch.js";
import type { AuditTask } from "../../types.js";
import type { DispatchModelHint } from "audit-tools/shared";
import type { CapacityPool } from "../../quota/index.js";
import type { HostSessionQuotaSource } from "audit-tools/shared/quota/hostSessionQuotaSource";

// Shared interfaces, constants, and type re-exports for the dispatch pipeline.
// Consumed by tierRouting, packetFilter, packetPrompt, quotaPool, and the
// barrel (dispatch.ts). Nothing here has runtime side-effects.

export type {
  ActiveDispatchState,
  DispatchResultMapEntry,
  DispatchResultMap,
};
export { DISPATCH_RESULT_MAP_FILENAME, ACTIVE_DISPATCH_FILENAME };

export const LARGE_FILE_PACKET_TARGET_LINES = 2500;
export const DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS = 9000;

/**
 * Default relative cut points mapping a packet's `routing_risk` (max member
 * risk, in [0,1]) to a relative model rank. Provider-neutral: these are
 * positions on a normalized risk scale, never named models or model windows
 * (the no-hardcoded-models invariant). Overridable via
 * `sessionConfig.dispatch.routing_tiers`.
 */
export const DEFAULT_DEEP_ROUTING_RISK = 0.66;
export const DEFAULT_STANDARD_ROUTING_RISK = 0.33;

export const DEFAULT_DISPATCH_CONFIRM_THRESHOLD = 10;

export interface DispatchComplexity {
  priority: NonNullable<AuditTask["priority"]>;
  task_count: number;
  file_count: number;
  total_lines: number;
  estimated_tokens: number;
  lenses: AuditTask["lens"][];
  tags: string[];
  large_file_mode: boolean;
}

export interface DispatchFanout {
  agent_count: number;
  /** Packets granted this pass (the emergent admission width). */
  granted_count: number;
  /** Verbatim host in-flight cap (declared env limit), or null. */
  declared_cap: number | null;
  confirmation_recommended: boolean;
  dispatch_summary: string;
}

export interface PrepareDispatchResult {
  run_id: string;
  dispatch_plan_path: string;
  dispatch_quota_path: string | null;
  packet_count: number;
  task_count: number;
  skipped_task_count: number;
  /** Packets GRANTED for dispatch this pass by the admission loop (emergent width). */
  granted_count: number;
  /** Verbatim host in-flight cap (declared env limit, e.g. Codex 6), or null. */
  declared_cap: number | null;
  /** Total agents that will be launched this run (packet_count after budget filtering). */
  agent_count: number;
  /** True when agent_count exceeds sessionConfig.dispatch?.confirm_threshold (default 10). */
  confirmation_recommended: boolean;
  /** Human-readable summary, e.g. "4 of 12 packets granted this pass". */
  dispatch_summary: string;
  /** True when a max_packets budget capped the emitted packets this run. */
  budget_capped: boolean;
  /** Number of packets deferred (not emitted) due to the budget cap. */
  deferred_packet_count: number;
  largest_packet: {
    packet_id: string;
    total_lines: number;
    estimated_tokens: number;
  } | null;
  warning_count: number;
  dispatch_warnings_path: string | null;
  /**
   * The dispatch plan in memory (also persisted to `dispatch_plan_path`). Returned
   * so the in-process rolling driver (A8(a)) can build dispatch packets directly
   * without re-reading the file it just wrote.
   */
  plan: DispatchPlanEntry[];
  /**
   * The quota-derived capacity pools resolved for this dispatch (host-model
   * windows + discovered limits). Returned so the in-process rolling driver can
   * feed them straight into `runRollingDispatch` as `confirmedPools` rather than
   * re-resolving the pool.
   */
  pools: CapacityPool[];
  /**
   * The retained host-session source for this dispatch's pool sizing. Returned
   * so `driveRollingAuditDispatch` can thread the SAME instance into
   * `runRollingDispatch`'s `recordRateLimit`/`isPacketEscalated` hooks, mirroring
   * remediate's retained-source pattern.
   */
  hostSession: HostSessionQuotaSource;
}

export interface DispatchPlanEntry {
  packet_id: string;
  description: string;
  prompt_path: string;
  /** Path where the host/skill should write the worker's captured inline AuditResult[] payload. */
  result_path: string;
  complexity: DispatchComplexity;
  model_hint: DispatchModelHint;
  access: { read_paths: string[]; write_paths: string[]; forbidden_patterns: string[] };
}
