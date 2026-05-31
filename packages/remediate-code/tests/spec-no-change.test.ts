import { describe, it, expect } from "vitest";
import { specIndicatesNoChange } from "../src/steps/nextStep.js";

describe("specIndicatesNoChange", () => {
  it("treats an explicit no_change:true as a no-op", () => {
    expect(
      specIndicatesNoChange({ no_change: true, concrete_change: "does real work" }),
    ).toBe(true);
  });

  it("honors an explicit no_change:false even when the prose mentions a no-change phrase", () => {
    // Regression: a finding that changes some files but notes a sub-part needs
    // no change must NOT be classified as a no-op. This is the exact shape that
    // mis-bucketed FINDING-001/002/004/007/008 in the implementation preview and
    // would have mislabeled them `resolved_no_change` on merge.
    const specs = [
      "Change providers/index.ts default. No change is required in providers/constants.ts.",
      "Thread quota into prepareDispatchArtifacts; discoveredLimits.ts needs no change.",
      "Add buildQuotaSource factory. quotaSource.ts: no change.",
      "PRIORITY[] is the source of truth (already correct); reconcile CLAUDE.md to it.",
      "Emit only the canary packet. Make it a no-op when there is only one packet.",
    ];
    for (const concrete_change of specs) {
      expect(specIndicatesNoChange({ no_change: false, concrete_change })).toBe(false);
    }
  });

  it("falls back to the regex heuristic only when no_change is unspecified", () => {
    expect(
      specIndicatesNoChange({ concrete_change: "The code is already correct; nothing to do." }),
    ).toBe(true);
    expect(
      specIndicatesNoChange({ concrete_change: "Refactor the dispatch wave scheduler." }),
    ).toBe(false);
  });

  it("treats an undefined spec or empty concrete_change as not-a-no-op", () => {
    expect(specIndicatesNoChange(undefined)).toBe(false);
    expect(specIndicatesNoChange({})).toBe(false);
  });
});
