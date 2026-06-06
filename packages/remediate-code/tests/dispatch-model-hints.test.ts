import { describe, it, expect } from "vitest";
import type { Finding } from "@audit-tools/shared";
import type { RemediationState } from "../src/state/store.js";
import type {
  ItemSpec,
  RemediationBlock,
  RemediationItemState,
} from "../src/state/types.js";
import {
  buildDocumentModelHint,
  buildImplementModelHint,
} from "../src/steps/dispatch.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "medium",
    lens: "maintainability",
    summary: "Something to fix.",
    affected_files: [{ path: "src/a.ts" }],
    evidence: [],
    ...overrides,
  };
}

describe("buildDocumentModelHint", () => {
  it("deep tier for critical severity", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "critical", lens: "tests", confidence: "medium" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("severity_critical");
  });

  it("deep tier for high severity", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "high", lens: "tests", confidence: "low" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("severity_high");
  });

  it("deep tier for sensitive lens (security)", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "medium", lens: "security", confidence: "medium" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("sensitive_lens_security");
  });

  it("deep tier for data_integrity lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "medium", lens: "data_integrity", confidence: "low" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("sensitive_lens_data_integrity");
  });

  it("deep tier for reliability lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "low", lens: "reliability", confidence: "high" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("sensitive_lens_reliability");
  });

  // Finding.lens is a free-form string (the auditor narrows it to its Lens union),
  // and buildDocumentModelHint's SAFE_LENS_PATTERN keys on cosmetic lens labels
  // (style/format/lint/typo/…). These cases intentionally use such labels to
  // exercise the small-tier "safe lens" branch — they are valid string inputs,
  // not canonical-enum values.
  it("small tier for low-severity high-confidence safe lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "low", confidence: "high", lens: "style" }),
    );
    expect(hint.tier).toBe("small");
    expect(hint.reasons).toContain("low_severity_safe_lens");
  });

  it("small tier for 'info' severity with a safe lens pattern", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "info", confidence: "high", lens: "lint" }),
    );
    expect(hint.tier).toBe("small");
  });

  it("standard tier as default (medium severity, non-sensitive lens)", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "medium", lens: "maintainability", confidence: "medium" }),
    );
    expect(hint.tier).toBe("standard");
    expect(hint.reasons).toContain("default_document_item");
  });

  it("low severity but low confidence falls through to standard, not small", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ severity: "low", confidence: "low", lens: "style" }),
    );
    // Low confidence disqualifies the small tier even with a safe lens.
    expect(hint.tier).toBe("standard");
  });
});

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
      status: "documented",
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

function makeSpec(findingId: string, concreteChange: string): ItemSpec {
  return {
    finding_id: findingId,
    concrete_change: concreteChange,
    tests_to_write: [{ name: `test-${findingId}`, assertions: ["passes"] }],
    not_applicable_steps: [],
  };
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
