import { describe, it, expect } from "vitest";
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
  wordJaccard,
} from "../../src/remediate/dedup/crossLensDedup.js";

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

describe("wordJaccard", () => {
  it("returns 1 for identical strings", () => {
    expect(wordJaccard("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(wordJaccard("hello world", "foo bar")).toBe(0);
  });

  it("handles partial overlap", () => {
    const score = wordJaccard("compiled dist output", "compiled dist artifacts");
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 for empty strings", () => {
    expect(wordJaccard("", "")).toBe(0);
  });
});

describe("deduplicateCrossLensFindings", () => {
  it("merges findings with same title and file from different lenses", () => {
    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({ id: "TST-001", title: "Suite executes compiled dist", lens: "tests" }),
      makeFinding({ id: "COR-001", title: "Suite executes compiled dist", lens: "correctness" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(mergeMap.size).toBe(1);
  });

  it("merges findings with similar titles (Jaccard > 0.5) from different lenses", () => {
    const { findings } = deduplicateCrossLensFindings([
      makeFinding({
        id: "TST-001",
        title: "Missing test coverage for compiled dist",
        lens: "tests",
        severity: "medium",
      }),
      makeFinding({
        id: "COR-001",
        title: "Test coverage gaps for compiled dist output",
        lens: "correctness",
        severity: "high",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  it("keeps findings with different titles from different lenses", () => {
    const { findings } = deduplicateCrossLensFindings([
      makeFinding({ id: "SEC-001", title: "SQL injection in login handler", lens: "security" }),
      makeFinding({ id: "TST-001", title: "Test coverage below threshold", lens: "tests" }),
    ]);
    expect(findings).toHaveLength(2);
  });

  it("does not merge same-lens findings", () => {
    const { findings } = deduplicateCrossLensFindings([
      makeFinding({ id: "SEC-001", title: "Missing validation", lens: "security" }),
      makeFinding({ id: "SEC-002", title: "Missing validation", lens: "security" }),
    ]);
    expect(findings).toHaveLength(2);
  });

  it("does not merge findings with different files", () => {
    const { findings } = deduplicateCrossLensFindings([
      makeFinding({
        id: "A-001",
        title: "Missing validation",
        lens: "security",
        affected_files: [{ path: "src/a.ts" }],
      }),
      makeFinding({
        id: "B-001",
        title: "Missing validation",
        lens: "correctness",
        affected_files: [{ path: "src/b.ts" }],
      }),
    ]);
    expect(findings).toHaveLength(2);
  });

  // OBL-C003-DEDUP / OBL-INV-RPS-07: category is a hard merge-key discriminator.
  it("does NOT merge cross-lens findings that share a file but differ in category", () => {
    // Same primary file + similar title + DIFFERENT category → must stay distinct.
    // Mirrors ARC-86b18f1b (inferred_contract_gap) vs the cross-lens variant: a
    // different category means a structurally different defect, never collapsed.
    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({
        id: "ARC-86b18f1b",
        title: "Module boundary contract gap",
        lens: "architecture",
        category: "inferred_contract_gap",
        affected_files: [{ path: "src/mod.ts" }],
      }),
      makeFinding({
        id: "COR-86b18f1b",
        title: "Module boundary contract gap",
        lens: "correctness",
        category: "invariant_counterexample",
        affected_files: [{ path: "src/mod.ts" }],
      }),
    ]);
    expect(findings).toHaveLength(2);
    expect(mergeMap.size).toBe(0);
  });

  it("does NOT merge same-lens findings that share a file but differ in category", () => {
    // ARC-86b18f1b (inferred_contract_gap) vs ARC-86b18f1b-2
    // (invariant_counterexample): same lens, same file, different category —
    // the literal OBL-C003-DEDUP example. Must remain two distinct findings.
    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({
        id: "ARC-86b18f1b",
        title: "Boundary invariant",
        lens: "architecture",
        category: "inferred_contract_gap",
        affected_files: [{ path: "src/mod.ts" }],
      }),
      makeFinding({
        id: "ARC-86b18f1b-2",
        title: "Boundary invariant",
        lens: "architecture",
        category: "invariant_counterexample",
        affected_files: [{ path: "src/mod.ts" }],
      }),
    ]);
    expect(findings).toHaveLength(2);
    expect(mergeMap.size).toBe(0);
  });

  it("merges a cross-lens true duplicate that shares lens-file AND category", () => {
    // ARC-1fa005bb-2 IS a true duplicate of ARC-1fa005bb: same category, same
    // file, surfaced through two lenses → collapses to one survivor.
    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({
        id: "ARC-1fa005bb",
        title: "Stale dist artifact",
        lens: "architecture",
        category: "duplicate_surface",
        affected_files: [{ path: "src/dup.ts" }],
        severity: "high",
      }),
      makeFinding({
        id: "TST-1fa005bb-2",
        title: "Stale dist artifact",
        lens: "tests",
        category: "duplicate_surface",
        affected_files: [{ path: "src/dup.ts" }],
        severity: "low",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("ARC-1fa005bb");
    expect(mergeMap.get("TST-1fa005bb-2")).toBe("ARC-1fa005bb");
  });

  // drift-plan R2 — exact-match layer: the shared finding-identity signature is
  // the authority; the Jaccard/overlap heuristic is a fuzzy layer on top of it.
  it("collapses a cross-lens pair that shares a discriminating identity even when titles slip under the Jaccard floor", () => {
    // Same structural anchor (path + symbol) → identical shared identity
    // signature, lens-independent. The titles are deliberately dissimilar
    // (Jaccard < 0.4) so the OLD heuristic alone would NOT have merged them; the
    // exact-match layer collapses them because they ARE the same defect.
    const titleSim = wordJaccard(
      "Token refresh never validates the expiry",
      "Session keeps working after logout",
    );
    expect(titleSim).toBeLessThan(0.4); // guards the premise of this test

    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({
        id: "SEC-aa",
        title: "Token refresh never validates the expiry",
        lens: "security",
        category: "AuthZ",
        affected_files: [{ path: "src/auth/session.ts", symbol: "refreshToken" }],
        severity: "high",
      }),
      makeFinding({
        id: "COR-bb",
        title: "Session keeps working after logout",
        lens: "correctness",
        category: "AuthZ",
        affected_files: [{ path: "src/auth/session.ts", symbol: "refreshToken" }],
        severity: "low",
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("SEC-aa");
    expect(mergeMap.get("COR-bb")).toBe("SEC-aa");
  });

  it("does NOT collapse cross-lens findings that merely share a file (empty-scope anchor) with dissimilar titles", () => {
    // No symbol → the identity signature degenerates to `anchor|<path>|`, which
    // is non-discriminating ("same file" only). The exact-match layer must NOT
    // fire; the fuzzy title/overlap layer governs, and dissimilar titles keep
    // them distinct. (Guards against over-collapsing on the weak signature.)
    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({
        id: "SEC-cc",
        title: "SQL injection in the login handler",
        lens: "security",
        category: "General",
        affected_files: [{ path: "src/foo.ts" }],
      }),
      makeFinding({
        id: "TST-dd",
        title: "Coverage below threshold for the module",
        lens: "tests",
        category: "General",
        affected_files: [{ path: "src/foo.ts" }],
      }),
    ]);
    expect(findings).toHaveLength(2);
    expect(mergeMap.size).toBe(0);
  });

  it("merges evidence from absorbed finding", () => {
    const { findings } = deduplicateCrossLensFindings([
      makeFinding({ id: "A-001", title: "Missing validation", lens: "security", evidence: ["ev-sec"] }),
      makeFinding({ id: "B-001", title: "Missing validation", lens: "correctness", evidence: ["ev-cor"] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain("ev-sec");
    expect(findings[0].evidence).toContain("ev-cor");
  });

  it("keeps higher severity finding as survivor", () => {
    const { findings, mergeMap } = deduplicateCrossLensFindings([
      makeFinding({ id: "A-001", title: "Missing validation", lens: "security", severity: "low" }),
      makeFinding({ id: "B-001", title: "Missing validation", lens: "correctness", severity: "high" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("B-001");
    expect(mergeMap.get("A-001")).toBe("B-001");
  });

  it("returns empty mergeMap when no duplicates", () => {
    const { mergeMap } = deduplicateCrossLensFindings([
      makeFinding({ id: "A-001", title: "Finding A", lens: "security" }),
      makeFinding({ id: "B-001", title: "Finding B", lens: "correctness" }),
    ]);
    expect(mergeMap.size).toBe(0);
  });

  it("fully-tied duplicates (equal severity AND equal confidence) always keep the first-seen finding", () => {
    // When both severity and confidence are identical, keepA = (aSev > bSev || (aSev === bSev && aConf >= bConf))
    // evaluates to true because aConf >= bConf holds when they are equal. The inner loop iterates
    // j > i, so A is always the first finding encountered — i.e., selection is stable by input order.
    const a = () =>
      makeFinding({
        id: "A-001",
        title: "Missing validation",
        lens: "security",
        severity: "medium",
        confidence: "medium",
        affected_files: [{ path: "src/foo.ts" }],
      });
    const b = () =>
      makeFinding({
        id: "B-001",
        title: "Missing validation",
        lens: "correctness",
        severity: "medium",
        confidence: "medium",
        affected_files: [{ path: "src/foo.ts" }],
      });

    const forward = deduplicateCrossLensFindings([a(), b()]);
    const reverse = deduplicateCrossLensFindings([b(), a()]);

    // Both passes collapse to a single surviving finding.
    expect(forward.findings).toHaveLength(1);
    expect(reverse.findings).toHaveLength(1);

    // Forward pass: A was at index 0, so A is kept and B is absorbed.
    expect(forward.findings[0].id).toBe("A-001");
    expect(forward.mergeMap.get("B-001")).toBe("A-001");

    // Reverse pass: B was at index 0, so B is kept and A is absorbed.
    expect(reverse.findings[0].id).toBe("B-001");
    expect(reverse.mergeMap.get("A-001")).toBe("B-001");
  });

  it("equal-severity duplicates pick a deterministic survivor regardless of input order", () => {
    // Same title+file, EQUAL severity — the existing tests only cover the
    // higher-severity survivor. With severity tied, confidence breaks the tie
    // (keepA uses aConf >= bConf), so the higher-confidence finding survives no
    // matter which order it appears in.
    const a = () =>
      makeFinding({
        id: "A-001",
        title: "Missing validation",
        lens: "security",
        severity: "medium",
        confidence: "high",
      });
    const b = () =>
      makeFinding({
        id: "B-001",
        title: "Missing validation",
        lens: "correctness",
        severity: "medium",
        confidence: "medium",
      });

    const forward = deduplicateCrossLensFindings([a(), b()]);
    const reverse = deduplicateCrossLensFindings([b(), a()]);

    expect(forward.findings).toHaveLength(1);
    expect(reverse.findings).toHaveLength(1);
    // Same survivor id in both orderings — selection is stable.
    expect(forward.findings[0].id).toBe("A-001");
    expect(reverse.findings[0].id).toBe("A-001");
    // mergeMap maps the absorbed finding to the survivor in both orderings.
    expect(forward.mergeMap.get("B-001")).toBe("A-001");
    expect(reverse.mergeMap.get("B-001")).toBe("A-001");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-05: dedup must not mutate source findings in place
// ---------------------------------------------------------------------------

describe("deduplicateCrossLensFindings — INV-remediate-state-05: source findings are not mutated", () => {
  it("survivor finding's affected_files is a new array (not the same reference)", () => {
    const original = makeFinding({
      id: "A-001",
      title: "Missing validation check",
      lens: "security",
      severity: "high",
    });
    const originalFilesRef = original.affected_files;

    deduplicateCrossLensFindings([
      original,
      makeFinding({
        id: "B-001",
        title: "Missing validation check",
        lens: "correctness",
        severity: "low",
        affected_files: [{ path: "src/foo.ts" }, { path: "src/bar.ts" }],
      }),
    ]);

    // Original finding's affected_files must not have been mutated
    expect(original.affected_files).toBe(originalFilesRef);
    expect(original.affected_files).toHaveLength(1);
    expect(original.affected_files[0].path).toBe("src/foo.ts");
  });

  it("absorbed finding's evidence is unchanged after dedup", () => {
    const absorbed = makeFinding({
      id: "B-001",
      title: "Missing validation check",
      lens: "correctness",
      severity: "low",
      evidence: ["evidence-B"],
    });
    const originalEvidence = absorbed.evidence!.slice();

    deduplicateCrossLensFindings([
      makeFinding({
        id: "A-001",
        title: "Missing validation check",
        lens: "security",
        severity: "high",
        evidence: ["evidence-A"],
      }),
      absorbed,
    ]);

    // Absorbed finding's evidence must be unchanged
    expect(absorbed.evidence).toEqual(originalEvidence);
  });

  it("survivor finding's summary is unchanged in the source array when absorbed has longer summary", () => {
    const survivor = makeFinding({
      id: "A-001",
      title: "Missing validation check",
      lens: "security",
      severity: "high",
      summary: "Short.",
    });
    const originalSummary = survivor.summary;

    deduplicateCrossLensFindings([
      survivor,
      makeFinding({
        id: "B-001",
        title: "Missing validation check",
        lens: "correctness",
        severity: "low",
        summary: "A much longer summary that exceeds the original in length.",
      }),
    ]);

    // The original source finding must not have its summary mutated
    expect(survivor.summary).toBe(originalSummary);
  });

  it("returned survivor has merged affected_files while source is clean", () => {
    const a = makeFinding({
      id: "A-001",
      title: "Missing validation check",
      lens: "security",
      severity: "high",
      affected_files: [{ path: "src/foo.ts" }],
    });
    const b = makeFinding({
      id: "B-001",
      title: "Missing validation check",
      lens: "correctness",
      severity: "low",
      affected_files: [{ path: "src/foo.ts" }, { path: "src/bar.ts" }],
    });

    const { findings } = deduplicateCrossLensFindings([a, b]);

    // Returned survivor is merged
    expect(findings).toHaveLength(1);
    expect(findings[0].affected_files.some((f) => f.path === "src/bar.ts")).toBe(true);
    // Source finding is clean
    expect(a.affected_files).toHaveLength(1);
  });
});

describe("fixupBlocksAfterDedup", () => {
  it("replaces merged finding IDs in block items", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "B-001", items: ["A-001", "B-001"], parallel_safe: true },
    ];
    const mergeMap = new Map([["A-001", "B-001"]]);
    const result = fixupBlocksAfterDedup(blocks, mergeMap);
    expect(result[0].items).toEqual(["B-001"]);
  });

  it("deduplicates block items after replacement", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "B-001", items: ["TST-001", "COR-001", "SEC-001"], parallel_safe: true },
    ];
    const mergeMap = new Map([["TST-001", "COR-001"]]);
    const result = fixupBlocksAfterDedup(blocks, mergeMap);
    expect(result[0].items).toEqual(["COR-001", "SEC-001"]);
  });

  it("returns blocks unchanged when mergeMap is empty", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "B-001", items: ["A-001", "B-001"], parallel_safe: true },
    ];
    const result = fixupBlocksAfterDedup(blocks, new Map());
    expect(result).toBe(blocks);
  });

  // OBL-C003-DEDUP / OBL-INV-RPS-07: an absorbed finding must never be silently
  // dropped — when its survivor lives in a different block, the absorbed
  // finding's block is remapped to the survivor id (the merged finding is still
  // referenced), not emptied out.
  it("remaps (never drops) an absorbed finding whose survivor lives in another block", () => {
    const blocks: RemediationBlock[] = [
      { block_id: "B-survivor", items: ["SURV"], parallel_safe: true },
      { block_id: "B-absorbed", items: ["ABS"], parallel_safe: true },
    ];
    const mergeMap = new Map([["ABS", "SURV"]]);
    const result = fixupBlocksAfterDedup(blocks, mergeMap);
    // The absorbed finding's block now points at the survivor — not dropped.
    const absorbedBlock = result.find((b) => b.block_id === "B-absorbed")!;
    expect(absorbedBlock.items).toEqual(["SURV"]);
    // Every survivor id remains referenced after fixup (no finding lost).
    const allItems = new Set(result.flatMap((b) => b.items));
    expect(allItems.has("SURV")).toBe(true);
    expect(allItems.has("ABS")).toBe(false);
  });
});
