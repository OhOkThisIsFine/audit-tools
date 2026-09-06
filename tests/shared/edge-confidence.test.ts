import { describe, it, expect } from "vitest";
import type { GraphEdge } from "../../src/shared/types/graph.js";

const { edgeConfidence } = await import("../../src/shared/graph/edgeConfidence.js");

const edge = (confidence?: unknown): GraphEdge =>
  ({ from: "a.ts", to: "b.ts", kind: "imports", confidence }) as GraphEdge;

describe("edgeConfidence", () => {
  it("returns a stated finite confidence unchanged", () => {
    expect(edgeConfidence(edge(0.87))).toBe(0.87);
  });

  it("reads a stated zero as zero, not as absent", () => {
    expect(edgeConfidence(edge(0))).toBe(0);
  });

  it("passes a negative value through — clamping is a caller's policy, not this reading", () => {
    expect(edgeConfidence(edge(-1))).toBe(-1);
  });

  it("reads an absent confidence as 0", () => {
    expect(edgeConfidence(edge(undefined))).toBe(0);
    expect(edgeConfidence({ from: "a.ts", to: "b.ts" } as GraphEdge)).toBe(0);
  });

  it("reads a non-number as 0", () => {
    expect(edgeConfidence(edge("0.9"))).toBe(0);
    expect(edgeConfidence(edge(null))).toBe(0);
  });

  // The load-bearing half. A NaN confidence makes every comparison false, so a
  // caller picking the stronger of two edges silently keeps whichever it happened
  // to hold. Reading a non-finite value as "never stated one" makes that choice
  // deterministic.
  it("reads NaN and Infinity as 0, so a comparison cannot be silently arbitrary", () => {
    expect(edgeConfidence(edge(Number.NaN))).toBe(0);
    expect(edgeConfidence(edge(Number.POSITIVE_INFINITY))).toBe(0);
    expect(edgeConfidence(edge(Number.NEGATIVE_INFINITY))).toBe(0);
  });
});
