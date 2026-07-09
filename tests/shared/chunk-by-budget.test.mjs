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

const sumCost = (items) => items.reduce((sum, n) => sum + n, 0);

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
  // chunk. No `isolateAlone` option needed for this to hold.
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

test("isolateAlone immediately isolates a flagged item, bypassing the normal candidate check", () => {
  // Item "BIG" is flagged regardless of its own cost; a normal accumulate
  // would have merged it (cost 1 fits easily), but isolateAlone forces it
  // into its own chunk and flushes whatever was accumulating first.
  const items = ["a", "b", "BIG", "c"];
  const costOf = (candidate) => candidate.length; // cheap, would never overflow alone
  const result = chunkByBudget(items, {
    costOf,
    budget: 100,
    isolateAlone: (item) => item === "BIG",
  });
  expect(result).toEqual([["a", "b"], ["BIG"], ["c"]]);
});

test("onIsolate and onBeforeFlush fire with the expected info", () => {
  const isolateEvents = [];
  const flushEvents = [];
  chunkByBudget([1, 50, 1], {
    costOf: sumCost,
    budget: 10,
    isolateAlone: (item) => item === 50,
    onIsolate: (item) => isolateEvents.push(item),
    onBeforeFlush: (info) => flushEvents.push(info.item),
  });
  expect(isolateEvents).toEqual([50]);
  // The item right after the isolated 50 (the trailing 1) still triggers the
  // normal flush path, since chunkByBudget resets `current` after isolating.
  expect(flushEvents).toEqual([]);
});

test("onBeforeFlush reports whether the count or budget check tripped", () => {
  const reasons = [];
  chunkByBudget([1, 1, 1], {
    costOf: sumCost,
    budget: 1000,
    maxItems: 1,
    onBeforeFlush: (info) =>
      reasons.push({ wouldExceedCount: info.wouldExceedCount, wouldExceedBudget: info.wouldExceedBudget }),
  });
  expect(reasons).toEqual([
    { wouldExceedCount: true, wouldExceedBudget: false },
    { wouldExceedCount: true, wouldExceedBudget: false },
  ]);
});
