import type { PartialCompletionTerminal } from "audit-tools/shared";

export const DISPATCH_RESULT_MAP_FILENAME = "dispatch-result-map.json";
export const ACTIVE_DISPATCH_FILENAME = "active-dispatch.json";

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
