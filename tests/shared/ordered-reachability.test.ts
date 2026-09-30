import { expect, it } from "vitest";
import { propagateReachability } from "../../src/shared/graph/orderedReachability.js";

it("preserves fixed-point edge scan order rather than breadth-first order", () => {
  const reached = new Set(["seed"]);
  propagateReachability(reached, [["branch", "early"], ["seed", "branch"], ["branch", "late"], ["seed", "sibling"]], () => true);
  expect([...reached]).toEqual(["seed", "branch", "late", "sibling", "early"]);
});

it("terminates cycles and never calls edge policy for an already reached destination", () => {
  const reached = new Set(["a"]);
  const visited: string[] = [];
  propagateReachability(reached, [["a", "a"], ["a", "b"], ["b", "a"], ["b", "c"], ["missing", "z"]], (from, to) => { visited.push(`${from}:${to}`); return true; });
  expect([...reached]).toEqual(["a", "b", "c"]);
  expect(visited).toEqual(["a:b", "b:c"]);
});

it("leaves deferred policy local while another edge can still reach its target", () => {
  const reached = new Set(["seed"]);
  const deferred = new Set<string>();
  propagateReachability(reached, [["seed", "held"], ["seed", "other"], ["other", "held"], ["held", "leaf"]], (from, to) => {
    if (from === "seed" && to === "held") { deferred.add(to); return false; }
    return true;
  });
  expect([...reached]).toEqual(["seed", "other", "held", "leaf"]);
  expect([...deferred]).toEqual(["held"]);
});

it("supports absent seeds without deciding whether they belong in consumer output", () => {
  const absent = new Set(["missing"]);
  const reached = new Set(["stale", ...absent]);
  propagateReachability(reached, [["middle", "tail"], ["missing", "middle"], ["stale", "last"]], () => true);
  expect([...reached].filter(node => !absent.has(node))).toEqual(["stale", "middle", "last", "tail"]);
  expect([...absent]).toEqual(["missing"]);
});
