import type {
  PartialCompletionTerminal,
  RollingEngineLifecycleState,
} from "audit-tools/shared";

export const DISPATCH_RESULT_MAP_FILENAME = "dispatch-result-map.json";
export const ACTIVE_DISPATCH_FILENAME = "active-dispatch.json";

/**
 * The resumable `waiting_for_provider` paused state of an audit rolling-dispatch
 * run, persisted on the active-dispatch artifact so a quota-exhausted run pauses
 * across `next-step` invocations instead of stranding packets (DC-4 fix 1). It
 * carries the rolling-engine lifecycle state (`waiting_for_provider` →
 * `terminal/livelock` per `advancePausedState`) PLUS the accumulated
 * `SettledExclusionSet` — the pool ids that have been spilled-then-exhausted. The
 * set is serialized as a sorted array (JSON has no Set) and rehydrated to a
 * `ReadonlySet` before `advancePausedState`, so a settled pool is never re-offered
 * as net-new on re-discovery (INV-S03 / CE-001). a8's cross-pool coordinator reads
 * and co-derives the SAME field — this is the shared exclusion set, not a private
 * one — so a pool a8 spilled off is already accounted for when the pause engages.
 */
export interface DispatchPausedState {
  lifecycle: Extract<
    RollingEngineLifecycleState,
    { kind: "waiting_for_provider" }
  >;
  /** Sorted pool ids that have been exhausted (the shared SettledExclusionSet). */
  settled_exclusions: string[];
  /**
   * Dead providers captured when provider_unavailable outcomes were observed.
   * Optional because old persisted records may omit it. Array of {pool_id,
   * provider_name} to name the dead providers in the pause handoff and
   * suggest re-detection on resume.
   */
  dead_providers?: Array<{ pool_id: string; provider_name: string }>;
}

export interface ActiveDispatchState {
  run_id: string;
  created_at: string;
  /** Emitted packets only (after budget filtering). */
  packet_count: number;
  /** Tasks remaining this round (not-yet-done), not just emitted-packet tasks. */
  task_count: number;
  status: "active" | "merged";
  /** Total packets that would have been emitted before a budget cap (present only when capped). */
  budget_packet_count?: number;
  /** packet_ids NOT emitted due to the budget cap. */
  deferred_packet_ids?: string[];
  /** task_ids NOT emitted due to the budget cap. */
  deferred_task_ids?: string[];
  /**
   * Set when the dispatch engine fires a partial-completion terminal (empty pool
   * or livelock guard). Presence of this field allows `deriveAuditState` to treat
   * `audit_tasks_completed` as satisfied so the pipeline can proceed to synthesis
   * on partial coverage, without blocking on tasks that can never be dispatched.
   */
  partial_completion_terminal?: PartialCompletionTerminal;
  /**
   * Set when the rolling audit run is paused on an exhausted provider pool and is
   * resumable (DC-4). Cleared once it resumes (capacity returned) or is promoted to
   * a `partial_completion_terminal` (livelock after the pause limit). The terminal
   * stamp clears this field atomically in the same write (the one-way ratchet in
   * `pausePersist.ts`); a later pause MAY coexist with an already-stamped terminal —
   * the terminal survives as the ratchet and `deriveAuditState` subtracts its
   * stranded ids before deriving `dispatch_capacity`.
   */
  paused_state?: DispatchPausedState;
  /**
   * Set once the large-fan-out confirmation recommendation
   * (`DispatchFanout.confirmation_recommended`) has been surfaced for this
   * run_id (Bug 8 / Slice A4). Subsequent grants of the SAME run must not
   * re-recommend it. A fresh run (new run_id, or no prior state) confirms again.
   */
  confirmation_shown?: boolean;
}

export interface DispatchResultMapEntry {
  packet_id: string;
  task_id: string;
  result_path: string;
}

export interface DispatchResultMap {
  contract_version: "audit-code-dispatch-results/v1alpha1";
  run_id: string;
  entries: DispatchResultMapEntry[];
}
