import { describe, it, expect } from "vitest";
import type { Finding } from "@audit-tools/shared";
import type { RemediationBlock } from "../src/state/types.js";
import {
  buildDocumentModelHint,
  buildImplementModelHint,
} from "../src/steps/dispatch.js";
import { makeState as makeBaseState } from "./test-helpers.js";

function makeFinding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    title: "Example finding",
    category: "General",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "Example summary.",
    affected_files: [{ path: "src/foo.ts" }],
    evidence: ["ev-1"],
    ...overrides,
  };
}

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

describe("buildDocumentModelHint", () => {
  it("returns deep for critical severity", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "critical" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("severity_critical");
  });

  it("returns deep for high severity", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "high" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("severity_high");
  });

  it("returns deep for security lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "medium", lens: "security" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("sensitive_lens_security");
  });

  it("returns deep for data_integrity lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "low", lens: "data_integrity" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("sensitive_lens_data_integrity");
  });

  it("returns deep for reliability lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "low", lens: "reliability" }),
    );
    expect(hint.tier).toBe("deep");
    expect(hint.reasons).toContain("sensitive_lens_reliability");
  });

  // Finding.lens is a free-form string (the auditor narrows it to its Lens union),
  // and buildDocumentModelHint's SAFE_LENS_PATTERN keys on cosmetic lens labels
  // (style/format/lint/typo/…). These cases intentionally use such labels to
  // exercise the small-tier "safe lens" branch — they are valid string inputs,
  // not canonical-enum values.
  it("returns small for low severity + high confidence + safe (cosmetic) lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "low", confidence: "high", lens: "style" }),
    );
    expect(hint.tier).toBe("small");
    expect(hint.reasons).toContain("low_severity_safe_lens");
  });

  it("returns small for info severity + high confidence + safe (cosmetic) lens", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "info", confidence: "high", lens: "lint" }),
    );
    expect(hint.tier).toBe("small");
  });

  it("returns standard for medium severity", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "medium", lens: "correctness" }),
    );
    expect(hint.tier).toBe("standard");
    expect(hint.reasons).toContain("default_document_item");
  });

  it("returns standard for low severity + low confidence", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "low", confidence: "low", lens: "maintainability" }),
    );
    expect(hint.tier).toBe("standard");
  });

  it("returns standard for low severity + safe lens but medium confidence", () => {
    const hint = buildDocumentModelHint(
      makeFinding({ id: "F-1", severity: "low", confidence: "medium", lens: "maintainability" }),
    );
    expect(hint.tier).toBe("standard");
  });
});

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
