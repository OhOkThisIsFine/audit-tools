import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import {
  buildImplementModelHint,
} from "../../src/remediate/steps/dispatch.js";
import { makeState as makeBaseState, makeFinding } from "./test-helpers.js";

function buildItems(
  findings: Finding[],
  itemSpecs?: Record<string, { tier: string }>,
): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (const f of findings) {
    items[f.id] = {
      status: "pending",
      item_spec: itemSpecs?.[f.id]
        ? {
            finding_id: f.id,
            concrete_change: "Fix it",
            tests_to_write: [],
            not_applicable_steps: [],
          }
        : undefined,
    };
  }
  return items;
}

function makeState(
  findings: Finding[],
  blocks: RemediationBlock[],
  itemSpecs?: Record<string, { tier: string }>,
) {
  return makeBaseState({
    plan: {
      plan_id: "test-plan",
      findings,
      blocks,
      project_type: "node",
      candidate_closing_actions: [],
    },
    items: buildItems(findings, itemSpecs),
  });
}

describe("buildImplementModelHint", () => {
  it("returns deep when a finding has critical severity", () => {
    const f = makeFinding({ id: "F-1", severity: "critical" });
    const block: RemediationBlock = { block_id: "B-1", items: ["F-1"], parallel_safe: true };
    const state = makeState([f], [block]);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("critical_severity");
  });

  it("returns deep for large blocks (5+ findings)", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ id: `F-${i}`, severity: "low" }),
    );
    const block: RemediationBlock = {
      block_id: "B-1",
      items: findings.map((f) => f.id),
      parallel_safe: true,
    };
    const state = makeState(findings, [block]);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("large_block");
  });

  it("returns small for single safe finding with low severity", () => {
    const f = makeFinding({ id: "F-1", severity: "low", confidence: "high" });
    const block: RemediationBlock = { block_id: "B-1", items: ["F-1"], parallel_safe: true };
    const state = makeState([f], [block], { "F-1": { tier: "safe" } });
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("small");
    expect(hint.reasons).toContain("all_safe_single_finding");
  });

  it("returns standard for mixed blocks", () => {
    const findings = [
      makeFinding({ id: "F-1", severity: "medium" }),
      makeFinding({ id: "F-2", severity: "low" }),
    ];
    const block: RemediationBlock = { block_id: "B-1", items: ["F-1", "F-2"], parallel_safe: true };
    const state = makeState(findings, [block]);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("standard");
    expect(hint.reasons).toContain("default_implement_block");
  });

  it("returns standard when no item_spec exists", () => {
    const f = makeFinding({ id: "F-1", severity: "low" });
    const block: RemediationBlock = { block_id: "B-1", items: ["F-1"], parallel_safe: true };
    const state = makeState([f], [block]);
    const hint = buildImplementModelHint(block, state);
    expect(hint.tier).toBe("standard");
  });
});
