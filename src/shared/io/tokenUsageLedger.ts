/**
 * Per-run token-usage ledger — the RECORDING half of the score-tokens track
 * (context-efficiency track item 3, the cost counterpart to the A-2 quality
 * oracle `score-audit`). One line is appended per COMPLETED dispatch packet, in
 * the SAME `.audit-tools/<area>/runs/<run-id>/` directory `dispatch-quota.json`
 * already lives in, so a `score-tokens` run keyed by run-id finds it beside the
 * quota/corpus artifacts the same way `score-audit` finds `corpus/<run-id>.labels.json`.
 *
 * Single-sourced in `audit-tools/shared` so the path and the append shape can't
 * drift between BOTH writers — audit's `makeAuditProviderPacketDispatcher`
 * (`rollingAuditDispatch.ts`) and remediate's `makeProviderNodeDispatcher`
 * (`providerNodeDispatch.ts`) — each invoked at PACKET/NODE-COMPLETION time
 * (after the provider's launch resolves and the result file is confirmed) — and
 * any future reader. Never called from the admission/scheduling path: appending
 * here adds no latency to `selectProvider` / `scheduleWave` / the reservation ledger.
 *
 * Best-effort by design: a ledger write failure must never fail the packet it is
 * recording (mirrors the provider's own best-effort stdout/stderr appenders).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Filename of the per-run token-usage ledger (JSON Lines, one record per packet). */
export const TOKEN_USAGE_LEDGER_FILENAME = "token-usage.jsonl";

/**
 * One recorded packet-completion line. Token/cost legs the provider did not
 * report are `null` — NEVER 0 and NEVER omitted — so a reader can distinguish
 * "measured zero" from "unmeasured" (no-silent-scoring discipline, mirroring
 * score-audit's `unmatched[]`).
 */
export interface TokenUsageLedgerLine {
  packet_id: string;
  /** Task ids folded into this packet, when the producer has them available. */
  task_ids?: string[] | null;
  /** The provider/account/model pool that served this packet. */
  pool_id?: string | null;
  /** The audit lens this packet reviewed, when the producer has it available. */
  lens?: string | null;
  /** Wall-clock ISO instant the line was appended (IO-shell timestamp). */
  timestamp: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  observed_cost_usd: number | null;
}

/** The run dir a run's ledger (and `dispatch-quota.json`) live under. */
export function tokenUsageRunDir(artifactsDir: string, runId: string): string {
  return join(artifactsDir, "runs", runId);
}

/** Absolute path to a run's token-usage ledger. */
export function tokenUsageLedgerPath(artifactsDir: string, runId: string): string {
  return join(tokenUsageRunDir(artifactsDir, runId), TOKEN_USAGE_LEDGER_FILENAME);
}

/**
 * Append one packet-completion record to the run's token-usage ledger.
 * Best-effort: swallows any IO failure (missing dir race, permission blip) so
 * a ledger write can never fail the packet it is recording. `timestamp`
 * defaults to `new Date().toISOString()` — a wall-clock read confined to this
 * IO-shell write, never a pure function's determinism.
 */
export async function appendTokenUsageLine(
  artifactsDir: string,
  runId: string,
  line: Omit<TokenUsageLedgerLine, "timestamp"> & { timestamp?: string },
): Promise<void> {
  try {
    const dir = tokenUsageRunDir(artifactsDir, runId);
    await mkdir(dir, { recursive: true });
    const record: TokenUsageLedgerLine = {
      ...line,
      timestamp: line.timestamp ?? new Date().toISOString(),
    };
    await appendFile(tokenUsageLedgerPath(artifactsDir, runId), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort observability write — never fail the packet it is recording.
  }
}
