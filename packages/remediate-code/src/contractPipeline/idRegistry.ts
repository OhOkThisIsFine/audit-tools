/**
 * Single tool-owned authority for the contract-pipeline's id relationships
 * (S4 of the contract-authoring determinism design).
 *
 * Today it owns the one relationship that caused the recurring "Unknown
 * finding_id" merge trap: the `CP-BLOCK-` block-id <-> bare node-id mapping.
 * Before this module the prefix was constructed by inline string templates at
 * several sites (the DAG->plan promotion built it for both node block ids AND
 * dependency edges; the dispatch alias map built it again), and the reverse was
 * only ever recovered by the tolerant alias remap. With the prefix minted and
 * reversed in exactly ONE place each, a node id minted by the planner
 * round-trips dispatch -> worker result -> merge deterministically, so the
 * tolerant alias remap is defence-in-depth rather than load-bearing.
 *
 * The mapping is a bijection on bare node ids: `fromBlockId(toBlockId(n)) === n`.
 * It is a pure module — no IO, no model identity — so it is testable in
 * isolation and feeds the hash/staleness DAG cleanly.
 */

/** The one prefix that marks a dispatch block id derived from a DAG node id. */
export const CP_BLOCK_PREFIX = "CP-BLOCK-";

/**
 * Mint the block id for a bare DAG node id. This is the ONLY place the
 * `CP-BLOCK-` prefix is applied — every producer of a block id goes through here.
 */
export function toBlockId(nodeId: string): string {
  return `${CP_BLOCK_PREFIX}${nodeId}`;
}

/** True when `value` is a `CP-BLOCK-` block id minted by `toBlockId`. */
export function isBlockId(value: string): boolean {
  return value.startsWith(CP_BLOCK_PREFIX);
}

/**
 * Recover the bare node id from a block id — the inverse of `toBlockId`. Returns
 * `null` when `value` is not a `CP-BLOCK-` block id (so callers can fall back to
 * the tolerant alias remap for non-block aliases such as obligation ids, rather
 * than silently producing a wrong node id).
 */
export function fromBlockId(value: string): string | null {
  return isBlockId(value) ? value.slice(CP_BLOCK_PREFIX.length) : null;
}
