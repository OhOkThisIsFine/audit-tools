import { describe, it, expect } from "vitest";
import { ExecutionUnitSchema } from "../../src/shared/types/executionPlan.js";
import { canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";

describe("reviewed unit scope without a second anchor apparatus", () => {
  it("keeps exact file grants and explicit dependency relationships", () => {
    const parsed = ExecutionUnitSchema.parse(canonicalUnitFixture("U", { allowed_files: ["src/a.ts"], dependencies: ["P"] }));
    expect(parsed.allowed_files).toEqual(["src/a.ts"]);
    expect(parsed.dependencies).toEqual(["P"]);
  });
  it("rejects unknown or retired scope-control fields", () => {
    for (const field of ["unknown_extra_key", "cofile_parallel_safe", "write_regions", "write_anchors", "line_hints"]) {
      expect(ExecutionUnitSchema.safeParse({ ...canonicalUnitFixture("U"), [field]: true }).success).toBe(false);
    }
  });
  it("does not expose separate WriteRegion/WriteAnchor/LineHint authorities", async () => {
    const mod = await import("../../src/remediate/state/types.js");
    for (const forbidden of ["WriteRegion", "WriteAnchor", "LineHint"]) {
      expect(Object.keys(mod)).not.toContain(forbidden);
      expect(Object.keys(mod)).not.toContain(`${forbidden}Schema`);
    }
  });
});
