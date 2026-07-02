import { test, expect } from "vitest";

const { assignStableFindingIds, findingIdentitySignature } = await import("../../src/audit/reporting/findingIdentity.ts");
const { buildAuditReportModel } = await import("../../src/audit/reporting/synthesis.ts");

function finding(overrides = {}) {
  return {
    id: "MNT-001",
    title: "A finding",
    category: "smell",
    severity: "medium",
    confidence: "high",
    lens: "maintainability",
    summary: "summary",
    affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 10 }],
    evidence: ["e"],
    ...overrides,
  };
}

test("assignStableFindingIds gives every finding a globally-unique, lens-prefixed id", () => {
  const out = assignStableFindingIds([
    finding({ id: "MNT-001", title: "first", affected_files: [{ path: "src/a.ts" }] }),
    finding({ id: "MNT-001", title: "second", affected_files: [{ path: "src/b.ts" }] }),
    finding({ id: "COR-001", lens: "correctness", title: "third", affected_files: [{ path: "src/c.ts" }] }),
  ]);

  const ids = out.map((f) => f.id);
  expect(new Set(ids).size, "ids must be unique").toBe(3);
  expect(ids[0].startsWith("MNT-"), `expected MNT- prefix, got ${ids[0]}`).toBeTruthy();
  expect(ids[1].startsWith("MNT-"), `expected MNT- prefix, got ${ids[1]}`).toBeTruthy();
  expect(ids[2].startsWith("COR-"), `expected COR- prefix, got ${ids[2]}`).toBeTruthy();
});

test("assignStableFindingIds is deterministic and content-derived (stable across runs)", () => {
  const input = [finding({ title: "stable" }), finding({ title: "other", affected_files: [{ path: "src/z.ts" }] })];
  const a = assignStableFindingIds(input).map((f) => f.id);
  const b = assignStableFindingIds(input).map((f) => f.id);
  expect(a, "same findings must re-key to the same ids").toEqual(b);
});

test("assignStableFindingIds deterministically disambiguates a content/hash collision", () => {
  // Two findings with an identical content signature collide on the base hash;
  // the guard must still hand back distinct ids.
  const f = finding({ title: "dup", affected_files: [{ path: "src/dup.ts" }] });
  const out = assignStableFindingIds([f, { ...f }]);
  expect(out[0].id).not.toBe(out[1].id);
  const stem = out[0].id;
  expect(out[1].id).toBe(`${stem}-2`);
});

test("assignStableFindingIds drops related_findings (it referenced collision-prone ids)", () => {
  const out = assignStableFindingIds([
    finding({ related_findings: ["MNT-001", "COR-001"] }),
  ]);
  expect(out[0].related_findings).toBe(undefined);
});

// Derive the id of a single finding in isolation (no cross-finding collision
// suffixes), so identical semantic findings can be compared across calls.
function idOf(overrides = {}) {
  return assignStableFindingIds([finding(overrides)])[0].id;
}

test("identity derivation is deterministic: structurally identical inputs yield the same id", () => {
  // Fresh object literals each time — same structure, never the same reference.
  const build = () =>
    finding({
      unit_id: "unit-auth",
      lens: "correctness",
      title: "Token expiry never checked",
      category: "AuthZ",
      evidence: ["token read without expiry comparison"],
      affected_files: [
        { path: "src/auth/session.ts", symbol: "refreshToken", line_start: 12, line_end: 30 },
      ],
    });

  const [a] = assignStableFindingIds([build()]);
  const [b] = assignStableFindingIds([build()]);

  expect(typeof a.id).toBe("string");
  expect(a.id, "id must follow the <LENS_PREFIX>-<8-hex-content-hash> format").toMatch(/^COR-[0-9a-f]{8}$/);
  expect(a.id, "two structurally identical inputs (separate instances) must derive strictly equal ids").toBe(b.id);
});

test("unrelated unit-membership changes leave untouched findings' ids byte-identical", () => {
  // A fixed set of findings spanning all three ladder tiers, each owned by its
  // own unit. Built fresh per call so no run shares references.
  const untouched = () => [
    finding({
      unit_id: "unit-a",
      lens: "correctness",
      category: "",
      title: "anchored concern",
      affected_files: [{ path: "src/a.ts", symbol: "alpha" }],
    }),
    finding({
      unit_id: "unit-b",
      lens: "maintainability",
      category: "smell",
      title: "rule-derived concern",
      affected_files: [],
    }),
    finding({
      unit_id: "unit-c",
      lens: "security",
      category: "",
      title: "title-derived concern",
      affected_files: [],
    }),
  ];

  const before = assignStableFindingIds(untouched()).map((f) => f.id);

  // Unrelated change #1: a brand-new unit enters the bundle — a finding from a
  // unit none of the originals belong to, inserted ahead of them.
  const newUnitFinding = finding({
    unit_id: "unit-new",
    lens: "reliability",
    category: "ResourceUse",
    title: "fresh problem in the new unit",
    affected_files: [{ path: "src/new-unit/worker.ts", symbol: "spin" }],
  });
  const after = assignStableFindingIds([newUnitFinding, ...untouched()]);
  expect(after.slice(1).map((f) => f.id), "adding a finding from an unrelated new unit must leave every untouched id byte-identical").toEqual(before);
  for (const f of after.slice(1)) {
    expect(!f.affected_files.some((af) => af.path.includes("new-unit")), "the added unit must not appear in any untouched finding's identity inputs").toBeTruthy();
    expect(!findingIdentitySignature({
        anchor_path: f.affected_files[0]?.path,
        anchor_symbol: f.affected_files[0]?.symbol,
        category: f.category,
        lens: f.lens,
        title: f.title,
      }).includes("new-unit"), "the added unit must not appear in any untouched finding's identity signature").toBeTruthy();
  }

  // Unrelated change #2: unit membership of the untouched findings is
  // reassigned (unit_id is volatile metadata, never part of identity).
  const reassigned = untouched().map((f) => ({ ...f, unit_id: "unit-reassigned" }));
  expect(assignStableFindingIds(reassigned).map((f) => f.id), "reassigning unit membership must leave every id byte-identical").toEqual(before);
});

test("anchor tier is stable across volatile fields", () => {
  const anchored = (extra = {}) =>
    idOf({
      affected_files: [
        { path: "src/a.ts", symbol: "doWork", line_start: 1, line_end: 10 },
      ],
      ...extra,
    });

  // Same path + symbol, different line numbers -> same id.
  expect(anchored(), "line numbers must not influence the id").toBe(idOf({
      affected_files: [
        { path: "src/a.ts", symbol: "doWork", line_start: 42, line_end: 99 },
      ],
    }));

  // Pass ordinal / pass_id, timestamp, and content-derived unit id changes
  // with a fixed anchor must not change the id.
  expect(anchored(), "pass_id / unit_id / timestamp must not influence the id").toBe(anchored({
      pass_id: "pass:maintainability:7",
      unit_id: "unit-sha-9f8e7d6c",
      timestamp: "2026-06-09T12:34:56Z",
    }));

  // Path separator and case differences must not change the id.
  expect(idOf({ affected_files: [{ path: "src/Sub/A.ts", symbol: "doWork" }] }), "path separators and path case must not influence the id").toBe(idOf({ affected_files: [{ path: "src\\sub\\a.ts", symbol: "doWork" }] }));
});

test("identity includes the anchor's unit/scope", () => {
  const idA = idOf({ affected_files: [{ path: "src/a.ts", symbol: "alpha" }] });
  const idB = idOf({ affected_files: [{ path: "src/a.ts", symbol: "beta" }] });
  expect(idA, "same path with different symbol/scope must produce different ids").not.toBe(idB);

  const again = idOf({ affected_files: [{ path: "src/a.ts", symbol: "alpha" }] });
  expect(idA, "same path with same symbol/scope must produce the same id").toBe(again);
});

test("fallback ladder ordering is explicit and deterministic", () => {
  // Anchor present -> derived from the anchor even when rule/category and
  // title are also present (varying them changes nothing).
  const sig = findingIdentitySignature({
    anchor_path: "src/a.ts",
    anchor_symbol: "doWork",
    category: "smell",
    lens: "maintainability",
    title: "anything at all",
  });
  expect(sig.startsWith("anchor|"), `expected anchor tier, got ${sig}`).toBeTruthy();
  expect(idOf({
      affected_files: [{ path: "src/a.ts", symbol: "doWork" }],
      category: "smell",
      title: "one title",
    }), "with an anchor, category/title must not influence the id").toBe(idOf({
      affected_files: [{ path: "src/a.ts", symbol: "doWork" }],
      category: "different-category",
      title: "a completely different title",
    }));

  // No anchor but a rule/category -> derived from the rule/category, not the
  // title.
  const ruleSig = findingIdentitySignature({
    category: "smell",
    lens: "maintainability",
    title: "anything at all",
  });
  expect(ruleSig.startsWith("rule|"), `expected rule tier, got ${ruleSig}`).toBeTruthy();
  expect(idOf({ affected_files: [], category: "smell", title: "one title" }), "without an anchor, the rule/category (not the title) drives the id").toBe(idOf({ affected_files: [], category: "smell", title: "another title" }));
  expect(idOf({ affected_files: [], category: "smell", title: "same title" }), "different rule/category must produce different ids").not.toBe(idOf({ affected_files: [], category: "lint-rule", title: "same title" }));

  // Neither anchor nor rule/category -> derived from the normalized title.
  const titleSig = findingIdentitySignature({
    category: "",
    title: "Only a Title",
  });
  expect(titleSig.startsWith("title|"), `expected title tier, got ${titleSig}`).toBeTruthy();
  expect(idOf({ affected_files: [], category: "", title: "first concern" }), "without anchor or category, the normalized title drives the id").not.toBe(idOf({ affected_files: [], category: "", title: "second concern" }));

  // Calling the derivation twice with identical input yields the identical id.
  const input = {
    affected_files: [{ path: "src/a.ts", symbol: "doWork" }],
    category: "smell",
    title: "stable",
  };
  expect(idOf(input), "derivation must be deterministic").toBe(idOf(input));
});

test("B8 decision: fileless same-lens+category findings collapse; the volatile title never splits them", () => {
  // The B8 question was whether two distinct FILELESS findings of the same
  // lens+category should collapse (they do) or need a discriminator. Decision:
  // collapse is correct — lens+category is a fileless finding's only stable
  // identity, and the title is deliberately tier 3 (volatile). Splitting on the
  // title would re-introduce over-splitting (a reworded re-emission becoming two
  // findings). A genuinely different defect must differ by CATEGORY.
  expect(idOf({ affected_files: [], lens: "operability", category: "ci", title: "No CI pipeline configured" }), "same lens+category fileless findings collapse regardless of how differently the title is worded").toBe(idOf({ affected_files: [], lens: "operability", category: "ci", title: "CI is entirely absent from the repo" }));
  expect(idOf({ affected_files: [], lens: "operability", category: "ci", title: "same title" }), "a genuinely different fileless defect must differ by category (the auditor's discriminator)").not.toBe(idOf({ affected_files: [], lens: "operability", category: "release", title: "same title" }));
});

test("id is stable across affected-file composition (merged file unions never move it)", () => {
  // mergeFindings unions re-emitted files into one finding and sorts them by
  // path; the id hashes the stable structural anchor only — never the merged
  // file list — so growing the union must not move the id.
  const single = idOf({
    title: "Config loaded without validation",
    category: "Validation",
    affected_files: [{ path: "src/config.ts", symbol: "loadConfig" }],
  });
  const mergedUnion = idOf({
    title: "Config loaded without validation",
    category: "Validation",
    affected_files: [
      { path: "src/config.ts", symbol: "loadConfig" },
      { path: "src/server.ts", line_start: 3, line_end: 9 },
      { path: "src/worker.ts" },
    ],
  });
  expect(single, "one file vs. the merged union of several files must yield the same id").toBe(mergedUnion);

  // Different identities still get different ids: with no structural anchor,
  // the rule/category (tier 2) and then the normalized title (tier 3) drive
  // the hash, so changing either changes the id.
  expect(idOf({ affected_files: [], category: "Validation", title: "same title" }), "different category must produce a different id").not.toBe(idOf({ affected_files: [], category: "ErrorHandling", title: "same title" }));
  expect(idOf({ affected_files: [], category: "", title: "first concern" }), "different title (no anchor, no category) must produce a different id").not.toBe(idOf({ affected_files: [], category: "", title: "second concern" }));
});

test("title normalization strips volatile content", () => {
  // Tier 3 only: no anchor, no rule/category.
  const titleId = (title) => idOf({ affected_files: [], category: "", title });

  expect(titleId("Unused Imports Detected"), "case-only differences must not influence the id").toBe(titleId("unused imports detected"));
  expect(titleId("3 unused imports"), "embedded counts must not influence the id").toBe(titleId("5 unused imports"));
  expect(titleId("dead code at src/foo.ts:42"), "embedded file paths / line numbers must not influence the id").toBe(titleId("dead code at src/bar.ts:99"));
  expect(titleId("too   many\tbranches"), "whitespace-only differences must not influence the id").toBe(titleId("too many branches"));
});

test("forbidden inputs never influence the ID", () => {
  // A finding with an anchor keeps its id when the raw title changes — the
  // raw title is never hashed directly.
  const anchored = (title) =>
    idOf({ affected_files: [{ path: "src/a.ts", symbol: "doWork" }], title });
  expect(anchored("v1: 3 problems in src/a.ts:10"), "raw title changes must not move an anchored finding's id").toBe(anchored("totally rephrased headline"));

  // Content-derived unit ids, line numbers, pass ordinals, and timestamps are
  // absent from the hash input at every ladder tier.
  const volatile = {
    unit_id: "unit-sha-deadbeef",
    pass_id: "pass:tests:3",
    timestamp: "2026-06-09T00:00:00Z",
  };
  // Tier 1 (anchor), including line numbers.
  expect(idOf({
      affected_files: [{ path: "src/a.ts", symbol: "s", line_start: 1, line_end: 2 }],
    })).toBe(idOf({
      affected_files: [{ path: "src/a.ts", symbol: "s", line_start: 7, line_end: 9 }],
      ...volatile,
    }));
  // Tier 2 (rule/category).
  expect(idOf({ affected_files: [], category: "smell" })).toBe(idOf({ affected_files: [], category: "smell", ...volatile }));
  // Tier 3 (normalized title).
  expect(idOf({ affected_files: [], category: "", title: "a concern" })).toBe(idOf({ affected_files: [], category: "", title: "a concern", ...volatile }));
});

test("buildAuditReportModel: colliding per-packet ids become unique and work_blocks round-trip", () => {
  // Two packets both emit id "MNT-001" for unrelated files — the exact T-004
  // collision. After synthesis every finding id must be unique, and every
  // work_blocks.finding_ids entry must resolve to exactly one finding.
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "t1",
        unit_id: "u1",
        pass_id: "pass:maintainability",
        lens: "maintainability",
        file_coverage: [{ path: "src/a.ts", total_lines: 20 }],
        findings: [
          {
            id: "MNT-001",
            title: "god module a",
            category: "length",
            severity: "high",
            confidence: "high",
            lens: "maintainability",
            summary: "a is too long",
            affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 20 }],
            evidence: ["x"],
          },
        ],
      },
      {
        task_id: "t2",
        unit_id: "u2",
        pass_id: "pass:maintainability",
        lens: "maintainability",
        file_coverage: [{ path: "src/b.ts", total_lines: 20 }],
        findings: [
          {
            id: "MNT-001",
            title: "god module b",
            category: "length",
            severity: "high",
            confidence: "high",
            lens: "maintainability",
            summary: "b is too long",
            affected_files: [{ path: "src/b.ts", line_start: 1, line_end: 20 }],
            evidence: ["y"],
          },
        ],
      },
    ],
  });

  const ids = report.findings.map((f) => f.id);
  expect(report.findings.length).toBe(2);
  expect(new Set(ids).size, "synthesized finding ids must be unique").toBe(2);

  const findingIds = new Set(ids);
  const referenced = report.work_blocks.flatMap((b) => b.finding_ids);
  expect(new Set(referenced).size, "no finding id is referenced by more than one work-block slot").toBe(referenced.length);
  for (const ref of referenced) {
    expect(findingIds.has(ref), `work block references unknown finding id ${ref}`).toBeTruthy();
  }
  // The two findings own different units, so they must NOT fuse into one block
  // (the union-find-on-id collapse that non-unique ids used to cause).
  expect(referenced.length).toBe(2);
});
