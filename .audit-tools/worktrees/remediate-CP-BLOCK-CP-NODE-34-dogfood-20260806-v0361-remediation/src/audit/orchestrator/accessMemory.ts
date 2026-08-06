import type { AccessMemory, AccessTouchEvent } from "audit-tools/shared";
import { deriveAccessMemoryFromEvents } from "audit-tools/shared";
import type { AuditResult } from "../types.js";

/**
 * Deterministically harvest a per-run access-memory record from the full ingested
 * AuditResult ledger. Pure: the same ledger always yields a byte-identical record.
 *
 * Frequency (`covered_count`) = how many ledger results covered each path, over
 * the RAW append-only ledger — deliberately including superseded re-dispatch /
 * deepening records, not the supersession-resolved `selectCurrentResults` view.
 * The signal is *attention*: a file audited multiple times (re-dispatched or
 * deepened) got more attention and is a stronger continuity candidate, so raw
 * touches is the right weight for a continuity bias. `total_ordinals` is the raw
 * ledger length, so recency (`last_ordinal / total_ordinals`) stays in the same
 * raw-ledger space and is self-consistent.
 *
 * Recency = the path's most recent touch measured as a STEP-ORDINAL (the covering
 * result's index in the ledger), never wall-clock — so the signal is stable
 * across machines/agents and cannot churn the artifact hash on clock skew. The
 * ledger is append-only and idempotent (O2), so its array order is the run's step
 * order and an idempotent replay is a no-op (no churn).
 *
 * Output arrays are content-sorted (paths by path, lenses lexically) so the
 * serialized bytes are stable regardless of ledger iteration incidentals — the
 * "extractors emit stable, content-derived array order" invariant, which keeps
 * the artifact's content hash from churning the staleness DAG.
 *
 * `edited_count` and `symbols[]` are reserved: `edited_count` is populated by the
 * remediate-parity harvest (RemediationBlock.touched_files), `symbols[]` by the
 * `path::symbol` granularity increment. This audit-side path-level derive leaves
 * `edited_count` at 0 and omits `symbols`.
 */
export function deriveAccessMemory(
  results: AuditResult[],
  options: { runId?: string } = {},
): AccessMemory {
  const runId = options.runId ?? results.find((r) => r.run_id)?.run_id;
  // Each covered file in each ledger result is one covered touch at that result's
  // ledger ordinal. The shared core owns the deterministic accumulate/sort/serialize;
  // this adapter only maps AuditResult → the normalized touch stream.
  const events: AccessTouchEvent[] = [];
  results.forEach((result, ordinal) => {
    for (const coverage of result.file_coverage ?? []) {
      if (!coverage?.path) continue;
      events.push({
        path: coverage.path,
        edited: false,
        ordinal,
        lens: result.lens,
      });
    }
  });
  return deriveAccessMemoryFromEvents(events, {
    totalOrdinals: results.length,
    runId,
  });
}
