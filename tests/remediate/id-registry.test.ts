/**
 * S4 (single ID authority): the id registry owns the CP-BLOCK- block-id <-> bare
 * node-id mapping used by the promoted remediation plan.
 */
import { describe, it, expect } from "vitest";
import {
  CP_BLOCK_PREFIX,
  toBlockId,
  isBlockId,
  fromBlockId,
  ensureNodeId,
} from "../../src/remediate/contractPipeline/idRegistry.js";

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

describe("ensureNodeId (single fallback authority — closes the finding<->block merge trap)", () => {
  it("returns the planner-authored id verbatim when present", () => {
    expect(ensureNodeId("N-foo", 0)).toBe("N-foo");
    expect(ensureNodeId("N-foo", 5)).toBe("N-foo");
  });

  it("applies the deterministic 1-indexed zero-padded CP-NNN fallback when the id is missing", () => {
    expect(ensureNodeId(undefined, 0)).toBe("CP-001");
    expect(ensureNodeId(undefined, 9)).toBe("CP-010");
    expect(ensureNodeId(undefined, 122)).toBe("CP-123");
  });

  it("the finding id and the block id stay consistent when node.id is missing (the bug this closes)", () => {
    // Before: finding id used the CP-NNN fallback but block_id/items used the raw
    // (undefined) node.id -> finding `CP-001` vs block `CP-BLOCK-undefined`, so the
    // worker result could not be resolved back to the finding. Routing both through
    // ensureNodeId makes them round-trip.
    const index = 0;
    const findingId = ensureNodeId(undefined, index);
    const blockId = toBlockId(ensureNodeId(undefined, index));
    expect(blockId).toBe("CP-BLOCK-CP-001");
    expect(fromBlockId(blockId)).toBe(findingId);
  });
});
