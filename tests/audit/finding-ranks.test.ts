import { test, expect } from "vitest";
import type { FindingSeverity } from "audit-tools/shared";

// findingRanks.ts re-exports the single-source rank functions from
// audit-tools/shared; this test pins both the values and that the re-export
// surface (including severityCompare) stays wired.
const { severityRank, confidenceRank, severityCompare } = await import("../../src/audit/reporting/findingRanks.js");

test("severityRank returns correct ordinal for each severity level", () => {
  expect(severityRank("critical")).toBe(5);
  expect(severityRank("high")).toBe(4);
  expect(severityRank("medium")).toBe(3);
  expect(severityRank("low")).toBe(2);
  expect(severityRank("info")).toBe(1);
  expect(severityRank("critical") > severityRank("high")).toBeTruthy();
  expect(severityRank("high") > severityRank("medium")).toBeTruthy();
  expect(severityRank("medium") > severityRank("low")).toBeTruthy();
  expect(severityRank("low") > severityRank("info")).toBeTruthy();
});

test("confidenceRank returns correct ordinal for each confidence level", () => {
  expect(confidenceRank("high")).toBe(3);
  expect(confidenceRank("medium")).toBe(2);
  expect(confidenceRank("low")).toBe(1);
  expect(confidenceRank("high") > confidenceRank("medium")).toBeTruthy();
  expect(confidenceRank("medium") > confidenceRank("low")).toBeTruthy();
});

test("severityCompare (re-exported from shared) orders critical-first", () => {
  const severities: FindingSeverity[] = ["low", "critical", "info", "high", "medium"];
  const sorted = severities.sort(severityCompare);
  expect(sorted).toEqual(["critical", "high", "medium", "low", "info"]);
});
