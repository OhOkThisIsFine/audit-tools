// sites-pinned: tests/shared/chunk-by-budget.test.ts
// <!-- comment-citation-exempt: names deliberately-retired symbols; this block records that history -->
/**
 * Generic greedy token/size-budget chunker. Independently duplicated
 * "accumulate items into `current`, flush when adding the next one would
 * exceed budget" loops shared this exact shape: the audit review-packet
 * chunker (`chunkPacketTasks` in src/audit/orchestrator/reviewPackets.ts) and
 * audit's per-task-block file chunker (`chunkByTaskBudget` in
 * src/audit/orchestrator/taskBuilder.ts). (Remediate had a third, its
 * per-overlap-group finding chunker, retired with context-budget block
 * splitting — planning reports size and never reshapes work to a backend
 * window.) Single-sourced here as the common core; each original function
 * becomes a thin adapter over it, keeping its own cost model.
 *
 * The shared invariants across the original loops:
 *  - Items are appended one at a time; before adding item N, the WOULD-BE
 *    candidate (`current` + item N) is cost-checked — and count-checked when
 *    `maxItems` is supplied — but ONLY once `current` already holds at least
 *    one item. A single oversized item is therefore always allowed into a
 *    chunk alone (never itself split further); this is what isolates a giant
 *    item into its own chunk without any special-casing.
 *  - `costOf` is invoked on the WHOLE candidate array each time, not folded
 *    incrementally. This produces identical chunk boundaries to callers whose
 *    original cost was a simple per-item running sum (addition is
 *    associative) while also serving callers whose cost is NOT a simple sum
 *    (e.g. a group cost that de-duplicates shared file paths).
 */
export interface ChunkByBudgetOptions<T> {
  /** Cost of an arbitrary (non-empty) candidate array of items. */
  costOf: (candidate: T[]) => number;
  /** A chunk's cost must not exceed this once it holds more than one item. */
  budget: number;
  /** Optional max item count per chunk. 0/undefined disables the count check. */
  maxItems?: number;
}

export function chunkByBudget<T>(
  items: T[],
  options: ChunkByBudgetOptions<T>,
): T[][] {
  const { costOf, budget, maxItems } = options;
  const chunks: T[][] = [];
  let current: T[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const wouldExceedCount =
      maxItems !== undefined && maxItems > 0 && candidate.length > maxItems;
    const wouldExceedBudget = current.length > 0 && costOf(candidate) > budget;

    if (wouldExceedCount || wouldExceedBudget) {
      chunks.push(current);
      current = [];
    }

    current.push(item);
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
