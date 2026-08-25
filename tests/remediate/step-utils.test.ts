import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import {
  rationaleAsksForRetry,
} from "../../src/remediate/steps/stepUtils.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "high",
    lens: "architecture",
    summary: "Something to fix.",
    affected_files: [{ path: "src/a.ts" }],
    evidence: [],
    ...overrides,
  };
}

describe("stepUtils exports are stable after extraction", () => {
  describe("rationaleAsksForRetry", () => {
    it("returns true for deferred retry-later rationale", () => {
      expect(
        rationaleAsksForRetry(
          "Deferred - retry in a dedicated pass after the prerequisite lands.",
        ),
      ).toBe(true);
    });

    it("returns false for explicit do-not-remediate rationale", () => {
      expect(rationaleAsksForRetry("User said this is out of scope.")).toBe(false);
    });
  });

});
