import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  ItemSpec,
  RemediationBlock,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import {
  buildImplementModelHint,
} from "../../src/remediate/steps/dispatch.js";
import { makeFinding, makeSpec } from "./test-helpers.js";

/**
 * Assemble a minimal RemediationState containing the given findings (and
 * optional item specs) plus one block referencing them, so
 * buildImplementModelHint can resolve each finding and its risk classification.
 */
function makeStateWithBlock(
  blockId: string,
  findings: Finding[],
  specs: Record<string, ItemSpec> = {},
): { state: RemediationState; block: RemediationBlock } {
  const block: RemediationBlock = {
    block_id: blockId,
    items: findings.map((f) => f.id),
    parallel_safe: true,
  };
  const items: Record<string, RemediationItemState> = {};
  for (const finding of findings) {
    const item: RemediationItemState = {
      finding_id: finding.id,
      status: "pending",
      block_id: blockId,
    };
    if (specs[finding.id]) {
      item.item_spec = specs[finding.id];
    }
    items[finding.id] = item;
  }
  const state = {
    status: "implementing",
    plan: {
      plan_id: "PLAN-1",
      findings,
      blocks: [block],
      project_type: "typescript-node",
      candidate_closing_actions: ["none"],
    },
    items,
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
  return { state, block };
}

describe("buildImplementModelHint", () => {
  it("deep tier when the block contains a critical-severity finding", () => {
    const { state, block } = makeStateWithBlock("B-crit", [
      makeFinding({ id: "F-crit", severity: "critical", lens: "correctness" }),
    ]);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("critical_severity");
  });

  it("deep tier when the block has 5 or more items", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ id: `F-${i}`, severity: "medium", lens: "maintainability" }),
    );
    const { state, block } = makeStateWithBlock("B-large", findings);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("large_block");
  });

  it("small tier for a single safe low-severity finding", () => {
    const finding = makeFinding({
      id: "F-safe",
      severity: "low",
      confidence: "high",
      lens: "style",
    });
    const { state, block } = makeStateWithBlock(
      "B-safe",
      [finding],
      // A style lens + high confidence + non-destructive change classifies as
      // "safe" in classifyFindingRisk, so the single-finding block is "small".
      { "F-safe": makeSpec("F-safe", "Reformat the file with prettier.") },
    );
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("small");
    expect(hint.reasons).toContain("all_safe_single_finding");
  });

  it("standard tier as the default fallback", () => {
    const { state, block } = makeStateWithBlock("B-default", [
      makeFinding({ id: "F-a", severity: "medium", lens: "maintainability" }),
      makeFinding({ id: "F-b", severity: "medium", lens: "performance" }),
    ]);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("standard");
    expect(hint.reasons).toContain("default_implement_block");
  });
});
