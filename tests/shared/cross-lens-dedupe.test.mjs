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
