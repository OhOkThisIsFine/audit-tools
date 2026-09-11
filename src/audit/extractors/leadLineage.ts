/**
 * The single stamp for a deterministic producer's finding lineage.
 *
 * The backlog property (2026-08-03): "deterministic graph output is a
 * generation/provenance-bound lead, not an approved finding, until semantic
 * confirmation; report promotion must preserve producer, source hash, and
 * evidence lineage."
 *
 * The three halves land in three places, and this module is the first:
 *   - `producer` + `source_hash` + `confirmation: "lead"` go on the finding
 *     (`FindingLeadLineage`, stamped here).
 *   - the EVIDENCE half rides the existing channels unchanged — a
 *     deterministic finding already carries its `evidence` strings and its
 *     `affected_files`, and both merge forward through `upsertFindingByIdentity`
 *     when a semantic pass re-emits the same identity. There is deliberately no
 *     second evidence field: a lineage that duplicated evidence would let the
 *     two disagree.
 *   - the PROMOTION half is the `confirmation: "lead"` literal, which no
 *     producer may set to anything else. A semantic pass confirms a lead on its
 *     own verdict, never by rewriting the producer's stamp.
 *
 * `sourceHash` is over the EXACT signal array the detector iterated — after the
 * detector's own sort, before its cap — so the hash identifies the generation of
 * that signal, not a truncated view of it. Hashing the full sorted set means a
 * lead's hash stays stable when only the cap boundary moves, and moves whenever
 * any underlying measurement does.
 */
import { hashContent, stableStringify } from "audit-tools/shared";
import type { Finding } from "../types.js";

/** Content hash of one detector's sorted signal collection. */
export function leadSourceHash(signal: unknown): string {
  return hashContent(stableStringify(signal));
}

/**
 * Return the finding with its lead lineage stamped. Stamping is a copy, never a
 * mutation — a producer that returned a shared object would otherwise leak the
 * stamp across detectors.
 */
export function stampLeadLineage<T extends Finding>(
  finding: T,
  producer: string,
  sourceHash: string,
): T {
  return {
    ...finding,
    lead_lineage: { producer, source_hash: sourceHash, confirmation: "lead" },
  };
}
