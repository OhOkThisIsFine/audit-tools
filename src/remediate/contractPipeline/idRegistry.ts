/**
 * Single tool-owned authority for the contract-pipeline's id relationships
 * (S4 of the contract-authoring determinism design).
 *
 * Its block-id relationship caused the recurring "Unknown
 * finding_id" merge trap: the one-way bare-node-id to `CP-BLOCK-` block-id mint.
 * Before this module the prefix was constructed by inline string templates at
 * several sites (the DAG->plan promotion built it for both node block ids AND
 * dependency edges; the dispatch alias map built it again). With the node id and
 * prefix minted in exactly ONE place each, dispatch and merge consume the same
 * persisted identity without a reverse-mapping API.
 *
 * The block-id API is intentionally one-way: callers consume the persisted id
 * minted by `toBlockId` rather than reverse-mapping it.
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
 * (`CP-BLOCK-undefined`), so the worker result landed in `unresolved`. Routing
 * every node-id site through `ensureNodeId` keeps the finding and block mints
 * aligned.
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

/**
 * The suffix GRAMMAR of a derived obligation id — the `…-<suffix>` half, and the
 * half that makes the id → module join exact rather than longest-prefix.
 *
 * Why it has to exist. The decoders (`phaseOrdinalForObligations`, the
 * promotion's module-contract attachment) recover a module from its obligation
 * ids by matching a slug against the id BODY. Two distinct module names can
 * collide there in one direction: `auth` and `auth-service` are different
 * modules, and `OBL-auth-service-contract` starts with `auth-`. Longest-slug-
 * first picks `auth-service` and happens to be right, but only because the
 * SLUG SET is what decides — a plan whose `auth-service` obligations were
 * emitted before the module registry knew that name would silently resolve them
 * to `auth`, and the node would take `auth`'s phase and file scope.
 *
 * The suffix is the tiebreak that removes the guess: once the grammar is
 * stripped, the remaining body must equal a known slug EXACTLY. A module name
 * is free-form prose, so it can contain `contract` or `inv-2`; what it cannot
 * do is make the exact-equality test pass for a DIFFERENT module, because the
 * candidate body is only ever the id minus its one grammatical suffix.
 *
 * Kept here, beside the mint, for the same reason `moduleSlug` is: a grammar
 * only the encoder knows is a drift test made of memory. `derive.ts` is the
 * encoder and imports `obligationId` from this module; the suffixed forms it
 * mints are `contract`, `inv-<n>`, and `fail-<n>`, and `mintUniqueId`
 * (`audit-tools/shared`) appends `-<n>` to disambiguate a collision.
 */
const OBLIGATION_SUFFIX_PATTERN = /^(?:contract|inv-\d+|fail-\d+)(?:-\d+)?$/u;

/**
 * The ONE exact join from a derived obligation id back to its module slug, or
 * `null` when the id carries no obligation prefix or its body is not
 * `<knownSlug>-<grammaticalSuffix>`.
 *
 * `knownSlugs` MUST be the module slugs in scope; the match is exact, so the
 * caller need not pre-sort them (the previous longest-first sort existed only
 * to arbitrate the prefix ambiguity this rule removes).
 */
export function moduleSlugForObligationId(
  id: string,
  knownSlugs: ReadonlySet<string>,
): string | null {
  if (!id.startsWith(OBLIGATION_PREFIX)) return null;
  const body = id.slice(OBLIGATION_PREFIX.length);
  for (let index = body.lastIndexOf("-"); index > 0; index = body.lastIndexOf("-", index - 1)) {
    const slug = body.slice(0, index);
    if (knownSlugs.has(slug) && OBLIGATION_SUFFIX_PATTERN.test(body.slice(index + 1))) {
      return slug;
    }
  }
  return null;
}
