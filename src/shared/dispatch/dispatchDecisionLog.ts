/**
 * In-process engine decision log — the dispatch-time half of the legibility
 * invariant (spec/audit/dispatch-admission-control.md, Resolved decision 3:
 * every dispatch decision leaves a deterministic, mechanistic trace).
 *
 * The host-path grant persists its decisions in the dispatch-quota artifact's
 * `admission.explains`; the in-process rolling engine decides per-packet at
 * dispatch time, AFTER that artifact is written, so its decisions need their own
 * record. The engine stamps and emits every decision through one chokepoint: a
 * wired `onAdmissionDecision` sink receives it (the drivers append it to
 * `dispatch-explains.jsonl` in the run dir via {@link createDispatchDecisionLog});
 * with NO sink wired the engine writes the same record to stderr as a JSON line —
 * a decision can never silently vanish, wired or not.
 *
 * Records are EVENTS, not state: a packet admitted on one pass and stranded on a
 * later one appears twice. Ordering: `seq` is PER-DISPATCHER monotonic — and a
 * multi-sub-wave drive runs several dispatchers into ONE file, so seq alone is
 * not file-authoritative. The sink stamps `file_seq` (per-sink monotonic) on
 * append; `file_seq` is the authoritative order of a dispatch-explains.jsonl,
 * `ts` is wall-clock context (host-review F2, 2026-07-23).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ConstraintOutcomeRecord } from "./admissionLoop.js";

/** One engine dispatch decision, before stamping. */
export type EngineDecisionRecord =
  /**
   * A packet dispatched to a pool. `lease_id: null` = no reservation ledger is
   * wired (unmetered pool set — the reactive 429 floor is the safety), so the
   * decision is the pool selection itself and `constraints` is empty.
   */
  | {
      kind: "engine_admitted";
      packet_id: string;
      pool_id: string;
      lease_id: string | null;
      cost: number;
      constraints: ConstraintOutcomeRecord[];
      binding: ConstraintOutcomeRecord | null;
      /** True when the liveness backstop force-admitted an over-budget packet. */
      forced: boolean;
    }
  /**
   * The ledger refused a (packet, pool) reservation this pass (packet stays
   * pending). `forced: true` = the anti-deadlock backstop's unbounded re-admit
   * was attempted and ALSO refused (reachable only via window_uncalibrated —
   * the backstop unbounds budgets, not slopes). Blocked records are
   * transition-deduped per packet: one record per distinct
   * (pool, reason, any_outstanding, forced), reset when the packet dispatches.
   */
  | {
      kind: "engine_blocked";
      packet_id: string;
      pool_id: string;
      reason: "budget_exhausted" | "window_uncalibrated";
      constraints: ConstraintOutcomeRecord[];
      binding: ConstraintOutcomeRecord | null;
      any_outstanding: boolean;
      forced?: boolean;
      unpriced_windows?: string[];
    }
  /** Every pool is exhausted or paused — the remaining queue strands (retryable when paused). */
  | {
      kind: "engine_stranded_pool_wall";
      packet_ids: string[];
      pools: { pool_id: string; status: "exhausted" | "paused"; reset_at?: string }[];
    }
  /** Per-packet permanent strand: every pool refuses for a non-resetting reason. */
  | {
      kind: "engine_stranded_no_fitting_pool";
      packets: {
        packet_id: string;
        pools: {
          pool_id: string;
          why: "pool_exhausted" | "oversized_for_pool" | "context_cap" | "below_capability_floor";
        }[];
      }[];
    }
  /** This packet 413'd every pool that could ever take it. */
  | {
      kind: "engine_stranded_packet_too_large_all_pools";
      packet_id: string;
      skipped_pool_ids: string[];
    }
  /** Host-session escalation strand (account wall re-tripped the same packet). */
  | {
      kind: "engine_stranded_host_session_escalation";
      packet_id: string;
      pool_id: string;
    };

/**
 * The stamped form the engine emits: per-dispatcher monotonic `seq` +
 * wall-clock `ts`. `file_seq` is added by the SINK (per-file monotonic — the
 * authoritative order across a multi-dispatcher drive); absent on records that
 * fell back to stderr from the engine itself.
 */
export type StampedEngineDecisionRecord = EngineDecisionRecord & {
  ts: string;
  seq: number;
  file_seq?: number;
};

/** The sink the engine's `onAdmissionDecision` seam expects. */
export type EngineDecisionSink = (record: StampedEngineDecisionRecord) => void;

/**
 * Append-only JSONL sink for engine decision records — one JSON object per line,
 * `runs/<runId>/dispatch-explains.jsonl` by convention (the drivers own the
 * path). Synchronous single-line appends so concurrent async completions in one
 * process can never interleave partial lines. Best-effort with a LOUD once-only
 * degrade: an append failure (disk, permissions, path) warns to stderr the first
 * time and falls back to stderr emission for every subsequent record, so a
 * failing sink downgrades to telemetry rather than silently dropping decisions.
 */
export function createDispatchDecisionLog(filePath: string): EngineDecisionSink {
  let degraded = false;
  let fileSeq = 0;
  return (record) => {
    // Per-file monotonic order: several sub-wave dispatchers (each with its own
    // seq starting at 0) append through ONE sink, so the sink's counter is the
    // authoritative order of this file.
    const line = JSON.stringify({ ...record, file_seq: fileSeq++ }) + "\n";
    if (!degraded) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, line, "utf8");
        return;
      } catch (error) {
        degraded = true;
        try {
          process.stderr.write(
            `[dispatch-decision-log] append to ${filePath} failed (${
              error instanceof Error ? error.message : String(error)
            }); falling back to stderr for the rest of this run\n`,
          );
        } catch {
          // Observability must never abort a run.
        }
      }
    }
    try {
      process.stderr.write(line);
    } catch {
      // Observability must never abort a run.
    }
  };
}
