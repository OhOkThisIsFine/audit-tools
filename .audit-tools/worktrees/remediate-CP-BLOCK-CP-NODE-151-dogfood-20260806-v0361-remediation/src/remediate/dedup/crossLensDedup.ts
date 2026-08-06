import { crossLensDedupe, wordJaccard } from "audit-tools/shared";
import type { CrossLensDedupeResult } from "audit-tools/shared";
import type { Finding, RemediationBlock } from "../state/types.js";

// Re-exported: tests/remediate/cross-lens-dedup.test.ts imports wordJaccard
// directly from this module.
export { wordJaccard };

export type CrossLensDedupResult = CrossLensDedupeResult;

/**
 * Remediate's DRAW of the shared cross-lens dedup core (`crossLensDedupe`): the
 * auto-apply block-machine policy — a HARD category gate (never collapse two
 * different-category fixes, OBL-C003-DEDUP), the exact-identity short-circuit
 * (drift-plan R2), CLONE survivors so the caller's Finding objects are never
 * mutated (INV-remediate-state-05), no grounding merge / no file sort, break on an
 * absorbed i-slot, and a structured merge log. The returned `mergeMap` feeds
 * `fixupBlocksAfterDedup`.
 */
export function deduplicateCrossLensFindings(
  findings: Finding[],
): CrossLensDedupResult {
  return crossLensDedupe(findings, {
    categoryGate: "hard",
    exactIdentityShortCircuit: true,
    survivorMutation: "clone",
    mergeGrounding: false,
    sortAffectedFiles: false,
    breakOnAbsorbedSurvivor: true,
    // Input ids come from audit-findings.json (globally unique), so id-keyed
    // provenance is well-defined: duplicates refuse, dispositionById is emitted.
    idDiscipline: "global",
    onMerge: ({ absorbed, survivor }) => {
      process.stderr.write(
        JSON.stringify({
          level: "info",
          event: "cross_lens_dedup_merge",
          absorbed_id: absorbed.id,
          absorbed_lens: absorbed.lens,
          survivor_id: survivor.id,
          survivor_lens: survivor.lens,
          ts: new Date().toISOString(),
        }) + "\n",
      );
    },
  });
}

/**
 * Rewrite absorbed finding ids to their dedupe survivor AND enforce single-block
 * ownership: after fixup, every finding id appears in exactly ONE block's items.
 *
 * Rewriting alone leaves a survivor absorbed from another lens's block in BOTH
 * blocks (its own, plus the absorbed finding's), which made block ownership
 * ill-defined — dispatch scoping and the coverage ledger each saw the finding
 * twice. Ownership is first-wins in block order (the same pinned semantic as
 * `blockIdsByFinding`), later occurrences are dropped, and a block whose items
 * all merged away is dropped whole — an empty block has nothing to dispatch and
 * would only distort scheduling.
 */
export function fixupBlocksAfterDedup(
  blocks: RemediationBlock[],
  mergeMap: Map<string, string>,
): RemediationBlock[] {
  if (mergeMap.size === 0) return blocks;
  const owned = new Set<string>();
  return blocks
    .map((block) => {
      const items: string[] = [];
      for (const id of block.items) {
        const terminal = mergeMap.get(id) ?? id;
        if (owned.has(terminal)) continue;
        owned.add(terminal);
        items.push(terminal);
      }
      return { ...block, items };
    })
    .filter((block) => block.items.length > 0);
}
