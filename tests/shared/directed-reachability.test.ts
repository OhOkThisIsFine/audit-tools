import { describe, expect, it } from "vitest";
import { computeDirectedReachability } from "../../src/shared/graph/directedReachability.js";

describe("computeDirectedReachability (CY-11)", () => {
  it("traverses a linear chain to its end", () => {
    const graph: Record<string, string[]> = {
      a: ["b"],
      b: ["c"],
      c: ["d"],
      d: [],
    };
    const reached = computeDirectedReachability(["a"], (node) => graph[node]);
    expect([...reached].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("terminates safely on cycles without infinite looping", () => {
    const graph: Record<string, string[]> = {
      a: ["b"],
      b: ["c"],
      c: ["a", "d"],
      d: ["b"],
    };
    const reached = computeDirectedReachability(["a"], (node) => graph[node]);
    expect([...reached].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("respects the edge-traversal predicate to halt traversal along blocked edges", () => {
    const graph: Record<string, string[]> = {
      a: ["b", "c"],
      b: ["d"],
      c: ["e"],
      d: [],
      e: [],
    };
    const blockedEdges: [string, string][] = [];
    const reached = computeDirectedReachability(
      ["a"],
      (node) => graph[node],
      (from, to) => {
        if (from === "a" && to === "c") {
          blockedEdges.push([from, to]);
          return false;
        }
        return true;
      },
    );
    expect([...reached].sort()).toEqual(["a", "b", "d"]);
    expect(blockedEdges).toEqual([["a", "c"]]);
  });

  it("reaches a node via an unblocked alternate path even if one path was blocked", () => {
    const graph: Record<string, string[]> = {
      start: ["p1", "p2"],
      p1: ["target"],
      p2: ["target"],
      target: ["leaf"],
      leaf: [],
    };
    const reached = computeDirectedReachability(
      ["start"],
      (node) => graph[node],
      (from, to) => {
        // Block the p1 -> target edge, but allow p2 -> target
        if (from === "p1" && to === "target") return false;
        return true;
      },
    );
    expect([...reached].sort()).toEqual(["leaf", "p1", "p2", "start", "target"]);
  });

  it("mutates and returns the passed Set instance if seeds is a Set", () => {
    const seeds = new Set(["x"]);
    const graph: Record<string, string[]> = {
      x: ["y"],
      y: ["z"],
    };
    const returned = computeDirectedReachability(seeds, (node) => graph[node]);
    expect(returned).toBe(seeds);
    expect([...seeds].sort()).toEqual(["x", "y", "z"]);
  });

  it("handles empty seeds and disconnected nodes", () => {
    const graph: Record<string, string[]> = {
      a: ["b"],
      b: [],
      c: ["d"],
    };
    expect([...computeDirectedReachability<string>([], (node) => graph[node])]).toEqual([]);
    expect([...computeDirectedReachability(["b"], (node) => graph[node])]).toEqual(["b"]);
  });
});
