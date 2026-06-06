import { describe, it, expect } from "vitest";
import type { Finding } from "@audit-tools/shared";
import type { ItemSpec, RemediationBlock } from "../src/state/types.js";
import type { RemediationState } from "../src/state/store.js";
import {
  isTerminalStatus,
  specIndicatesNoChange,
  classifyFindingRisk,
  dependenciesSatisfied,
} from "../src/steps/stepUtils.js";

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
  describe("isTerminalStatus", () => {
    it("returns true for 'resolved'", () => {
      expect(isTerminalStatus("resolved")).toBe(true);
    });

    it("returns false for 'blocked'", () => {
      expect(isTerminalStatus("blocked")).toBe(false);
    });

    it("returns true for 'resolved_no_change'", () => {
      expect(isTerminalStatus("resolved_no_change")).toBe(true);
    });

    it("returns true for 'ignored'", () => {
      expect(isTerminalStatus("ignored")).toBe(true);
    });

    it("returns true for 'deemed_inappropriate'", () => {
      expect(isTerminalStatus("deemed_inappropriate")).toBe(true);
    });

    it("returns false for 'pending'", () => {
      expect(isTerminalStatus("pending")).toBe(false);
    });
  });

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
      const state = makeState({ "F-001": { status: "documented" } });
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
        { "F-001": { status: "documented" }, "F-002": { status: "documented" } },
        [depBlock, dependentBlock],
      );
      expect(dependenciesSatisfied(dependentBlock, state)).toBe(false);
    });
  });
});
