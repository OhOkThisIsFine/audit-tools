/**
 * Work-block seam derivation — the ONE place a contested write path becomes a
 * seam, for every findings-draw producer.
 *
 * This lives beside `contentCoherence.ts` rather than inside one producer
 * because there are TWO findings draws: `buildWorkBlockPartition`
 * (`src/audit/reporting/workBlocks.ts`, the synthesis path) and
 * `buildAuditFindingsDeliverable` (`../reporting/auditDeliverable.ts`, the
 * leftover/re-consumable path). The second used to hard-code
 * `work_block_seams: []`, which was vacuously true only while any two findings
 * on one file merged into one block. Under `shared_file AND same_lens` they do
 * not, so a hard-coded empty list drops a real write conflict — and the
 * remediation phase cut then dispatches the contesting blocks in parallel with
 * nothing gating them. One derivation, both producers.
 */

import { createHash } from "node:crypto";

import { compareCodeUnits } from "../compareCodeUnits.js";
import type { WorkBlock, WorkBlockSeam } from "../types/finding.js";

/**
 * Content-derived seam id: a function of the contested FILE alone, so the id
 * survives re-partitioning, block renumbering, and any reordering of the input
 * findings. A positional `seam-N` could not — and `prepares_seam_ids` in the
 * remediation contract pipeline references these across runs.
 */
export function workBlockSeamId(file: string): string {
  return `seam-${createHash("sha256").update(file, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * The seam's human sentence, derived from its own fields. Exported because the
 * approved-subset projection narrows `block_ids` to the surviving blocks and
 * must restate the count rather than persist a sentence that contradicts the
 * list beside it.
 */
export function workBlockSeamRationale(
  file: string,
  blockCount: number,
  kind: WorkBlockSeam["kind"],
): string {
  return kind === "systemic_coordination"
    ? `A coordination component contests the predicted write path ${file} with ${blockCount - 1} other component(s).`
    : `${blockCount} components cite the same predicted write path ${file}.`;
}

/**
 * One seam per CONTESTED FILE, listing every block that owns it.
 *
 * A file two or more blocks both claim IS the predicted write conflict, and the
 * conflict is a property of that path — not of each unordered block PAIR, which
 * is why the pairwise form emitted O(blocks²) records saying the same thing (on
 * the 2026-08-18 run: 181,251 pairwise records vs 839 per-file ones). A
 * unit-only overlap is not a write conflict and produces no seam: it said
 * "these components share unit context" and required nothing.
 *
 * Every emitted seam therefore requires preparation by construction — which the
 * schema states as `z.literal(true)` rather than leaving to the producer.
 */
export function deriveWorkBlockSeams(
  blocks: readonly WorkBlock[],
): WorkBlockSeam[] {
  const blocksByFile = new Map<string, Set<string>>();
  for (const block of blocks) {
    for (const path of block.owned_files) {
      const contenders = blocksByFile.get(path) ?? new Set<string>();
      contenders.add(block.id);
      blocksByFile.set(path, contenders);
    }
  }
  const coordinationBlocks = new Set(
    blocks
      .filter((block) => block.role === "coordination")
      .map((block) => block.id),
  );

  const seams: WorkBlockSeam[] = [];
  for (const file of [...blocksByFile.keys()].sort(compareCodeUnits)) {
    const blockIds = [...(blocksByFile.get(file) ?? [])].sort(compareCodeUnits);
    if (blockIds.length < 2) continue;
    const kind = blockIds.some((id) => coordinationBlocks.has(id))
      ? "systemic_coordination"
      : "predicted_write_conflict";
    seams.push({
      id: workBlockSeamId(file),
      file,
      block_ids: blockIds,
      kind,
      requires_preparation: true,
      rationale: workBlockSeamRationale(file, blockIds.length, kind),
    });
  }
  return seams;
}
