import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import {
  buildReviewRequest,
  applyReviewResolution,
  REVIEW_REQUEST_SCHEMA_VERSION,
} from "../../src/remediate/review/reviewGate.js";

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

const SAMPLE: Finding[] = [
  finding({ id: "ARC-1", lens: "architecture", title: "design thing" }), // strategic
  finding({ id: "ARC-2", lens: "architecture", severity: "low" }), // strategic
  finding({ id: "COR-1", lens: "correctness", severity: "high" }), // concrete
  finding({ id: "MNT-1", severity: "info", lens: "maintainability" }), // mechanical
];

describe("buildReviewRequest", () => {
  it("partitions findings into tiers, most-review-needed first, with counts", () => {
    const req = buildReviewRequest(SAMPLE, "plan-1");
    expect(req.schema_version).toBe(REVIEW_REQUEST_SCHEMA_VERSION);
    expect(req.plan_id).toBe("plan-1");
    expect(req.total).toBe(4);
    expect(req.counts).toEqual({ strategic: 2, concrete: 1, mechanical: 1 });
    // tiers ordered strategic → concrete → mechanical
    expect(req.tiers.map((t) => t.necessity)).toEqual([
      "strategic",
      "concrete",
      "mechanical",
    ]);
    expect(req.tiers[0].items.map((i) => i.finding_id)).toEqual(["ARC-1", "ARC-2"]);
  });

  it("omits empty tiers but counts always carry all three keys", () => {
    const req = buildReviewRequest([finding({ lens: "architecture" })], "p");
    expect(req.tiers.map((t) => t.necessity)).toEqual(["strategic"]);
    expect(req.counts).toEqual({ strategic: 1, concrete: 0, mechanical: 0 });
  });

  it("each entry carries the deterministic tool-owned fields (necessity, rationale, cost)", () => {
    const req = buildReviewRequest(
      [finding({ id: "X", lens: "architecture", affected_files: [{ path: "a.ts" }] })],
      "p",
    );
    const entry = req.tiers[0].items[0];
    expect(entry.necessity).toBe("strategic");
    expect(entry.rationale.length).toBeGreaterThan(0);
    expect(entry.implementation_cost).toBe("low");
    expect(entry.affected_files).toEqual(["a.ts"]);
  });
});

describe("applyReviewResolution", () => {
  const req = buildReviewRequest(SAMPLE, "plan-1");

  it("approves everything when the resolution is absent/empty (gate REMOVES, not opts-in)", () => {
    const all = applyReviewResolution(req, null);
    expect(all.approved_ids.sort()).toEqual(["ARC-1", "ARC-2", "COR-1", "MNT-1"]);
    expect(all.declined).toEqual([]);

    const empty = applyReviewResolution(req, {});
    expect(empty.approved_ids).toHaveLength(4);
  });

  it("declines specific findings with a recorded reason (never a silent close)", () => {
    const dec = applyReviewResolution(req, { disapproved_findings: ["ARC-1", "MNT-1"] });
    expect(dec.approved_ids.sort()).toEqual(["ARC-2", "COR-1"]);
    expect(dec.declined.map((d) => d.finding_id).sort()).toEqual(["ARC-1", "MNT-1"]);
    for (const d of dec.declined) {
      expect(d.reason).toMatch(/review gate/i);
    }
  });

  it("can decline an entire tier", () => {
    const dec = applyReviewResolution(req, { disapproved_tiers: ["strategic"] });
    expect(dec.declined.map((d) => d.finding_id).sort()).toEqual(["ARC-1", "ARC-2"]);
    expect(dec.approved_ids.sort()).toEqual(["COR-1", "MNT-1"]);
    expect(dec.declined[0].reason).toMatch(/entire "strategic" tier/);
  });

  it("tier-decline and per-finding-decline combine without double-counting", () => {
    const dec = applyReviewResolution(req, {
      disapproved_tiers: ["mechanical"],
      disapproved_findings: ["COR-1"],
    });
    expect(dec.declined.map((d) => d.finding_id).sort()).toEqual(["COR-1", "MNT-1"]);
    expect(dec.approved_ids.sort()).toEqual(["ARC-1", "ARC-2"]);
    // every item is accounted for exactly once
    expect(dec.approved_ids.length + dec.declined.length).toBe(req.total);
  });
});
