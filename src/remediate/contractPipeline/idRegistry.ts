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
 * Mint the canonical bare node id for a DAG node, applying the deterministic
 * `CP-NNN` fallback when the planner-authored `node.id` is missing (the DAG is
 * parsed from an LLM envelope via an unchecked cast, so `id` can be absent at
 * runtime). This is the ONE place the fallback rule lives, so a node's finding
 * id, block id, `items`, and traceability key can never diverge.
 *
 * This closes a merge-trap: when `node.id` was missing, the finding id used this
 * fallback (`CP-001`) but the block id was built from the raw `node.id`
 * (`CP-BLOCK-undefined`), so `fromBlockId` could not recover the finding id and
 * the worker result landed in `unresolved`. Routing every node-id site through
 * `ensureNodeId` makes `fromBlockId(toBlockId(ensureNodeId(...)))` round-trip.
 */
export function ensureNodeId(
  rawId: string | undefined,
  index: number,
): string {
  return rawId ?? `CP-${String(index + 1).padStart(3, "0")}`;
}

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

/** The one prefix every derived obligation id carries. */
export const OBLIGATION_PREFIX = "OBL-";

/**
 * Lowercase-hyphenate a module name into the id fragment obligation ids encode.
 *
 * The ENCODER (`derive.ts`, minting `OBL-<slug>-…`) and the DECODERS (phase
 * resolution, write-scope inheritance) must agree exactly, or an obligation
 * resolves to no module and its node silently loses its phase and file scope.
 * They previously agreed by way of two identical implementations and a comment
 * saying they must stay in lockstep — a drift test made of memory. One
 * implementation, here with the rest of the id authority, cannot drift.
 */
export function moduleSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Mint a derived obligation id from a module name and a suffix — the ONLY place
 * the `OBL-<slug>-<suffix>` shape is applied, so the decoders above are matching
 * a format with a single author. Callers still pass the result through
 * `mintUniqueId` for collision disambiguation.
 */
export function obligationId(moduleName: string, suffix: string): string {
  return `${OBLIGATION_PREFIX}${moduleSlug(moduleName) || "module"}-${suffix}`;
}
