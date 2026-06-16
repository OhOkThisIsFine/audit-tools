import { describe, it, expect } from "vitest";
import type { Finding } from "@audit-tools/shared";
import {
  classifyReviewNecessity,
  partitionByReviewNecessity,
  REVIEW_NECESSITY_ORDER,
  REVIEW_NECESSITY_LABELS,
} from "../src/review/reviewNecessity.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    title: "t",
    category: "General",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "s",
    affected_files: [],
    ...over,
  };
}

describe("classifyReviewNecessity — review-necessity tiering", () => {
  it("architecture lens is ALWAYS strategic (the 2026-06-15 design-review fix)", () => {
    // The exact failure mode: 42 architecture findings auto-dispositioned.
    for (const severity of ["critical", "high", "medium", "low", "info"] as const) {
      const c = classifyReviewNecessity(finding({ lens: "architecture", severity }));
      expect(c.necessity).toBe("strategic");
      expect(c.rationale).toMatch(/design-review|architecture/i);
    }
  });

  it("high-severity systemic non-architecture finding is strategic", () => {
    expect(
      classifyReviewNecessity(
        finding({ lens: "reliability", severity: "high", systemic: true }),
      ).necessity,
    ).toBe("strategic");
    expect(
      classifyReviewNecessity(
        finding({ lens: "security", severity: "critical", systemic: true }),
      ).necessity,
    ).toBe("strategic");
  });

  it("high-severity non-systemic finding is concrete (real fix, worth a confirm)", () => {
    expect(
      classifyReviewNecessity(
        finding({ lens: "correctness", severity: "high", systemic: false }),
      ).necessity,
    ).toBe("concrete");
  });

  it("a non-high systemic finding is NOT escalated to strategic", () => {
    // systemic alone (medium) must not flood the strategic tier.
    expect(
      classifyReviewNecessity(
        finding({ lens: "maintainability", severity: "medium", systemic: true }),
      ).necessity,
    ).toBe("concrete");
  });

  it("info severity is mechanical regardless of confidence", () => {
    expect(
      classifyReviewNecessity(finding({ severity: "info", confidence: "low" })).necessity,
    ).toBe("mechanical");
  });

  it("low severity + high confidence is mechanical; low + lower confidence is concrete", () => {
    expect(
      classifyReviewNecessity(finding({ severity: "low", confidence: "high" })).necessity,
    ).toBe("mechanical");
    expect(
      classifyReviewNecessity(finding({ severity: "low", confidence: "medium" })).necessity,
    ).toBe("concrete");
  });

  it("plain medium-severity finding is concrete", () => {
    expect(classifyReviewNecessity(finding({ severity: "medium" })).necessity).toBe(
      "concrete",
    );
  });
});

describe("deriveImplementationCost (via classification) — blast radius", () => {
  it("systemic findings cost high regardless of file count", () => {
    expect(
      classifyReviewNecessity(finding({ systemic: true, affected_files: [] }))
        .implementation_cost,
    ).toBe("high");
  });

  it("4+ affected files cost high, 2-3 cost medium, <2 cost low", () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.ts` }));
    expect(
      classifyReviewNecessity(finding({ affected_files: files(4) })).implementation_cost,
    ).toBe("high");
    expect(
      classifyReviewNecessity(finding({ affected_files: files(2) })).implementation_cost,
    ).toBe("medium");
    expect(
      classifyReviewNecessity(finding({ affected_files: files(1) })).implementation_cost,
    ).toBe("low");
  });
});

describe("partitionByReviewNecessity", () => {
  it("groups into all three tiers and preserves input order within a tier", () => {
    const findings: Finding[] = [
      finding({ id: "A", lens: "architecture" }), // strategic
      finding({ id: "B", severity: "info" }), // mechanical
      finding({ id: "C", severity: "high", systemic: true, lens: "security" }), // strategic
      finding({ id: "D", severity: "medium" }), // concrete
    ];
    const buckets = partitionByReviewNecessity(findings);
    expect(buckets.strategic.map((c) => c.finding.id)).toEqual(["A", "C"]);
    expect(buckets.concrete.map((c) => c.finding.id)).toEqual(["D"]);
    expect(buckets.mechanical.map((c) => c.finding.id)).toEqual(["B"]);
  });

  it("always returns all three keys, even when empty", () => {
    const buckets = partitionByReviewNecessity([]);
    expect(Object.keys(buckets).sort()).toEqual(["concrete", "mechanical", "strategic"]);
    expect(buckets.strategic).toEqual([]);
  });
});

describe("tier metadata", () => {
  it("REVIEW_NECESSITY_ORDER lists most-review-needed first and covers every tier", () => {
    expect(REVIEW_NECESSITY_ORDER[0]).toBe("strategic");
    expect([...REVIEW_NECESSITY_ORDER].sort()).toEqual([
      "concrete",
      "mechanical",
      "strategic",
    ]);
  });

  it("every tier has a label + description", () => {
    for (const tier of REVIEW_NECESSITY_ORDER) {
      expect(REVIEW_NECESSITY_LABELS[tier].title.length).toBeGreaterThan(0);
      expect(REVIEW_NECESSITY_LABELS[tier].description.length).toBeGreaterThan(0);
    }
  });
});
