import { describe, expect, it } from "vitest";
import {
  findingIdentitySignature,
  normalizeTitle,
} from "../../src/shared/findingIdentitySignature.js";

describe("normalizeTitle bare citation stripping", () => {
  it("normalizes titles identically when they differ only by a bare filename:line citation", () => {
    const a = normalizeTitle(
      "Null check missing before access in utils.ts:42",
    );
    const b = normalizeTitle(
      "Null check missing before access in helpers.ts:17",
    );
    expect(a).toBe(b);
    expect(a).toBe("null check missing before access in");
  });

  it("leaves ordinary numeric prose unaffected (control)", () => {
    expect(normalizeTitle("This finding occurs 3 times across the module")).toBe(
      "this finding occurs times across the module",
    );
  });

  it("does not affect the stronger structural-anchor tier", () => {
    const fields = { anchor_path: "src/utils.ts", anchor_symbol: "foo" };
    const a = findingIdentitySignature({ ...fields, title: "Issue in utils.ts:42" });
    const b = findingIdentitySignature({ ...fields, title: "Issue in helpers.ts:17" });
    expect(a).toBe(b);
    expect(a).toBe("anchor|src/utils.ts|foo");
  });
});
