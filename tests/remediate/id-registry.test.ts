/**
 * S4 (single ID authority): the id registry owns the one-way CP-BLOCK- block-id
 * mint used by the promoted remediation plan.
 */
import { describe, it, expect } from "vitest";
import {
  CP_BLOCK_PREFIX,
  toBlockId,
  ensureNodeId,
} from "../../src/remediate/contractPipeline/idRegistry.js";

describe("idRegistry (S4 single ID authority)", () => {
  it("toBlockId applies the CP-BLOCK- prefix", () => {
    expect(toBlockId("N-foo")).toBe("CP-BLOCK-N-foo");
    expect(toBlockId("N-foo").startsWith(CP_BLOCK_PREFIX)).toBe(true);
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
    expect(findingId).toBe("CP-001");
    expect(blockId).toBe("CP-BLOCK-CP-001");
    expect(blockId).toBe(toBlockId(findingId));
  });
});
