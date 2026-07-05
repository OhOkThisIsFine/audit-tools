/**
 * File-ownership-disjoint admission scheduling (INV-SOO-01..10).
 *
 * The rolling engine dispatches an eligible dependency LEVEL (deps verified-
 * complete, INV-RS-01). Within a level the previous scheduler ordered nodes only
 * by `block_id.localeCompare`, which let two same-file nodes run concurrently and
 * collide at merge (the lost-update-guard-lands-1-rejects-N-1 starved-tail bug).
 *
 * This module replaces that numeric ordering with file-ownership-DISJOINT
 * admission: a level is admitted in SUB-WAVES, each a maximal pairwise-file-
 * disjoint subset of the still-pending nodes, chosen by a deterministic
 * block_id tie-break AFTER the disjointness filter (INV-SOO-08). Same-file nodes
 * therefore land in successive sub-waves (serialize, INV-SOO-01/02) while
 * different-file nodes share a sub-wave (parallelize up to the quota cap the
 * dispatcher itself enforces, INV-SOO-03/05). Path identity is the single
 * canonical key from `canonicalizeFilePath` (INV-SOO-09); an empty/unresolved
 * scope is conservatively NON-disjoint so it never batches with a peer
 * (INV-SOO-01 / CE-008).
 *
 * Same-file relaxation: two nodes writing the SAME canonical file batch into one
 * sub-wave IFF BOTH set `cofile_parallel_safe === true` (their edits are declared
 * region-disjoint upstream). If either lacks the flag they serialize into
 * successive sub-waves exactly as before — the conservative default is unchanged.
 *
 * Three disjointness cases, not two (the read-only distinction): (1) a node that is
 * provably READ-ONLY (`read_only === true`, no writes at all) conflicts with nothing
 * and admits into any sub-wave — all read-only nodes collapse into the first maximal
 * sub-wave (this is how an auditor, which writes nothing, runs fully parallel as a
 * degenerate case of the same scheduler); (2) a node with a DECLARED write-scope
 * batches file-disjointly (the `cofile_parallel_safe` relaxation above); (3) a node
 * with an EMPTY/undeclared scope is conservatively non-disjoint and admits solo among
 * writers. Case (1) is distinct from case (3): an empty `write_paths` means "scope
 * unresolved, might touch anything" (serialize), whereas `read_only` means "provably
 * touches nothing" (always parallel).
 *
 * Pure and deterministic — no I/O, no Set/Map iteration-order leak — so the
 * admission order is reproducible and unit-testable against a precomputed level.
 */

import { canonicalizeFilePath } from "./pathIdentity.js";

/** A node as the ownership scheduler sees it: an id + its declared write-scope. */
export interface OwnershipSchedulerNode {
  block_id: string;
  /** Declared write-scope paths (repo-relative or absolute); empty ⇒ unresolved. */
  write_paths: string[];
  /**
   * When BOTH of two same-canonical-file nodes set this true, they may batch into
   * ONE sub-wave (region-disjoint, non-conflicting edits verified safe upstream).
   * Absent/false ⇒ the node serializes vs. any same-file peer exactly as before.
   */
  cofile_parallel_safe?: boolean;
  /**
   * The node is provably READ-ONLY — it performs no writes to the target tree, so it
   * can never conflict with any peer at merge and admits into any sub-wave in full
   * parallel. This is DISTINCT from an empty/undeclared `write_paths`: empty means the
   * write-scope is *unresolved* (conservatively serial); `read_only` means the node is
   * *known* to write nothing (an auditor). Absent/false ⇒ the node is treated as a
   * writer and goes through the normal file-disjointness gating.
   */
  read_only?: boolean;
}

/**
 * Canonicalize a node's declared write-scope to physical-file identity keys.
 * Empty input ⇒ empty set (handled conservatively by the disjointness gate).
 */
export function canonicalScopeKeys(
  node: OwnershipSchedulerNode,
  root?: string,
): Set<string> {
  const out = new Set<string>();
  for (const p of node.write_paths) out.add(canonicalizeFilePath(p, { root }));
  return out;
}

/**
 * Partition a single eligible LEVEL into ordered file-ownership-disjoint
 * SUB-WAVES. Each sub-wave is a maximal set of nodes whose canonical write-scopes
 * are pairwise disjoint AND disjoint from a node with an empty scope only when it
 * is alone (conservative empty-scope gating). Nodes are considered in ascending
 * `block_id` order (the deterministic tie-break, INV-SOO-08), so the admitted
 * subset of each sub-wave is identical across two runs over identical state.
 *
 * A node with an EMPTY canonical scope (unresolved/undeclared) is treated as
 * conservatively NON-disjoint: it only enters a sub-wave by itself (it blocks and
 * is blocked-by every peer writer), so it never batches with another writer
 * (INV-SOO-01 / CE-008). A `read_only` node is the opposite — it writes nothing, so
 * it admits into any sub-wave in full parallel (see the three-case note above).
 */
export function ownershipSubWaves(
  level: OwnershipSchedulerNode[],
  root?: string,
): OwnershipSchedulerNode[][] {
  const ordered = [...level].sort((a, b) => a.block_id.localeCompare(b.block_id));
  const scopeOf = new Map<string, Set<string>>();
  for (const n of ordered) scopeOf.set(n.block_id, canonicalScopeKeys(n, root));

  const remaining = [...ordered];
  const subWaves: OwnershipSchedulerNode[][] = [];

  while (remaining.length > 0) {
    const wave: OwnershipSchedulerNode[] = [];
    // canonical key → the node that claimed it in THIS sub-wave. Retained (not a
    // bare Set) so a same-file peer can consult the incumbent's flag: two nodes
    // co-batch on a shared key IFF both are `cofile_parallel_safe`.
    const claimant = new Map<string, OwnershipSchedulerNode>();
    let waveHasEmptyScopeNode = false;
    // A writer or empty-scope node has been admitted to this sub-wave. Gates the
    // empty-scope node's solo admission: it may enter only when no writer and no
    // prior empty-scope node is present. A `read_only` co-resident is NOT a writer,
    // so it never trips this — read-only nodes stay fully inert to the conflict logic.
    let waveHasWriter = false;
    const leftover: OwnershipSchedulerNode[] = [];

    for (const node of remaining) {
      const scope = scopeOf.get(node.block_id)!;

      // Case 1: provably READ-ONLY (writes nothing) ⇒ conflicts with nothing. Admit to
      // the current sub-wave unconditionally; never claim a path, never set or consult
      // the writer/empty-scope flags. All read-only nodes therefore collapse into the
      // first (maximal) sub-wave — an auditor's full-parallel degenerate case.
      if (node.read_only === true) {
        wave.push(node);
        continue;
      }

      const isEmpty = scope.size === 0;

      // Case 3: empty/undeclared scope ⇒ conservatively non-disjoint. Admits only into
      // a sub-wave with no other writer and no prior empty-scope node (solo among
      // writers; read-only co-residents don't count).
      if (isEmpty) {
        if (!waveHasWriter && !waveHasEmptyScopeNode) {
          wave.push(node);
          waveHasEmptyScopeNode = true;
        } else {
          leftover.push(node);
        }
        continue;
      }

      // Case 2: a real-scope node cannot share a wave with an empty-scope node, nor with
      // any node it shares a canonical path with — UNLESS both this node and every
      // same-file incumbent it collides with are `cofile_parallel_safe`.
      if (waveHasEmptyScopeNode) {
        leftover.push(node);
        continue;
      }
      let overlaps = false;
      for (const key of scope) {
        const incumbent = claimant.get(key);
        if (incumbent !== undefined) {
          const bothSafe =
            node.cofile_parallel_safe === true &&
            incumbent.cofile_parallel_safe === true;
          if (!bothSafe) {
            overlaps = true;
            break;
          }
        }
      }
      if (overlaps) {
        leftover.push(node);
        continue;
      }
      for (const key of scope) claimant.set(key, node);
      wave.push(node);
      waveHasWriter = true;
    }

    subWaves.push(wave);
    remaining.length = 0;
    remaining.push(...leftover);
  }

  return subWaves;
}
