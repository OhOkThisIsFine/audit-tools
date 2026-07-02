import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { mapWithConcurrency } = await import("../../src/shared/concurrency.ts");

test("mapWithConcurrency preserves input order regardless of completion order", async () => {
  // Earlier items resolve LATER (descending delays), so completion order is the
  // reverse of input order; the result array must still be in input order.
  const items = [30, 20, 10, 0];
  const out = await mapWithConcurrency(items, 4, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  expect(out).toEqual(["0:30", "1:20", "2:10", "3:0"]);
});

test("mapWithConcurrency never exceeds the concurrency cap and does parallelize", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 4, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return i * 2;
  });
  expect(peak, `exactly 4 workers should run concurrently, saw peak ${peak}`).toBe(4);
  expect(out).toEqual(items.map((i) => i * 2));
});

test("mapWithConcurrency handles empty input and limit >= length", async () => {
  expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  expect(await mapWithConcurrency([1, 2], 10, async (x) => x * 2)).toEqual([2, 4]);
});

test("mapWithConcurrency clamps a sub-1 limit to serial (peak in-flight = 1)", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3], 0, async (x) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight -= 1;
    return x;
  });
  expect(peak).toBe(1);
});

test("mapWithConcurrency propagates a rejection from fn", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    }),
    /boom/,
  );
});
