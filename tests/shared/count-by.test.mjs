/**
 * Shared countBy reducer (src/shared/countBy.ts) — the generic "count items by
 * derived key" extracted out of 4 independent reimplementations: audit's
 * synthesis summary breakdowns, the shared audit-deliverable renderer, and
 * remediate's outcomes close-out / findings digest.
 */
import { test, expect } from "vitest";
import { countBy } from "audit-tools/shared";

test("counts items by their derived key", () => {
  const items = ["a", "b", "a", "c", "b", "a"];
  expect(countBy(items, (x) => x)).toEqual({ a: 3, b: 2, c: 1 });
});

test("preserves first-seen key insertion order", () => {
  const items = ["z", "a", "z", "m"];
  expect(Object.keys(countBy(items, (x) => x))).toEqual(["z", "a", "m"]);
});

test("skips items whose selectKey returns undefined", () => {
  const items = [{ k: "a" }, { k: undefined }, { k: "a" }];
  expect(countBy(items, (x) => x.k)).toEqual({ a: 2 });
});

test("skips items whose selectKey returns an empty string", () => {
  const items = ["a", "", "a", ""];
  expect(countBy(items, (x) => x)).toEqual({ a: 2 });
});

test("returns an empty object for empty input", () => {
  expect(countBy([], (x) => x)).toEqual({});
});

test("accepts any Iterable, not just arrays", () => {
  function* gen() {
    yield "x";
    yield "y";
    yield "x";
  }
  expect(countBy(gen(), (x) => x)).toEqual({ x: 2, y: 1 });
});
