export const RUN_LEDGER_STATUSES = [
  "completed",
  "blocked",
  "failed",
  "no_progress",
] as const;
export type RunLedgerStatus = (typeof RUN_LEDGER_STATUSES)[number];

/** One persisted supervisor run entry, including the terminal worker outcome. */
export interface RunLedgerEntry {
  run_id: string;
  provider: string;
  obligation_id: string | null;
  selected_executor: string | null;
  status: RunLedgerStatus;
  started_at: string;
  ended_at: string;
  result_path: string;
}

/** Append-only ledger used to explain how the audit advanced over time. */
export interface RunLedger {
  runs: RunLedgerEntry[];
}
