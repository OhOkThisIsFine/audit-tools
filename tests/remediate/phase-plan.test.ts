import { describe, it, expect } from "vitest";
import { buildCoverageLedger } from "../../src/remediate/phases/plan.js";
import type { Finding } from "../../src/remediate/state/types.js";
import { canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";

function mkFinding(id: string, title: string, opts: { files?: string[] } = {}): Finding {
 return { id, title, category: "correctness", severity: "low", confidence: "high", lens: "correctness", summary: title,
 affected_files: (opts.files ?? []).map(path => ({path})), evidence: ["Source evidence"] };
}

describe("buildCoverageLedger", () => {
  it("classifies planned, folded, and dropped findings", () => {
    const sourceFindings = [
      mkFinding("A", "Kept", { files: ["a.ts"] }),
      mkFinding("B", "Folded", { files: ["a.ts"] }),
      mkFinding("C", "NoEvidence", { files: ["c.ts"] }),
    ];
    const ledger = buildCoverageLedger({
      planId: "PLAN-X",
      sourceFindings: sourceFindings as any,
      droppedNoEvidence: ["C"],
      droppedByCheckpoint: [],
      mergeMap: new Map([["B", "A"]]),
      units: [canonicalUnitFixture("B-001", { source_finding_ids: ["A"] })],
    });
    expect(ledger.source_finding_count).toBe(3);
    expect(ledger.planned_count).toBe(1);
    expect(ledger.folded_count).toBe(1);
    expect(ledger.dropped_count).toBe(1);
    const byId = Object.fromEntries(
      ledger.entries.map((e) => [e.finding_id, e]),
    );
    expect(byId.A.disposition).toBe("planned");
    expect(byId.A.unit_ids).toEqual(["B-001"]);
    expect(byId.B.disposition).toBe("folded_into");
    expect(byId.B.folded_into).toBe("A");
    expect(byId.C.disposition).toBe("dropped_no_evidence");
    expect(byId.C.rationale).toBeTruthy();
  });

  it("records review-gate declines as in-source declined_by_review entries (part of reconciliation)", () => {
    // On Path A the coverage source IS the original findings; a declined finding
    // is a filter-pass survivor the user disapproved, so it is an in-source
    // disposition (like dropped_by_checkpoint) and counts toward the source total.
    const sourceFindings = [
      mkFinding("NODE-1", "Planned", { files: ["a.ts"] }),
      mkFinding("ARC-001", "Declined one", { files: ["b.ts"] }),
      mkFinding("ARC-002", "Declined two", { files: ["c.ts"] }),
    ];
    const ledger = buildCoverageLedger({
      planId: "PLAN-DECL",
      sourceFindings: sourceFindings as any,
      droppedNoEvidence: [],
      droppedByCheckpoint: [],
      declinedByReview: [
        { finding_id: "ARC-001", reason: "Disapproved by the user at the review gate." },
        { finding_id: "ARC-002", reason: "Disapproved by the user at the review gate." },
      ],
      mergeMap: new Map(),
      units: [canonicalUnitFixture("B-001", { source_finding_ids: ["NODE-1"] })],
    });

    expect(ledger.source_finding_count).toBe(3);
    expect(ledger.planned_count).toBe(1);
    expect(ledger.declined_review_count).toBe(2);
    // Every original finding gets exactly one disposition — declines included.
    const total =
      ledger.planned_count +
      ledger.folded_count +
      ledger.dropped_count +
      ledger.checkpoint_dropped_count +
      ledger.phantom_dropped_count +
      (ledger.declined_review_count ?? 0);
    expect(total).toBe(ledger.source_finding_count);
    const byId = Object.fromEntries(ledger.entries.map((e) => [e.finding_id, e]));
    expect(byId["ARC-001"].disposition).toBe("declined_by_review");
    expect(byId["ARC-001"].rationale).toMatch(/review gate/i);
    expect(byId["ARC-002"].disposition).toBe("declined_by_review");
    expect(ledger.entries).toHaveLength(3);
  });
});


describe("coverage source identities", () => {
  it("coverage preserves immutable originals and many-to-many execution links", () => {
    const findings = [mkFinding("A", "First source"), mkFinding("B", "Second source")];
    const before = JSON.stringify(findings);
    const units = [canonicalUnitFixture("U-one", { source_finding_ids: ["A", "B"] }), canonicalUnitFixture("U-two", { source_finding_ids: ["A"] })];
    const ledger = buildCoverageLedger({ planId: "PLAN-links", sourceFindings: findings, units, droppedNoEvidence: [], droppedByCheckpoint: [], mergeMap: new Map() });
    expect(ledger.entries.find(entry => entry.finding_id === "A")!.unit_ids).toEqual(["U-one", "U-two"]);
    expect(ledger.entries.find(entry => entry.finding_id === "B")!.unit_ids).toEqual(["U-one"]);
    expect(ledger.entries.map(entry => entry.finding)).toEqual(findings);
    expect(JSON.stringify(findings)).toBe(before);
  });

  it("conversation-only execution invents no finding or coverage entry", () => {
    const ledger = buildCoverageLedger({ planId: "PLAN-request", sourceFindings: [], units: [canonicalUnitFixture("U-request")], droppedNoEvidence: [], droppedByCheckpoint: [], mergeMap: new Map() });
    expect(ledger.source_finding_count).toBe(0);
    expect(ledger.entries).toEqual([]);
  });
});
