import { describe, it, expect } from "vitest";
import { RemediationBlockSchema } from "../../src/remediate/state/types.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";

const baseBlock = {
  block_id: "B1",
  items: ["F1"],
  parallel_safe: true,
  touched_files: ["src/a.ts"],
};

describe("RemediationBlock cofile_parallel_safe (A1: bare boolean, no anchor apparatus)", () => {
  it("(1) a legacy block with no cofile_parallel_safe parses and the field is absent (=== false semantics)", () => {
    const parsed = RemediationBlockSchema.parse(baseBlock);
    expect(parsed.cofile_parallel_safe).toBeUndefined();
    // absent === false: coercing the optional to a boolean is false.
    expect(Boolean(parsed.cofile_parallel_safe)).toBe(false);
  });

  it("(2) .strict() still rejects an unknown extra key", () => {
    const result = RemediationBlockSchema.safeParse({
      ...baseBlock,
      unknown_extra_key: true,
    });
    expect(result.success).toBe(false);
    // ZodError surfaced on failure.
    if (!result.success) {
      expect(result.error.name).toBe("ZodError");
    }
  });

  it("(3) a block with cofile_parallel_safe:true parses", () => {
    const parsed = RemediationBlockSchema.parse({
      ...baseBlock,
      cofile_parallel_safe: true,
    });
    expect(parsed.cofile_parallel_safe).toBe(true);
  });

  it("(4) no WriteRegion/WriteAnchor/LineHint anchor apparatus was added to the block surface", async () => {
    const mod = await import("../../src/remediate/state/types.js");
    const exportNames = Object.keys(mod);
    for (const forbidden of ["WriteRegion", "WriteAnchor", "LineHint"]) {
      expect(exportNames).not.toContain(forbidden);
      expect(exportNames).not.toContain(`${forbidden}Schema`);
    }
    // The block schema's key set is exactly the known keys plus the new bare boolean.
    const keys = Object.keys(RemediationBlockSchema.shape);
    expect(keys).toContain("cofile_parallel_safe");
    expect(keys).not.toContain("write_regions");
    expect(keys).not.toContain("write_anchors");
    expect(keys).not.toContain("line_hints");
    // Type-level reference so knip sees a consumer of the field.
    const typed: RemediationBlock = { ...baseBlock, cofile_parallel_safe: false };
    expect(typed.cofile_parallel_safe).toBe(false);
  });
});
