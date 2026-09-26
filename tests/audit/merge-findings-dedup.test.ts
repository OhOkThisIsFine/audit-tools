import { test, expect } from "vitest";
import { mergeFindings } from "../../src/audit/reporting/mergeFindings.js";
import { assignStableFindingIds } from "../../src/audit/reporting/findingIdentity.js";
import type { Finding, AuditResult } from "../../src/audit/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides?: Partial<Finding & { unit_id?: string }>): Finding & { unit_id?: string } {
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

function wrapResult(findings: Finding[], overrides: Partial<AuditResult> = {}): AuditResult {
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

  expect(merged.length, "re-emissions of one identity across files/units/passes must collapse to 1").toBe(1);
  expect(merged[0].affected_files.map((f) => f.path), "survivor's affected_files is the union of both paths, sorted by path").toEqual(["src/alpha.ts", "src/zeta.ts"]);
  expect([...merged[0].evidence!].sort(), "survivor's evidence is the set-union of both findings' evidence").toEqual(["ev-first", "ev-second", "ev-shared"]);
  expect(merged[0].severity, "severity escalates to the max rank").toBe("high");
  expect(merged[0].confidence, "confidence escalates to the max rank").toBe("medium");
  expect(merged[0].systemic, "systemic ORs across re-emissions").toBe(true);
});

test("one problem re-emitted from two files/passes merges to one finding that keeps the canonical stable id of its identity", () => {
  // The same identity (lens|category|title) reported from two different files
  // in two different units/passes. src/alpha.ts sorts first, so it stays the
  // structural anchor before and after the file union grows.
  const emission = (file: string, evidence: string) =>
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

  expect(merged.length, "the same problem reported from two files/passes must merge to exactly 1 finding").toBe(1);
  expect(merged[0].affected_files.map((f) => f.path), "merged file coverage reflects both source files").toEqual(["src/alpha.ts", "src/zeta.ts"]);
  expect(merged[0].evidence!.includes("ev-alpha") &&
      merged[0].evidence!.includes("ev-zeta"), "merged evidence reflects both sources").toBeTruthy();

  // Re-keying the merged finding yields the same canonical id as a fresh
  // single-source emission of the identity — merging never moves the id.
  const [rekeyed] = assignStableFindingIds(merged);
  const [canonical] = assignStableFindingIds([
    emission("src/alpha.ts", "ev-alpha"),
  ]);
  expect(rekeyed.id, "the merged finding's id must equal the canonical id derived for its identity").toBe(canonical.id);
});

test("the same title shape in two different units stays two findings with distinct ids", () => {
  // Identical wording shape — only the unit-specific embedded path differs —
  // with the same category and lens. Raw titles are not byte-identical, so the
  // exact-identity merge never collapses them; the fuzzy same-lens dedup groups
  // by primary path, so distinct units are never compared on mere similarity.
  const inUnit = (unitId: string, file: string) =>
    makeFinding({
      unit_id: unitId,
      title: `Hard-coded timeout in ${file}:30`,
      category: "ResourceUse",
      lens: "correctness",
      affected_files: [{ path: file, line_start: 30, line_end: 30 }],
    });

  const merged: (Finding & { unit_id?: string })[] = mergeFindings([
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

  expect(merged.length, "the same title shape in two different units must NOT collapse").toBe(2);
  expect(new Set(merged.map((f) => f.unit_id)), "each surviving finding retains its own unit_id").toEqual(new Set(["u-poller", "u-uploader"]));
  const ids = assignStableFindingIds(merged).map((f) => f.id);
  expect(ids[0], "the two findings must keep distinct, non-equal ids").not.toBe(ids[1]);
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
  expect(merged.length, "identical title with different category on different files must stay 2").toBe(2);
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
  expect(merged.length, "identical title+category across lenses on disjoint files must stay 2").toBe(2);
});

// ── identity-keyed dedup, never (task_id, unit_id, pass_id, lens)-keyed ──────
//
// audit-orchestrator-core deliberately persists MULTIPLE AuditResult records
// for one (task_id, unit_id, pass_id, lens) coordinate — base, selective-
// deepening, steward and redispatch records all survive the ledger's
// idempotent append (src/audit/orchestrator/ledger.ts, appended at
// ingestionExecutors.ts), and rekeyDriftedResults mints a fresh redispatch key
// precisely so a drifted re-run is not collapsed into its stale base record.
// mergeFindings must key its dedup on each FINDING's own identity/content —
// never on the AuditResult coordinate the findings arrived wrapped in — or it
// would silently discard one of two genuinely different findings just because
// they share a task/unit/pass/lens coordinate.

test("mergeFindings keeps a base AND a redispatch record's findings for the SAME (task_id, unit_id, pass_id, lens) coordinate — dedup keys on finding identity, not the coordinate", () => {
  const coordinate = {
    task_id: "t-1",
    unit_id: "u-1",
    pass_id: "pass:correctness:1",
    lens: "correctness",
  };

  // The base result's finding, found before the file drifted.
  const baseResult = wrapResult(
    [
      makeFinding({
        id: "BASE-F1",
        title: "Unbounded retry loop on connect",
        category: "ErrorHandling",
        lens: "correctness",
        affected_files: [{ path: "src/connect.ts", line_start: 10, line_end: 20 }],
        evidence: ["ev-base"],
      }),
    ],
    coordinate,
  );

  // A redispatch result for the EXACT SAME coordinate (same task_id/unit_id/
  // pass_id/lens — mirroring what rekeyDriftedResults produces at the ledger
  // layer): a genuinely different finding, discovered after the file drifted.
  // Distinct title/category/file so it shares no identity with the base finding.
  const redispatchResult = wrapResult(
    [
      makeFinding({
        id: "REDISPATCH-F1",
        title: "Missing null check after refactor",
        category: "NullHandling",
        lens: "correctness",
        affected_files: [{ path: "src/connect.ts", line_start: 55, line_end: 60 }],
        evidence: ["ev-redispatch"],
      }),
    ],
    coordinate,
  );

  const merged = mergeFindings([baseResult, redispatchResult]);

  // Both must survive: collapsing them down to 1 (e.g. a regression that keys
  // dedup on the shared coordinate instead of finding identity/content) must
  // turn this assertion red.
  expect(merged.length, "base and redispatch findings for one coordinate must BOTH survive dedup").toBe(2);
  expect(new Set(merged.map((f) => f.id))).toEqual(new Set(["BASE-F1", "REDISPATCH-F1"]));
});

// ── blast-radius ordering (conceptual design-review spine, Phase A) ──────────

test("mergeFindings orders equal severity+confidence findings by blast_radius descending", () => {
  // Two distinct-identity findings, equal severity+confidence, disjoint files so
  // they never merge. The high-blast one carries an alphabetically-LATER title, so
  // only the blast tiebreaker (not the title fallback) can explain it ranking first.
  const merged = mergeFindings([
    wrapResult([
      makeFinding({
        id: "F-LOW",
        title: "Aaa low-blast leaf fix",
        category: "General",
        lens: "correctness",
        severity: "high",
        confidence: "high",
        blast_radius: 1,
        affected_files: [{ path: "src/leaf.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
    wrapResult([
      makeFinding({
        id: "F-HIGH",
        title: "Zzz high-blast charter break",
        category: "General",
        lens: "architecture",
        severity: "high",
        confidence: "high",
        blast_radius: 5,
        affected_files: [{ path: "src/charter.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
  ]);
  expect(merged.length).toBe(2);
  expect(merged[0].blast_radius, "higher blast_radius ranks first").toBe(5);
  expect(merged[1].blast_radius).toBe(1);
});

test("mergeFindings treats absent blast_radius as 0 in the tiebreaker", () => {
  const merged = mergeFindings([
    wrapResult([
      makeFinding({
        id: "F-NONE",
        title: "Aaa finding without blast",
        category: "General",
        lens: "correctness",
        severity: "medium",
        confidence: "medium",
        // blast_radius intentionally absent → treated as 0
        affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
    wrapResult([
      makeFinding({
        id: "F-THREE",
        title: "Zzz finding with blast 3",
        category: "General",
        lens: "architecture",
        severity: "medium",
        confidence: "medium",
        blast_radius: 3,
        affected_files: [{ path: "src/b.ts", line_start: 1, line_end: 5 }],
      }),
    ]),
  ]);
  expect(merged[0].id, "blast 3 outranks absent(=0) despite a later title").toBe(
    "F-THREE",
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

  expect(merged.length, "identical-title same-lens no-line-info findings must merge to 1").toBe(1);
  expect(merged[0].evidence!.includes("ev-a") && merged[0].evidence!.includes("ev-b"), "survivor absorbs evidence from both findings").toBeTruthy();
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

  expect(merged.length, "same-category same-lens findings with Jaccard 0.4 must merge").toBe(1);
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

  expect(merged.length, "different-category same-lens findings with Jaccard 0.4 must NOT merge").toBe(2);
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

  expect(merged.length, "same-lens findings on different files must survive dedup unchanged").toBe(2);
});

// ── semantic confirmation of deterministic leads (O32) ───────────────────────
//
// A deterministic producer (designAssessment / structureDecomposition /
// charterRegister / systemicChallenge) stamps its output with `lead_lineage`,
// marking a generation-bound LEAD rather than an approved verdict. A lead may
// enter the final report only when some semantic finding re-raises its canonical
// identity (the file-independent re-emission key: normalized lens|category|
// title). An unconfirmed lead stays in its analysis artifact — mergeFindings
// simply does not admit it here.

function makeLead(overrides?: Partial<Finding>): Finding {
  return makeFinding({
    id: "LEAD-001",
    title: "Bridge seam between modules",
    category: "architectural_seam",
    lens: "architecture",
    evidence: ["lead-evidence"],
    affected_files: [{ path: "src/alpha.ts", line_start: 1, line_end: 5 }],
    lead_lineage: {
      producer: "detectSeams",
      source_hash: "abc123def456",
      confirmation: "lead",
    },
    ...overrides,
  }) as Finding;
}

test("a deterministic lead alone is absent from the final findings (no semantic confirmation)", () => {
  const lead = makeLead();
  const merged = mergeFindings(
    [],
    undefined,
    undefined,
    { generated_at: "2026-01-01T00:00:00Z", findings: [lead] },
  );
  expect(merged.map((f) => f.id), "an unconfirmed lead must not reach the report").toEqual([]);
});

test("a semantic finding that re-raises the lead's identity confirms it and preserves lineage plus evidence", () => {
  const lead = makeLead();
  const confirming = makeFinding({
    id: "DR-001",
    title: "Bridge seam between modules", // same identity (lens|category|title)
    category: "architectural_seam",
    lens: "architecture",
    evidence: ["confirming-evidence"],
    affected_files: [{ path: "src/beta.ts", line_start: 1, line_end: 2 }],
    // host-authored: no lead_lineage
  });

  const merged = mergeFindings(
    [],
    undefined,
    undefined,
    {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [lead],
      contract_findings: [confirming],
    },
  );
  expect(merged.length, "a confirmed lead collapses to one finding").toBe(1);
  const survivor = merged[0];
  // The tool stamp survives the merge — the admitted finding still names its
  // deterministic producer, not the host that confirmed it.
  expect(survivor.lead_lineage).toEqual({
    producer: "detectSeams",
    source_hash: "abc123def456",
    confirmation: "lead",
  });
  // Both the producer's evidence and the confirming finding's evidence survive.
  expect([...survivor.evidence!].sort()).toEqual(
    ["confirming-evidence", "lead-evidence"].sort(),
  );
  // The confirming finding's file is absorbed into the lead's affected_files.
  expect(new Set(survivor.affected_files.map((f) => f.path))).toEqual(
    new Set(["src/alpha.ts", "src/beta.ts"]),
  );
});

test("an unrelated semantic finding does not confirm a lead", () => {
  const lead = makeLead();
  const unrelated = makeFinding({
    id: "DR-002",
    title: "Something else entirely",
    category: "ResourceUse",
    lens: "correctness",
    affected_files: [{ path: "src/other.ts", line_start: 1, line_end: 2 }],
  });

  const merged = mergeFindings(
    [],
    undefined,
    undefined,
    {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [lead],
      contract_findings: [unrelated],
    },
  );
  // Only the unrelated semantic finding survives; the unconfirmed lead is absent.
  expect(merged.map((f) => f.id)).toEqual(["DR-002"]);
});

test("an ordinary non-heuristic finding is unaffected by the lead gate", () => {
  // A host-authored finding with no lead_lineage flows through exactly as before,
  // whether or not any deterministic lead exists.
  const ordinary = makeFinding({
    id: "ORD-001",
    title: "Unchecked null dereference",
    category: "NullHandling",
    lens: "correctness",
    evidence: ["ev-ordinary"],
  });
  const merged = mergeFindings([
    wrapResult([ordinary]),
  ]);
  expect(merged.length).toBe(1);
  expect(merged[0].id).toBe("ORD-001");
  expect(merged[0].lead_lineage).toBeUndefined();
});

// ── charter-delta leads (differenceFindings → charterRegister.findings) ───────
//
// `differenceFindings` is a deterministic chart-DAG producer and now stamps
// `lead_lineage` on every surfaced lead, so the same gate applies: an
// unconfirmed charter delta is a lead, held out of the report until a semantic
// finding re-raises its identity.

function makeCharterLead(overrides?: Partial<Finding>): Finding {
  return makeFinding({
    id: "diff-1",
    title: "Charter purpose difference (revealed against the rest)",
    category: "charter_difference:purpose",
    lens: "architecture",
    evidence: ["charter-evidence"],
    affected_files: [{ path: "src/alpha.ts", line_start: 1, line_end: 5 }],
    lead_lineage: {
      producer: "differenceFindings",
      source_hash: "deadbeefdeadbeef",
      confirmation: "lead",
    },
    ...overrides,
  }) as Finding;
}

test("an unconfirmed charter-delta lead alone is absent from the final findings", () => {
  const lead = makeCharterLead();
  const merged = mergeFindings(
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    { findings: [lead] } as Parameters<typeof mergeFindings>[5],
  );
  expect(merged.map((f) => f.id), "an unconfirmed charter lead must not reach the report").toEqual([]);
});

test("a semantic finding re-raising the charter lead's identity confirms it and preserves producer lineage plus evidence", () => {
  const lead = makeCharterLead();
  const confirming = makeFinding({
    id: "DR-CH",
    title: "Charter purpose difference (revealed against the rest)",
    category: "charter_difference:purpose",
    lens: "architecture",
    evidence: ["confirming-charter-evidence"],
    affected_files: [{ path: "src/beta.ts", line_start: 1, line_end: 2 }],
  });

  const merged = mergeFindings(
    [wrapResult([confirming])],
    undefined,
    undefined,
    undefined,
    undefined,
    { findings: [lead] } as Parameters<typeof mergeFindings>[5],
  );
  expect(merged.length, "a confirmed charter lead collapses to one finding").toBe(1);
  const survivor = merged[0];
  // The tool stamp survives the merge — the admitted finding still names its
  // deterministic producer, not the host that confirmed it.
  expect(survivor.lead_lineage).toEqual({
    producer: "differenceFindings",
    source_hash: "deadbeefdeadbeef",
    confirmation: "lead",
  });
  expect([...survivor.evidence!].sort()).toEqual(
    ["charter-evidence", "confirming-charter-evidence"].sort(),
  );
  expect(new Set(survivor.affected_files.map((f) => f.path))).toEqual(
    new Set(["src/alpha.ts", "src/beta.ts"]),
  );
});
