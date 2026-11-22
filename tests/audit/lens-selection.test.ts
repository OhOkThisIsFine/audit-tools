import { expect, test } from "vitest";
import { questionLensSelectionIssue, resolveIntentLensSelection } from "../../src/audit/orchestrator/lensSelection.js";

test("no implicit mandatory lenses are added to a targeted selection", () => {
  expect(resolveIntentLensSelection({ include: ["behavior"], exclude: ["security"] })).toEqual(["behavior"]);
  expect(resolveIntentLensSelection({ include: [] })).toEqual([]);
});

test("default, exclude-only, and declared custom selection stay distinct", () => {
  expect(resolveIntentLensSelection(undefined)).toBeUndefined();
  expect(resolveIntentLensSelection({ exclude: ["architecture", "security"] })).toEqual([
    "behavior", "performance", "operability", "config_deployment", "tests",
  ]);
  expect(resolveIntentLensSelection({ include: ["custom:domain-rule", "tests", "tests", "behavior"] }))
    .toEqual(["behavior", "tests", "custom:domain-rule"]);
});

test("archived or invalid names and contradictory choices require explicit reconfirmation", () => {
  expect(questionLensSelectionIssue({ include: ["correctness", "security"] })).toMatch(/correctness.*reconfirm/iu);
  expect(questionLensSelectionIssue({ include: ["behavior"], exclude: ["behavior"] })).toMatch(/both included and excluded/iu);
  expect(questionLensSelectionIssue({ include: ["behavior"], omission_reasons: { security: "targeted retry audit" } })).toBeUndefined();
  expect(questionLensSelectionIssue({ include: ["behavior"], omission_reasons: { behavior: "wrong field" } })).toMatch(/selected/i);
});
