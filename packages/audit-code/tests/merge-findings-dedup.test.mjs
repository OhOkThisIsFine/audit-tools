import test from "node:test";
import assert from "node:assert/strict";

const { mergeFindings } = await import("../src/reporting/mergeFindings.ts");
const { assignStableFindingIds } = await import(
  "../src/reporting/findingIdentity.ts"
);

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

function wrapResult(findings, overrides = {}) {
  return {
    task_id: "t-1",
    unit_id: "u-1",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: "src/foo.ts", total_lines: 100 }],
    findings,
    ...overrides,
  };
}

// ── identity merge (exact normalized lens|category|title) ───────────────────

test("mergeFindings collapses re-emissions of one identity across files and passes into a single finding", () => {
  const first = makeFinding({
    id: "F-A",
    title: "Config loaded without validation",
    category: "Validation",
    lens: "correctness",
    severity: "medium",
    confidence: "low",
    systemic: false,
    summary: "Config is read raw.",
    evidence: ["ev-first", "ev-shared"],
    affected_files: [{ path: "src/zeta.ts", line_start: 4, line_end: 9 }],
  });
  const second = makeFinding({
    id: "F-B",
    title: "Config loaded without validation",
    category: "Validation",
    lens: "correctness",
    severity: "high",
    confidence: "medium",
    systemic: true,
    summary: "Config is read raw in a second module too.",
    evidence: ["ev-shared", "ev-second"],
    affected_files: [{ path: "src/alpha.ts", line_start: 12, line_end: 20 }],
  });

  const merged = mergeFindings([
    {
      task_id: "t-1",
      unit_id: "u-1",
      pass_id: "pass:correctness:1",
      lens: "correctness",
      file_coverage: [{ path: "src/zeta.ts", total_lines: 100 }],
      findings: [first],
    },
    {
      task_id: "t-2",
      unit_id: "u-2",
      pass_id: "pass:correctness:2",
      lens: "correctness",
      file_coverage: [{ path: "src/alpha.ts", total_lines: 100 }],
      findings: [second],
    },
  ]);

  assert.equal(
    merged.length,
    1,
    "re-emissions of one identity across files/units/passes must collapse to 1",
  );
  assert.deepEqual(
    merged[0].affected_files.map((f) => f.path),
    ["src/alpha.ts", "src/zeta.ts"],
    "survivor's affected_files is the union of both paths, sorted by path",
  );
  assert.deepEqual(
    [...merged[0].evidence].sort(),
    ["ev-first", "ev-second", "ev-shared"],
    "survivor's evidence is the set-union of both findings' evidence",
  );
  assert.equal(merged[0].severity, "high", "severity escalates to the max rank");
  assert.equal(
    merged[0].confidence,
    "medium",
    "confidence escalates to the max rank",
  );
  assert.equal(merged[0].systemic, true, "systemic ORs across re-emissions");
});

test("one problem re-emitted from two files/passes merges to one finding that keeps the canonical stable id of its identity", () => {
  // The same identity (lens|category|title) reported from two different files
  // in two different units/passes. src/alpha.ts sorts first, so it stays the
  // structural anchor before and after the file union grows.
  const emission = (file, evidence) =>
    makeFinding({
      title: "Config loaded without validation",
      category: "Validation",
      lens: "correctness",
      evidence: [evidence],
      affected_files: [{ path: file, line_start: 1, line_end: 5 }],
    });

  const merged = mergeFindings([
    wrapResult([emission("src/alpha.ts", "ev-alpha")], {
      task_id: "t-1",
      unit_id: "u-1",
      pass_id: "pass:correctness:1",
      file_coverage: [{ path: "src/alpha.ts", total_lines: 100 }],
    }),
    wrapResult([emission("src/zeta.ts", "ev-zeta")], {
      task_id: "t-2",
      unit_id: "u-2",
      pass_id: "pass:correctness:2",
      file_coverage: [{ path: "src/zeta.ts", total_lines: 100 }],
    }),
  ]);

  assert.equal(
    merged.length,
    1,
    "the same problem reported from two files/passes must merge to exactly 1 finding",
  );
  assert.deepEqual(
    merged[0].affected_files.map((f) => f.path),
    ["src/alpha.ts", "src/zeta.ts"],
    "merged file coverage reflects both source files",
  );
  assert.ok(
    merged[0].evidence.includes("ev-alpha") &&
      merged[0].evidence.includes("ev-zeta"),
    "merged evidence reflects both sources",
  );

  // Re-keying the merged finding yields the same canonical id as a fresh
  // single-source emission of the identity — merging never moves the id.
  const [rekeyed] = assignStableFindingIds(merged);
  const [canonical] = assignStableFindingIds([
    emission("src/alpha.ts", "ev-alpha"),
  ]);
  assert.equal(
    rekeyed.id,
    canonical.id,
    "the merged finding's id must equal the canonical id derived for its identity",
  );
});

test("the same title shape in two different units stays two findings with distinct ids", () => {
  // Identical wording shape — only the unit-specific embedded path differs —
  // with the same category and lens. Raw titles are not byte-identical, so the
  // exact-identity merge never collapses them; the fuzzy same-lens dedup groups
  // by primary path, so distinct units are never compared on mere similarity.
  const inUnit = (unitId, file) =>
    makeFinding({
      unit_id: unitId,
      title: `Hard-coded timeout in ${file}:30`,
      category: "ResourceUse",
      lens: "correctness",
      affected_files: [{ path: file, line_start: 30, line_end: 30 }],
    });

  const merged = mergeFindings([
    wrapResult([inUnit("u-poller", "src/poller.ts")], {
      task_id: "t-1",
      unit_id: "u-poller",
      file_coverage: [{ path: "src/poller.ts", total_lines: 100 }],
    }),
    wrapResult([inUnit("u-uploader", "src/uploader.ts")], {
      task_id: "t-2",
      unit_id: "u-uploader",
      file_coverage: [{ path: "src/uploader.ts", total_lines: 100 }],
    }),
  ]);

  assert.equal(
    merged.length,
    2,
    "the same title shape in two different units must NOT collapse",
  );
  assert.deepEqual(
    new Set(merged.map((f) => f.unit_id)),
    new Set(["u-poller", "u-uploader"]),
    "each surviving finding retains its own unit_id",
  );
  const ids = assignStableFindingIds(merged).map((f) => f.id);
  assert.notEqual(
    ids[0],
    ids[1],
    "the two findings must keep distinct, non-equal ids",
  );
});

test("mergeFindings keeps same-title findings with different categories separate (category is part of identity)", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({
        id: "F-A",
        title: "Unbounded retry loop",
        category: "ErrorHandling",
        lens: "correctness",
        affected_files: [{ path: "src/poller.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
    wrapResult([
      makeFinding({
        id: "F-B",
        title: "Unbounded retry loop",
        category: "ResourceUse",
        lens: "correctness",
        affected_files: [{ path: "src/uploader.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
  ]);
  assert.equal(
    merged.length,
    2,
    "identical title with different category on different files must stay 2",
  );
});

test("mergeFindings keeps same-title same-category findings with different lenses on different files separate", () => {
  // Exact-identity merge keys include the lens, so these never share a key;
  // cross-lens fuzzy dedup still requires filePathOverlap >= 0.5, which two
  // disjoint file sets cannot reach.
  const merged = mergeFindings([
    wrapResult([
      makeFinding({
        id: "F-A",
        title: "Unbounded retry loop",
        category: "General",
        lens: "correctness",
        affected_files: [{ path: "src/poller.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
    wrapResult([
      makeFinding({
        id: "F-B",
        title: "Unbounded retry loop",
        category: "General",
        lens: "reliability",
        affected_files: [{ path: "src/uploader.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
  ]);
  assert.equal(
    merged.length,
    2,
    "identical title+category across lenses on disjoint files must stay 2",
  );
});

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
