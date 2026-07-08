import type { AccessMemory, AccessMemoryPathRecord } from "audit-tools/shared";
import { ACCESS_MEMORY_VERSION } from "audit-tools/shared";
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
  const byPath = new Map<
    string,
    { covered: number; lastOrdinal: number; lenses: Set<string> }
  >();

  results.forEach((result, ordinal) => {
    for (const coverage of result.file_coverage ?? []) {
      const path = coverage?.path;
      if (!path) continue;
      let record = byPath.get(path);
      if (!record) {
        record = { covered: 0, lastOrdinal: 0, lenses: new Set<string>() };
        byPath.set(path, record);
      }
      record.covered += 1;
      // forEach visits ordinals in increasing order, so the final write is the
      // maximum (most recent) ordinal that covered this path.
      record.lastOrdinal = ordinal;
      if (result.lens) record.lenses.add(result.lens);
    }
  });

  const runId = options.runId ?? results.find((r) => r.run_id)?.run_id;

  const paths: AccessMemoryPathRecord[] = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, record]) => ({
      path,
      covered_count: record.covered,
      edited_count: 0,
      last_ordinal: record.lastOrdinal,
      lenses: [...record.lenses].sort(),
    }));

  return {
    version: ACCESS_MEMORY_VERSION,
    ...(runId ? { run_id: runId } : {}),
    total_ordinals: results.length,
    paths,
  };
}
