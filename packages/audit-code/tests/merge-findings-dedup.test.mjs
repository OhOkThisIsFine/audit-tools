import test from "node:test";
import assert from "node:assert/strict";

const { mergeFindings } = await import("../src/reporting/mergeFindings.ts");

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides) {
  return {
    id: "F-001",
    title: "Example finding",
    category: "General",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "Example summary.",
    affected_files: [{ path: "src/foo.ts", line_start: 1, line_end: 10 }],
    evidence: ["ev-1"],
    ...overrides,
  };
}

function wrapResult(findings) {
  return {
    task_id: "t-1",
    unit_id: "u-1",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/foo.ts", total_lines: 100 }],
    findings,
  };
}

// ── same-lens dedup edge cases ────────────────────────────────────────────────

test("deduplicateSameLens merges two same-lens findings with both line_end missing (aEnd===0 && bEnd===0 sentinel forces overlap)", () => {
  // When both findings have no line_start and no line_end, affected_files[0].line_end
  // evaluates to `line_end ?? line_start ?? 0 = 0`, triggering the sentinel that
  // forces lineRangeOverlaps to return true unconditionally.
  const a = makeFinding({
    id: "F-A",
    title: "Missing error handler",
    lens: "correctness",
    evidence: ["ev-a"],
    affected_files: [{ path: "src/foo.ts" }], // no line_start or line_end
  });
  const b = makeFinding({
    id: "F-B",
    title: "Missing error handler",
    lens: "correctness",
    evidence: ["ev-b"],
    affected_files: [{ path: "src/foo.ts" }], // no line_start or line_end
  });

  const merged = mergeFindings([
    wrapResult([a]),
    wrapResult([b]),
  ]);

  assert.equal(merged.length, 1, "identical-title same-lens no-line-info findings must merge to 1");
  assert.ok(
    merged[0].evidence.includes("ev-a") && merged[0].evidence.includes("ev-b"),
    "survivor absorbs evidence from both findings",
  );
});

test("deduplicateSameLens merges same-category same-lens findings with title Jaccard in [0.35, 0.44] (catMatch lowers threshold to 0.35)", () => {
  // Title word sets:
  //   "unchecked null value"   → {unchecked, null, value}
  //   "unchecked null pointer exception" → {unchecked, null, pointer, exception}
  // intersection = 2 (unchecked, null), union = 5 → Jaccard = 0.4
  // 0.4 is in [0.35, 0.44]: merges when category matches, stays separate otherwise.
  const a = makeFinding({
    id: "F-A",
    title: "unchecked null value",
    category: "NullHandling",
    lens: "correctness",
    severity: "medium",
    confidence: "medium",
    affected_files: [{ path: "src/foo.ts", line_start: 5, line_end: 15 }],
  });
  const b = makeFinding({
    id: "F-B",
    title: "unchecked null pointer exception",
    category: "NullHandling",
    lens: "correctness",
    severity: "medium",
    confidence: "medium",
    affected_files: [{ path: "src/foo.ts", line_start: 5, line_end: 15 }],
  });

  const merged = mergeFindings([
    wrapResult([a]),
    wrapResult([b]),
  ]);

  assert.equal(merged.length, 1, "same-category same-lens findings with Jaccard 0.4 must merge");
});

test("deduplicateSameLens does NOT merge different-category same-lens findings with title Jaccard in [0.35, 0.44] (threshold stays at 0.45)", () => {
  // Same titles as above (Jaccard = 0.4), but different categories.
  // catMatch = false → threshold = 0.45 → 0.4 < 0.45 → no merge.
  const a = makeFinding({
    id: "F-A",
    title: "unchecked null value",
    category: "NullHandling",
    lens: "correctness",
    severity: "medium",
    confidence: "medium",
    affected_files: [{ path: "src/foo.ts", line_start: 5, line_end: 15 }],
  });
  const b = makeFinding({
    id: "F-B",
    title: "unchecked null pointer exception",
    category: "TypeSafety",  // different category
    lens: "correctness",
    severity: "medium",
    confidence: "medium",
    affected_files: [{ path: "src/foo.ts", line_start: 5, line_end: 15 }],
  });

  const merged = mergeFindings([
    wrapResult([a]),
    wrapResult([b]),
  ]);

  assert.equal(merged.length, 2, "different-category same-lens findings with Jaccard 0.4 must NOT merge");
});

test("deduplicateSameLens keeps near-duplicate-title findings separate when lineRangeOverlaps is false and filePathOverlap is below 0.5", () => {
  // The two findings share the same lens but are on DIFFERENT files.
  // deduplicateSameLens groups by `lens:primaryPath`, so these end up in
  // different groups and are never compared — surviving dedup unchanged.
  // This exercises the guard: even with a high title similarity, no merge
  // occurs when they land in different same-lens groups (different primary paths).
  const a = makeFinding({
    id: "F-A",
    title: "Missing input validation on request body",
    lens: "correctness",
    affected_files: [{ path: "src/controller.ts", line_start: 10, line_end: 20 }],
  });
  const b = makeFinding({
    id: "F-B",
    title: "Missing input validation on request schema",
    lens: "correctness",
    affected_files: [{ path: "src/middleware.ts", line_start: 10, line_end: 20 }],
  });

  const merged = mergeFindings([
    {
      task_id: "t-1",
      unit_id: "u-1",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_coverage: [
        { path: "src/controller.ts", total_lines: 100 },
        { path: "src/middleware.ts", total_lines: 100 },
      ],
      findings: [a, b],
    },
  ]);

  assert.equal(merged.length, 2, "same-lens findings on different files must survive dedup unchanged");
});
