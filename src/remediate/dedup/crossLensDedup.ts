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

export function fixupBlocksAfterDedup(
  blocks: RemediationBlock[],
  mergeMap: Map<string, string>,
): RemediationBlock[] {
  if (mergeMap.size === 0) return blocks;
  return blocks.map((block) => ({
    ...block,
    items: [...new Set(block.items.map((id) => mergeMap.get(id) ?? id))],
  }));
}
