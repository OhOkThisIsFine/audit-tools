import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import type { ItemSpec } from "../../src/remediate/state/types.js";
import {
  classifyFindingRisk,
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

function makeSpec(overrides: Partial<ItemSpec> = {}): ItemSpec {
  return {
    finding_id: "F-001",
    concrete_change: "Refactor the dispatch scheduler.",
    tests_to_write: [],
    not_applicable_steps: [],
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

  describe("classifyFindingRisk", () => {
    it("returns context_dependent when confidence is low", () => {
      const result = classifyFindingRisk(
        makeFinding({ confidence: "low" }),
        makeSpec(),
      );
      expect(result.tier).toBe("context_dependent");
    });

    it("returns safe when severity is low, confidence is high, and lens is style", () => {
      const result = classifyFindingRisk(
        makeFinding({ severity: "low", confidence: "high", lens: "style" }),
        makeSpec(),
      );
      expect(result.tier).toBe("safe");
    });

    it("returns substantive when severity is medium and confidence is high and lens is architecture", () => {
      const result = classifyFindingRisk(
        makeFinding({ severity: "medium", confidence: "high", lens: "architecture" }),
        makeSpec(),
      );
      expect(result.tier).toBe("substantive");
    });
  });

});
