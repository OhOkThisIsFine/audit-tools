/**
 * S4 (single ID authority): the id registry owns the CP-BLOCK- block-id <-> bare
 * node-id mapping, and the dispatch merge resolves block ids through it
 * deterministically — so the tolerant alias remap is defence-in-depth, not
 * load-bearing.
 */
import { describe, it, expect } from "vitest";
import {
  CP_BLOCK_PREFIX,
  toBlockId,
  isBlockId,
  fromBlockId,
} from "../src/contractPipeline/idRegistry.js";
import { collapseItemResults } from "../src/steps/dispatch.js";

describe("idRegistry (S4 single ID authority)", () => {
  it("toBlockId applies the CP-BLOCK- prefix", () => {
    expect(toBlockId("N-foo")).toBe("CP-BLOCK-N-foo");
    expect(toBlockId("N-foo").startsWith(CP_BLOCK_PREFIX)).toBe(true);
  });

  it("isBlockId distinguishes a block id from a bare id", () => {
    expect(isBlockId("CP-BLOCK-N-foo")).toBe(true);
    expect(isBlockId("N-foo")).toBe(false);
  });

  it("fromBlockId reverses toBlockId and returns null for a non-block id", () => {
    expect(fromBlockId("CP-BLOCK-N-foo")).toBe("N-foo");
    expect(fromBlockId("N-foo")).toBeNull();
    expect(fromBlockId("OBL-x-inv-1")).toBeNull();
  });

  it("is a bijection on bare node ids: fromBlockId(toBlockId(n)) === n", () => {
    for (const n of ["N-foo", "N-1", "node.with.dots", "CP-BLOCK-weird"]) {
      expect(fromBlockId(toBlockId(n))).toBe(n);
    }
  });
});

describe("collapseItemResults resolves block ids via the registry (S4), not the alias remap", () => {
  const known = new Set(["N-foo"]);

  it("a worker that reports the CP-BLOCK- block id resolves to the node id with an EMPTY alias map", () => {
    // An empty alias map proves the resolution came from the id registry, not the
    // tolerant remap — the registry is load-bearing, the remap is not (INV-DISPATCH).
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: toBlockId("N-foo"), status: "resolved" }],
      new Map(),
      known,
    );
    expect(unresolved).toEqual([]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("a bare node id resolves directly", () => {
    const { collapsed } = collapseItemResults(
      [{ finding_id: "N-foo", status: "resolved" }],
      new Map(),
      known,
    );
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("a non-block alias (e.g. a mislabelled obligation id) still falls back to the tolerant alias map", () => {
    const aliasMap = new Map([["OBL-x", "N-foo"]]);
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "OBL-x", status: "resolved" }],
      aliasMap,
      known,
    );
    expect(unresolved).toEqual([]);
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("a block id whose node is not known does not silently resolve (fail-closed)", () => {
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: toBlockId("N-unknown"), status: "resolved" }],
      new Map(),
      known,
    );
    expect(collapsed).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });
});
