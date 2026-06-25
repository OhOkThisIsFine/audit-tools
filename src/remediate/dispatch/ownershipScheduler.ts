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
 * Pure and deterministic — no I/O, no Set/Map iteration-order leak — so the
 * admission order is reproducible and unit-testable against a precomputed level.
 */

import { canonicalizeFilePath } from "./ownershipRegistry.js";

/** A node as the ownership scheduler sees it: an id + its declared write-scope. */
export interface OwnershipSchedulerNode {
  block_id: string;
  /** Declared write-scope paths (repo-relative or absolute); empty ⇒ unresolved. */
  write_paths: string[];
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
 * is blocked-by every peer), so it never batches with another writer
 * (INV-SOO-01 / CE-008).
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
    const claimed = new Set<string>();
    let waveHasEmptyScopeNode = false;
    const leftover: OwnershipSchedulerNode[] = [];

    for (const node of remaining) {
      const scope = scopeOf.get(node.block_id)!;
      const isEmpty = scope.size === 0;

      // Empty-scope node admits only into an otherwise-empty sub-wave (solo).
      if (isEmpty) {
        if (wave.length === 0) {
          wave.push(node);
          waveHasEmptyScopeNode = true;
        } else {
          leftover.push(node);
        }
        continue;
      }

      // A real-scope node cannot share a wave with an empty-scope node, nor with
      // any node it shares a canonical path with.
      if (waveHasEmptyScopeNode) {
        leftover.push(node);
        continue;
      }
      let overlaps = false;
      for (const key of scope) {
        if (claimed.has(key)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        leftover.push(node);
        continue;
      }
      for (const key of scope) claimed.add(key);
      wave.push(node);
    }

    subWaves.push(wave);
    remaining.length = 0;
    remaining.push(...leftover);
  }

  return subWaves;
}
