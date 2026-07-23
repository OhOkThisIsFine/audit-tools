import { describe, it, expect } from "vitest";
import { crossLensDedupe } from "audit-tools/shared";

function makeFinding(overrides) {
  return {
    title: "Example finding",
    category: "general",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "Example summary.",
    affected_files: [{ path: "src/foo.ts" }],
    evidence: ["ev-1"],
    ...overrides,
  };
}

// The two orchestrators' DRAWS of the one shared core.
const AUDIT_POLICY = {
  categoryGate: "soft",
  exactIdentityShortCircuit: false,
  survivorMutation: "mutate",
  mergeGrounding: true,
  sortAffectedFiles: true,
  breakOnAbsorbedSurvivor: false,
};
const REMEDIATE_POLICY = {
  categoryGate: "hard",
  exactIdentityShortCircuit: true,
  survivorMutation: "clone",
  mergeGrounding: false,
  sortAffectedFiles: false,
  breakOnAbsorbedSurvivor: true,
};

describe("crossLensDedupe — one core, per-mode policy", () => {
  it("soft category gate merges cross-category; hard gate blocks it", () => {
    const findings = () => [
      makeFinding({ id: "A", title: "Race on shared counter", lens: "correctness", category: "concurrency" }),
      makeFinding({ id: "B", title: "Race on shared counter", lens: "reliability", category: "data-integrity" }),
    ];
    // Same title (sim 1.0 >= 0.5 cross-category threshold), same file → soft merges.
    expect(crossLensDedupe(findings(), AUDIT_POLICY).findings).toHaveLength(1);
    // Hard gate never collapses two different-category fixes.
    expect(crossLensDedupe(findings(), REMEDIATE_POLICY).findings).toHaveLength(2);
  });

  it("mutate returns the survivor original; clone leaves the caller's objects untouched", () => {
    const mk = () => [
      makeFinding({ id: "A", title: "Duplicated auth check", lens: "security", category: "auth", severity: "high" }),
      makeFinding({ id: "B", title: "Duplicated auth check", lens: "correctness", category: "auth", severity: "low", evidence: ["ev-2"] }),
    ];

    const auditIn = mk();
    const auditOut = crossLensDedupe(auditIn, AUDIT_POLICY);
    expect(auditOut.findings).toHaveLength(1);
    // Survivor is the SAME object (higher-severity A), mutated in place.
    expect(auditOut.findings[0]).toBe(auditIn[0]);
    expect(auditIn[0].evidence).toContain("ev-2");

    const remIn = mk();
    const remOut = crossLensDedupe(remIn, REMEDIATE_POLICY);
    expect(remOut.findings).toHaveLength(1);
    // Survivor is a CLONE — the caller's original A is never mutated.
    expect(remOut.findings[0]).not.toBe(remIn[0]);
    expect(remIn[0].evidence).toEqual(["ev-1"]);
    expect(remOut.mergeMap.get("B")).toBe("A");
  });

  it("fires onMerge for each merge (the remediate audit log hook)", () => {
    const merges = [];
    crossLensDedupe(
      [
        makeFinding({ id: "A", title: "Same defect here", lens: "security", category: "auth" }),
        makeFinding({ id: "B", title: "Same defect here", lens: "tests", category: "auth" }),
      ],
      { ...REMEDIATE_POLICY, onMerge: ({ absorbed, survivor }) => merges.push([absorbed.id, survivor.id]) },
    );
    expect(merges).toEqual([["B", "A"]]);
  });

  it("normalizes lens/category consistently (trim+lowercase) — a whitespace-only category difference is the SAME category", () => {
    // Deliberate one-core convergence: a trailing-space category typo must NOT
    // bypass the hard gate — the two are the same category and merge.
    const out = crossLensDedupe(
      [
        makeFinding({ id: "A", title: "Same defect", lens: "security", category: "auth" }),
        makeFinding({ id: "B", title: "Same defect", lens: "tests", category: "auth " }),
      ],
      REMEDIATE_POLICY,
    );
    expect(out.findings).toHaveLength(1);
  });

  // COR-5c71a9ff (clone-mode canonical accumulation): with N>=3 duplicates in
  // clone mode there must be exactly ONE canonical clone per original survivor —
  // every subsequent merge mutates that same clone, so nothing absorbed after the
  // first merge is silently dropped from the returned survivor.
  it("REPEATED SURVIVOR (clone mode, N>=3): successive merges accumulate on ONE clone; originals never mutated", () => {
    // TST-286008a5: with 3+ duplicates the survivor is absorbed into REPEATEDLY.
    // In clone mode the second merge must land on the SAME clone as the first —
    // a re-clone from the original would silently drop B's already-absorbed
    // evidence (finding-loss).
    const mk = () => [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "high", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "low", evidence: ["ev-C"] }),
    ];
    const input = mk();
    const out = crossLensDedupe(input, REMEDIATE_POLICY);

    expect(out.findings).toHaveLength(1);
    const survivor = out.findings[0];
    expect(survivor.id).toBe("A");
    // BOTH absorbed findings' evidence accumulated on the one clone.
    expect(survivor.evidence).toContain("ev-A");
    expect(survivor.evidence, "first merge's evidence must survive the second merge").toContain("ev-B");
    expect(survivor.evidence).toContain("ev-C");
    // Every merge is recorded against the same survivor id.
    expect(out.mergeMap.get("B")).toBe("A");
    expect(out.mergeMap.get("C")).toBe("A");
    // Clone mode: the caller's ORIGINALS are untouched after repeated merges.
    expect(survivor).not.toBe(input[0]);
    expect(input[0].evidence).toEqual(["ev-A"]);
    expect(input[1].evidence).toEqual(["ev-B"]);
    expect(input[2].evidence).toEqual(["ev-C"]);
  });

  it("REPEATED SURVIVOR (mutate mode, N>=3): the one original survivor absorbs every duplicate", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "high", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "low", evidence: ["ev-C"] }),
    ];
    const out = crossLensDedupe(input, AUDIT_POLICY);
    expect(out.findings).toHaveLength(1);
    // Mutate mode: the survivor IS the caller's original object.
    expect(out.findings[0]).toBe(input[0]);
    expect(input[0].evidence).toEqual(expect.arrayContaining(["ev-A", "ev-B", "ev-C"]));
  });

  // COR-5c71a9ff-2 (conservation — no resurrection, no duplicate survivor
  // emission): when a finding that already absorbed others is ITSELF absorbed by
  // a stronger finding, it must vanish from the output — its accumulated data
  // lands on the final survivor and every mergeMap chain collapses to an id that
  // is present in the returned array.
  it("ABSORBED SURVIVOR (clone mode): a survivor later absorbed is never re-emitted; mergeMap chains collapse to the final survivor", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "medium", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "critical", evidence: ["ev-C"] }),
    ];
    // Pair (A,B): A survives, absorbs B. Pair (A,C): C outranks A — the A-clone
    // (carrying ev-A + ev-B) is absorbed into C's clone.
    const out = crossLensDedupe(input, REMEDIATE_POLICY);

    expect(out.findings, "the absorbed A-clone must not be resurrected next to C").toHaveLength(1);
    const survivor = out.findings[0];
    expect(survivor.id).toBe("C");
    expect(survivor.evidence).toEqual(expect.arrayContaining(["ev-A", "ev-B", "ev-C"]));
    // Chain B→A→C collapses: every mergeMap value is an id present in the output.
    expect(out.mergeMap.get("A")).toBe("C");
    expect(out.mergeMap.get("B"), "the merge chain must collapse to the FINAL survivor").toBe("C");
    const emittedIds = new Set(out.findings.map((f) => f.id));
    for (const target of out.mergeMap.values()) {
      expect(emittedIds.has(target), `mergeMap target ${target} must be an emitted finding`).toBe(true);
    }
    // Conservation: every input id is emitted exactly once XOR absorbed.
    for (const f of input) {
      expect(emittedIds.has(f.id) !== out.mergeMap.has(f.id)).toBe(true);
    }
    // Clone mode: caller originals untouched.
    expect(input[2].evidence).toEqual(["ev-C"]);
  });

  // COR-5c71a9ff-2 (mutate mode / audit draw): once absorbed, a finding never
  // acts as a survivor in later pairwise comparisons — later duplicates merge
  // into the LIVE survivor, so their data is not stranded on a dropped finding.
  it("ABSORBED SURVIVOR (mutate mode): an absorbed i-slot finding never absorbs later candidates", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "security", category: "net", severity: "high", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "tests", category: "net", severity: "low", evidence: ["ev-C"] }),
    ];
    // Pair (A,B): B outranks A → A absorbed. A must then be EXCLUDED: C merges
    // with B (the live survivor), not with the removed A.
    const out = crossLensDedupe(input, AUDIT_POLICY);

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toBe(input[1]);
    expect(input[1].evidence, "C's evidence must land on the live survivor, not the removed A").toEqual(
      expect.arrayContaining(["ev-A", "ev-B", "ev-C"]),
    );
    expect(out.mergeMap.get("A")).toBe("B");
    expect(out.mergeMap.get("C"), "C must be recorded against the live survivor").toBe("B");
  });

  it("IDEMPOTENCE (clone mode): re-running on its own output is a fixpoint", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "medium", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "critical", evidence: ["ev-C"] }),
    ];
    const first = crossLensDedupe(input, REMEDIATE_POLICY);
    const second = crossLensDedupe(first.findings, REMEDIATE_POLICY);
    expect(second.mergeMap.size, "a second run must find nothing left to merge").toBe(0);
    expect(second.findings).toEqual(first.findings);
  });

  it("never merges same-lens pairs (that is the same-lens pass' job)", () => {
    const out = crossLensDedupe(
      [
        makeFinding({ id: "A", title: "Identical", lens: "correctness", category: "x" }),
        makeFinding({ id: "B", title: "Identical", lens: "correctness", category: "x" }),
      ],
      AUDIT_POLICY,
    );
    expect(out.findings).toHaveLength(2);
  });
});
