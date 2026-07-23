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

  // ESCALATED PRODUCTION DEFECT (dedupe finding-loss) — expected-fail until the
  // owning node fixes src/shared/findings/dedupe.ts. With N>=3 duplicates in
  // clone mode, the second merge re-clones: `cloneOf` is keyed by the ORIGINAL
  // survivor, but after the first merge the group slot holds the CLONE, so
  // `cloneOf.get(clone)` misses, a second clone is minted from the first, and the
  // result map (`cloneOf.get(original)`) still returns the STALE first clone —
  // the third duplicate's evidence (ev-C here) is silently dropped. `it.fails`
  // flips loudly (fails as "expected to fail but passed") the moment the fix
  // lands; remove the marker then.
  it.fails("REPEATED SURVIVOR (clone mode, N>=3): successive merges accumulate on ONE clone; originals never mutated", () => {
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
