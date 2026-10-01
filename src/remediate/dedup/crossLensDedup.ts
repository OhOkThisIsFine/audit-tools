// sites-pinned: tests/remediate/cross-lens-dedup.test.ts, tests/shared/finding-similarity.test.ts
import { crossLensDedupe, wordJaccard } from "audit-tools/shared";
import type { CrossLensDedupeResult } from "audit-tools/shared";
import type { Finding } from "../state/types.js";

// Re-exported: tests/remediate/cross-lens-dedup.test.ts imports wordJaccard
// directly from this module.
export { wordJaccard };

/**
 * Remediate's DRAW of the shared cross-lens dedup core (`crossLensDedupe`): the
 * source-finding policy — a HARD category gate (never collapse two
 * different-category fixes, OBL-C003-DEDUP), the exact-identity short-circuit
 * (drift-plan R2), CLONE survivors so the caller's Finding objects are never
 * mutated (INV-remediate-state-05), no grounding merge / no file sort, and a
 * structured merge log. Merge identities remain available to callers.
 */
export function deduplicateCrossLensFindings(
  findings: Finding[],
): CrossLensDedupeResult {
  return crossLensDedupe(findings, {
    categoryGate: "hard",
    exactIdentityShortCircuit: true,
    survivorMutation: "clone",
    mergeGrounding: false,
    sortAffectedFiles: false,
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
