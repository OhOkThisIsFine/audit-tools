import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import type { ItemSpec, RemediationBlock } from "../../src/remediate/state/types.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import {
  specIndicatesNoChange,
  hasExecutableEvidence,
  classifyFindingRisk,
  dependenciesSatisfied,
  rationaleAsksForRetry,
} from "../../src/remediate/steps/stepUtils.js";

describe("hasExecutableEvidence", () => {
  it("is false for empty or prose-only evidence", () => {
    expect(hasExecutableEvidence(undefined)).toBe(false);
    expect(hasExecutableEvidence([])).toBe(false);
    expect(
      hasExecutableEvidence([
        "Looks already correct; nothing to change.",
        "Reviewed the file.",
      ]),
    ).toBe(false);
  });
  it("is true when a line names a test/build/check command", () => {
    expect(hasExecutableEvidence(["npm test -w packages/shared"])).toBe(true);
    expect(hasExecutableEvidence(["ran npx vitest run tests/x.test.ts"])).toBe(true);
    expect(hasExecutableEvidence(["node --test packages/shared/tests/a.test.mjs"])).toBe(true);
    expect(hasExecutableEvidence(["npm run check -> 0 errors"])).toBe(true);
  });
  it("is true when a line reports a test-result count", () => {
    expect(hasExecutableEvidence(["25/25 pass"])).toBe(true);
    expect(hasExecutableEvidence(["12 passed, 0 failed"])).toBe(true);
    expect(hasExecutableEvidence(["all tests pass"])).toBe(true);
  });
});

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

function makeState(
  items: Record<string, { status: string }> = {},
  blocks: RemediationBlock[] = [],
): RemediationState {
  return {
    status: "implementing",
    items: items as RemediationState["items"],
    plan: blocks.length > 0
      ? {
          plan_id: "PLAN-001",
          findings: [],
          blocks,
          project_type: "node",
          candidate_closing_actions: ["none"],
        }
      : undefined,
  } as unknown as RemediationState;
}

describe("stepUtils exports are stable after extraction", () => {
  describe("specIndicatesNoChange", () => {
    it("returns true when no_change is explicitly true", () => {
      expect(
        specIndicatesNoChange({ no_change: true, concrete_change: "do something" }),
      ).toBe(true);
    });

    it("returns false when no_change is explicitly false (wins over heuristic)", () => {
      expect(
        specIndicatesNoChange({ no_change: false, concrete_change: "already correct" }),
      ).toBe(false);
    });

    it("returns true via heuristic fallback when no_change is unspecified and phrase matches", () => {
      expect(
        specIndicatesNoChange({ concrete_change: "no change needed" }),
      ).toBe(true);
    });

    it("returns false for undefined spec", () => {
      expect(specIndicatesNoChange(undefined)).toBe(false);
    });
  });

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

  describe("dependenciesSatisfied", () => {
    it("returns true when block has no dependencies", () => {
      const block: RemediationBlock = {
        block_id: "B-001",
        items: ["F-001"],
        parallel_safe: true,
        dependencies: [],
      };
      const state = makeState({ "F-001": { status: "pending" } });
      expect(dependenciesSatisfied(block, state)).toBe(true);
    });

    it("returns false when a dependency block has a non-terminal item status", () => {
      const depBlock: RemediationBlock = {
        block_id: "B-001",
        items: ["F-001"],
        parallel_safe: true,
        dependencies: [],
      };
      const dependentBlock: RemediationBlock = {
        block_id: "B-002",
        items: ["F-002"],
        parallel_safe: true,
        dependencies: ["B-001"],
      };
      const state = makeState(
        { "F-001": { status: "pending" }, "F-002": { status: "pending" } },
        [depBlock, dependentBlock],
      );
      expect(dependenciesSatisfied(dependentBlock, state)).toBe(false);
    });
  });
});
