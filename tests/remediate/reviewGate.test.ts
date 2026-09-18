import { describe, it, expect } from "vitest";
import type { Finding } from "audit-tools/shared";
import {
  buildReviewRequest,
  applyReviewResolution,
  parseReviewResolution,
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
    const all = applyReviewResolution(req, undefined);
    expect(all.approved_ids.sort()).toEqual(["ARC-1", "ARC-2", "COR-1", "MNT-1"]);
    expect(all.declined).toEqual([]);

    const empty = applyReviewResolution(req, {});
    expect(empty.approved_ids).toHaveLength(4);
  });

  it("declines specific findings with a recorded reason (never a silent close)", () => {
    const dec = applyReviewResolution(req, {
      declined_findings: [{ finding_id: "ARC-1" }, { finding_id: "MNT-1" }],
    });
    expect(dec.approved_ids.sort()).toEqual(["ARC-2", "COR-1"]);
    expect(dec.declined.map((d) => d.finding_id).sort()).toEqual(["ARC-1", "MNT-1"]);
    for (const d of dec.declined) {
      expect(d.reason).toMatch(/review gate/i);
    }
  });

  // Prompt 17b: the report records the USER'S reason when they gave one. The
  // old file had no place for it, so every decline got the same generic line.
  it("records the user's own reason; a blank reason falls back to the generic one", () => {
    const dec = applyReviewResolution(req, {
      declined_findings: [
        { finding_id: "ARC-1", reason: "we replace this module next quarter" },
        { finding_id: "COR-1", reason: "   " },
      ],
    });
    const byId = new Map(dec.declined.map((d) => [d.finding_id, d.reason]));
    expect(byId.get("ARC-1")).toBe(
      "Declined by the user at the review gate: we replace this module next quarter",
    );
    expect(byId.get("COR-1")).toBe(
      "Declined by the user at the review gate (review-necessity: concrete).",
    );
  });

  it("can decline an entire tier", () => {
    const dec = applyReviewResolution(req, { declined_tiers: ["strategic"] });
    expect(dec.declined.map((d) => d.finding_id).sort()).toEqual(["ARC-1", "ARC-2"]);
    expect(dec.approved_ids.sort()).toEqual(["COR-1", "MNT-1"]);
    expect(dec.declined[0].reason).toMatch(/entire "strategic" tier/);
  });

  it("tier-decline and per-finding-decline combine without double-counting", () => {
    const dec = applyReviewResolution(req, {
      declined_tiers: ["mechanical"],
      declined_findings: [{ finding_id: "COR-1" }],
    });
    expect(dec.declined.map((d) => d.finding_id).sort()).toEqual(["COR-1", "MNT-1"]);
    expect(dec.approved_ids.sort()).toEqual(["ARC-1", "ARC-2"]);
    // every item is accounted for exactly once
    expect(dec.approved_ids.length + dec.declined.length).toBe(req.total);
  });

  // The backstop: an unknown id still throws here even though the parser
  // refuses it first — applying a typo'd decline would approve the finding.
  it("throws on a declined id that is not in the request (backstop)", () => {
    expect(() =>
      applyReviewResolution(req, { declined_findings: [{ finding_id: "TYPO-9" }] }),
    ).toThrow(/TYPO-9/);
  });
});

// Prompt 17b (owner, 2026-09-18): the tool read review_resolution.json with no
// shape check, and the gate's default is APPROVE — so a mistyped field, a bare
// array, or the right field with a wrong type approved the finding the user
// declined, in silence (or crashed next-step). The parser refuses the WHOLE
// file, and the refusal names each problem.
describe("parseReviewResolution", () => {
  const req = buildReviewRequest(SAMPLE, "plan-1");
  const refusalOf = (text: string): string => {
    const parsed = parseReviewResolution(text, req);
    if (parsed.kind !== "refused") throw new Error(`expected a refusal, got ${parsed.kind}`);
    return parsed.reason;
  };

  it("accepts the documented shape, with and without the optional fields", () => {
    expect(parseReviewResolution('{"declined_findings":[],"declined_tiers":[]}', req)).toEqual({
      kind: "ok",
      resolution: { declined_findings: [], declined_tiers: [] },
    });
    const parsed = parseReviewResolution(
      '{"plan_id":"plan-1","declined_findings":[{"finding_id":"ARC-1","reason":"r"}]}',
      req,
    );
    expect(parsed.kind).toBe("ok");
  });

  it("refuses invalid JSON instead of crashing", () => {
    expect(refusalOf("{ not json")).toMatch(/not valid JSON/);
  });

  it("refuses a bare array instead of approving everything", () => {
    expect(refusalOf('["ARC-1"]')).toMatch(/one JSON object/);
  });

  it("refuses the retired disapproved_* names and states the new ones", () => {
    const reason = refusalOf('{"disapproved_findings":["ARC-1"],"disapproved_tiers":[]}');
    expect(reason).toContain("`disapproved_findings` is not a field — write `declined_findings`");
    expect(reason).toContain("`disapproved_tiers` is not a field — write `declined_tiers`");
  });

  it("refuses an unknown field, top-level or inside an entry", () => {
    expect(refusalOf('{"disapproved":["ARC-1"]}')).toContain("unknown field(s): `disapproved`");
    expect(refusalOf('{"declined_findings":[{"finding_id":"ARC-1","why":"x"}]}')).toContain(
      "unknown field(s) in `declined_findings.0`: `why`",
    );
  });

  it("refuses a wrong type instead of crashing", () => {
    expect(refusalOf('{"declined_findings":"ARC-1"}')).toContain("`declined_findings`:");
    expect(refusalOf('{"declined_findings":["ARC-1"]}')).toContain("`declined_findings.0`:");
  });

  it("refuses an unknown id or tier, naming the entry and the valid set", () => {
    const reason = refusalOf(
      '{"declined_findings":[{"finding_id":"ARC-1"},{"finding_id":"TYPO-9"}],"declined_tiers":["optional"]}',
    );
    expect(reason).toContain("`declined_findings[1].finding_id`: `TYPO-9` is not in the request");
    expect(reason).toContain("valid: `ARC-1`, `ARC-2`, `COR-1`, `MNT-1`");
    expect(reason).toContain("`declined_tiers[0]`: `optional` is not a tier");
  });

  it("names every problem in one refusal", () => {
    const reason = refusalOf('{"disapproved_tiers":[],"declined_tiers":"strategic","extra":1}');
    expect(reason).toContain("`disapproved_tiers` is not a field");
    expect(reason).toContain("`declined_tiers`:");
    expect(reason).toContain("`extra`");
  });

  it("reads a plan_id from another run as stale, not refused", () => {
    expect(parseReviewResolution('{"plan_id":"plan-0","declined_findings":[]}', req)).toEqual({
      kind: "stale",
    });
  });
});
