/**
 * Generic greedy token/size-budget chunker. Three independently duplicated
 * "accumulate items into `current`, flush when adding the next one would
 * exceed budget" loops shared this exact shape: the audit review-packet
 * chunker (`chunkPacketTasks` in src/audit/orchestrator/reviewPackets.ts),
 * audit's per-task-block file chunker (`chunkByTaskBudget` in
 * src/audit/orchestrator/taskBuilder.ts), and remediate's per-overlap-group
 * finding chunker (`splitOversizedOverlapGroup` in
 * src/remediate/phases/plan.ts). Single-sourced here as the common core; each
 * original function becomes a thin adapter over it, keeping its own
 * cost-model/bypass specifics.
 *
 * The shared invariants across all three original loops:
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
  /**
   * When supplied and it returns true for `item` (given `current` BEFORE this
   * item is considered), `current` is flushed (if non-empty) and `item` is
   * placed into a chunk of its own immediately — bypassing the normal
   * accumulate/flush check for this item entirely. Mirrors
   * `chunkPacketTasks`'s isolated-large-file-task fast path; callers that
   * have no such fast path simply omit this option.
   */
  isolateAlone?: (item: T, current: T[]) => boolean;
  /** Called right after `current` is flushed for an `isolateAlone` item (before it is emitted as its own chunk). */
  onIsolate?: (item: T, current: T[]) => void;
  /**
   * Called immediately before a normal (non-isolated) flush, reporting which
   * check(s) tripped and the computed candidate cost — lets a caller
   * reproduce the exact verbose diagnostics its original inline loop emitted.
   */
  onBeforeFlush?: (info: {
    item: T;
    current: T[];
    wouldExceedCount: boolean;
    wouldExceedBudget: boolean;
    candidateCost: number;
  }) => void;
}

export function chunkByBudget<T>(
  items: T[],
  options: ChunkByBudgetOptions<T>,
): T[][] {
  const { costOf, budget, maxItems, isolateAlone, onIsolate, onBeforeFlush } = options;
  const chunks: T[][] = [];
  let current: T[] = [];

  for (const item of items) {
    if (isolateAlone?.(item, current)) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
      }
      onIsolate?.(item, current);
      chunks.push([item]);
      continue;
    }

    const candidate = [...current, item];
    const wouldExceedCount =
      maxItems !== undefined && maxItems > 0 && candidate.length > maxItems;
    const candidateCost = costOf(candidate);
    const wouldExceedBudget = current.length > 0 && candidateCost > budget;

    if (wouldExceedCount || wouldExceedBudget) {
      onBeforeFlush?.({ item, current, wouldExceedCount, wouldExceedBudget, candidateCost });
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
