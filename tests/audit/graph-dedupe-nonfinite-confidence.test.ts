import { describe, it, expect } from "vitest";
import type { GraphEdge } from "../../src/shared/types/graph.js";

const { uniqueSortedEdges } = await import("../../src/audit/extractors/graph.js");

// `uniqueSortedEdges` promises, in its own doc comment, that "a shuffled input
// array yields byte-identical output" and that the surviving payload is decided
// "by content" rather than by push order. `survivesDedupe` keeps that promise
// with a two-step rule: stronger confidence wins, and a genuine TIE is broken by
// canonical serialization — the step that makes the result order-independent.
//
// A non-finite confidence defeats the tie-break rather than losing to it.
// `NaN !== NaN` is true, so the comparison takes the strength branch and returns
// `NaN > x`, which is false. The candidate can never survive, the serialization
// tie-break never runs, and which edge survives becomes a function of which one
// arrived first — exactly the property the function exists to remove.
const edge = (reason: string, confidence?: unknown): GraphEdge =>
  ({ from: "a.ts", to: "b.ts", kind: "imports", reason, confidence }) as GraphEdge;

describe("uniqueSortedEdges with a non-finite confidence", () => {
  it("survives dedupe independently of input order", () => {
    const stated = edge("stated", 0.9);
    const notStated = edge("not-stated", Number.NaN);

    const forward = uniqueSortedEdges([stated, notStated]);
    const reversed = uniqueSortedEdges([notStated, stated]);

    expect(forward).toHaveLength(1);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.reason).toBe(forward[0]?.reason);
  });

  it("lets a stated confidence beat an unstated one, whichever arrives first", () => {
    const stated = edge("stated", 0.9);
    const infinite = edge("infinite", Number.POSITIVE_INFINITY);

    // An Infinity confidence is not a stronger edge — it is an unstated one. It
    // must not win by arriving first, and must not win by being "greater".
    expect(uniqueSortedEdges([stated, infinite])[0]?.reason).toBe("stated");
    expect(uniqueSortedEdges([infinite, stated])[0]?.reason).toBe("stated");
  });
});
