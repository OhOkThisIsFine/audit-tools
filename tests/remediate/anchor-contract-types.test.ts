import { describe, it, expect } from "vitest";
import {
  RemediationBlockSchema,
  RemediationPlanSchema,
} from "../../src/remediate/state/types.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import { FindingSchema } from "../../src/shared/types/finding.js";

const baseFinding = {
  id: "F1",
  title: "First",
  category: "correctness",
  severity: "high",
  confidence: "high",
  lens: "correctness",
  summary: "Fix first.",
  affected_files: [{ path: "src/a.ts" }],
  evidence: ["src/a.ts:1 evidence"],
};

const basePlan = {
  plan_id: "PLAN-1",
  findings: [baseFinding],
  blocks: [
    { block_id: "B1", items: ["F1"], parallel_safe: true, touched_files: ["src/a.ts"] },
  ],
  project_type: "unknown",
  candidate_closing_actions: ["none"] as const,
};

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

describe("FindingSchema contract-pipeline fields (O46)", () => {
  it("a legacy finding without the four optional fields remains valid", () => {
    // No concrete_change / preconditions / expected_changes / addresses_counterexamples.
    const parsed = FindingSchema.parse(baseFinding);
    expect(parsed.concrete_change).toBeUndefined();
    expect(parsed.preconditions).toBeUndefined();
    expect(parsed.expected_changes).toBeUndefined();
    expect(parsed.addresses_counterexamples).toBeUndefined();
  });

  it("a finding carrying all four fields round-trips them verbatim", () => {
    const parsed = FindingSchema.parse({
      ...baseFinding,
      concrete_change: "Wrap the call in a retry loop",
      preconditions: ["upstream A is merged", "B is merged"],
      expected_changes: "Idempotent retry with backoff",
      addresses_counterexamples: ["CE-1"],
    });
    expect(parsed.concrete_change).toBe("Wrap the call in a retry loop");
    expect(parsed.preconditions).toEqual(["upstream A is merged", "B is merged"]);
    expect(parsed.expected_changes).toBe("Idempotent retry with backoff");
    expect(parsed.addresses_counterexamples).toEqual(["CE-1"]);
  });

  it("a malformed field type fails the parse", () => {
    // `preconditions` must be an array of strings, not a bare string.
    expect(() =>
      FindingSchema.parse({ ...baseFinding, preconditions: "P1" }),
    ).toThrow();
    // `concrete_change` must be a string, not a number.
    expect(() =>
      FindingSchema.parse({ ...baseFinding, concrete_change: 42 }),
    ).toThrow();
    // `addresses_counterexamples` must be an array of strings.
    expect(() =>
      FindingSchema.parse({ ...baseFinding, addresses_counterexamples: [1, 2] }),
    ).toThrow();
  });
});

describe("RemediationPlanSchema.themes removal (M47)", () => {
  it("rejects a top-level `themes` property under the strict schema", () => {
    const result = RemediationPlanSchema.safeParse({
      ...basePlan,
      themes: [],
    });
    // `.strict()` reports an unrecognized key as an `unrecognized_keys` issue.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.code === "unrecognized_keys"),
      ).toBe(true);
    }
  });

  it("a plan without `themes` remains valid", () => {
    expect(RemediationPlanSchema.safeParse(basePlan).success).toBe(true);
  });

  it("the `themes` key is no longer on the plan schema shape", () => {
    expect(Object.keys(RemediationPlanSchema.shape)).not.toContain("themes");
  });
});
