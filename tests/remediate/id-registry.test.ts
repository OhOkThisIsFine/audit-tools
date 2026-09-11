/**
 * S4 (single ID authority): the id registry owns the one-way CP-BLOCK- block-id
 * mint used by the promoted remediation plan.
 */
import { describe, it, expect } from "vitest";
import {
  CP_BLOCK_PREFIX,
  moduleSlugForObligationId,
  obligationId,
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

describe("moduleSlugForObligationId (the obligation-id / module-name join)", () => {
  // The join was a longest-prefix match over the slug set, which is a guess
  // whenever one module slug is a prefix of another. These pin the EXACT join
  // the mint's suffix grammar makes possible.
  const slugs = new Set(["auth", "auth-service"]);

  it("resolves the more specific module when one slug prefixes another", () => {
    expect(moduleSlugForObligationId(obligationId("auth-service", "contract"), slugs)).toBe(
      "auth-service",
    );
    expect(moduleSlugForObligationId(obligationId("auth", "contract"), slugs)).toBe("auth");
  });

  it("returns null rather than another module's slug when the specific module is out of scope", () => {
    // With only `auth` in scope, `OBL-auth-service-contract` used to resolve to
    // `auth` — handing an `auth-service` obligation `auth`'s phase and file
    // scope. The suffix grammar makes it unresolvable instead, which the phase
    // walk already handles (fail toward the last phase).
    expect(
      moduleSlugForObligationId(obligationId("auth-service", "contract"), new Set(["auth"])),
    ).toBeNull();
  });

  it("resolves every suffix form the deriver mints, including mintUniqueId's numeric tail", () => {
    for (const suffixed of [
      obligationId("auth", "contract"),
      obligationId("auth", "inv-1"),
      obligationId("auth", "fail-12"),
      // mintUniqueId appends `-<n>` to a colliding base.
      `${obligationId("auth", "contract")}-2`,
      `${obligationId("auth", "inv-1")}-3`,
    ]) {
      expect(moduleSlugForObligationId(suffixed, slugs), suffixed).toBe("auth");
    }
  });

  it("refuses an id that is not an obligation id, or carries an unknown module", () => {
    expect(moduleSlugForObligationId("CP-BLOCK-CP-001", slugs)).toBeNull();
    expect(moduleSlugForObligationId("OBL-unknown-contract", slugs)).toBeNull();
    // A module slug alone is not an obligation id — the mint always appends a
    // suffix, so a bare body must not join.
    expect(moduleSlugForObligationId("OBL-auth", slugs)).toBeNull();
  });
});
