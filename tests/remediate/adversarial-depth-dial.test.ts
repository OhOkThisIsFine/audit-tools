import { expect, test } from "vitest";
import { adversarialDepthForTier } from "../../src/remediate/riskSignal.js";
import { reviewRequirementForRole } from "../../src/remediate/steps/contractPipelinePrompts.js";
test("low risk permits declared lightweight critique/critic but judge remains independent",()=>{
  expect(adversarialDepthForTier("low")).toBe("light");
  expect(reviewRequirementForRole("critique","light")).toBe("degraded_allowed");
  expect(reviewRequirementForRole("critic","light")).toBe("degraded_allowed");
  expect(reviewRequirementForRole("judge","light")).toBe("independent");
});
test("unknown and elevated risk require independent review",()=>{
  for(const tier of [undefined,"medium","high"] as const) {
    expect(adversarialDepthForTier(tier)).toBe("full");
    for(const role of ["critique","critic","judge"]) expect(reviewRequirementForRole(role,adversarialDepthForTier(tier))).toBe("independent");
  }
});
