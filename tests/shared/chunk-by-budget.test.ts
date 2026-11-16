/**
 * Shared chunkByBudget greedy chunker (src/shared/chunkByBudget.ts) — the
 * generic core extracted out of 3 independently duplicated
 * accumulate-then-flush loops: audit's review-packet chunker
 * (chunkPacketTasks in reviewPackets.ts), audit's per-task-block file chunker
 * (chunkByTaskBudget in taskBuilder.ts), and remediate's per-overlap-group
 * finding chunker (splitOversizedOverlapGroup in plan.ts).
 */
import { test, expect } from "vitest";
import { chunkByBudget } from "audit-tools/shared";

const sumCost = (items: number[]) => items.reduce((sum, n) => sum + n, 0);

test("empty input yields no chunks", () => {
  expect(chunkByBudget([], { costOf: sumCost, budget: 10 })).toEqual([]);
});

test("all items fit in a single chunk when under budget", () => {
  expect(chunkByBudget([1, 2, 3], { costOf: sumCost, budget: 100 })).toEqual([[1, 2, 3]]);
});

test("flushes when the next item would push the running cost over budget", () => {
  // 3 + 4 = 7 <= 10 (keep), + 5 = 12 > 10 (flush before adding 5).
  expect(chunkByBudget([3, 4, 5, 1], { costOf: sumCost, budget: 10 })).toEqual([
    [3, 4],
    [5, 1],
  ]);
});

test("an oversized single item is isolated into its own chunk without any special-casing", () => {
  // The natural flush-gate (current.length > 0 before checking budget) means a
  // single item over budget is never flushed against itself — it always lands
  // alone — and the item AFTER it triggers the flush of the oversized-alone
  // chunk. No special option is needed for this to hold.
  expect(chunkByBudget([1, 50, 1], { costOf: sumCost, budget: 10 })).toEqual([
    [1],
    [50],
    [1],
  ]);
});

test("an oversized item as the very first item still lands alone", () => {
  expect(chunkByBudget([50, 1], { costOf: sumCost, budget: 10 })).toEqual([[50], [1]]);
});

test("an oversized item as the very last item still lands alone", () => {
  expect(chunkByBudget([1, 50], { costOf: sumCost, budget: 10 })).toEqual([[1], [50]]);
});

test("maxItems caps chunk size even when well under budget", () => {
  expect(
    chunkByBudget([1, 1, 1, 1, 1], { costOf: sumCost, budget: 1000, maxItems: 2 }),
  ).toEqual([[1, 1], [1, 1], [1]]);
});

test("maxItems=0 disables the count check (budget-only)", () => {
  expect(
    chunkByBudget([1, 1, 1], { costOf: sumCost, budget: 1000, maxItems: 0 }),
  ).toEqual([[1, 1, 1]]);
});

