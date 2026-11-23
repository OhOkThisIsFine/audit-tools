/**
 * Extended intent checkpoint tests:
 *  - computeScopePreDigest excluded-scope collapse
 *  - disposition_override_proposals
 *  - lens_proposals
 *  - disposition overrides in question planning and structural context
 *  - IntentCheckpoint round-trip (disposition_overrides + lens_selection)
 */
import { test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeScopePreDigest,
  type ExcludedSummaryRow,
  type AggregatedExcludedRow,
} from "../../src/audit/orchestrator/intentCheckpointExecutor.js";
import { renderSharedStructuralContext } from "../../src/audit/orchestrator/designReviewPrompt.js";
import { buildReviewQuestionPlan, reviewSourceScope } from "../../src/audit/orchestrator/questionPlanning.js";
import { questionWorkloadBindings } from "../../src/audit/cli/questionWorkloadBindings.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseBundle(overrides: Record<string, unknown> = {}): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [],
    },
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    ...overrides,
  };
}

function countTotalFiles(summary: ExcludedSummaryRow[]) {
  return summary.reduce(
    (acc: number, row: ExcludedSummaryRow) => acc + ("prefix" in row ? row.file_count : 1),
    0,
  );
}

// ---------------------------------------------------------------------------
// 1. excluded_summary — directory collapse
// ---------------------------------------------------------------------------

test("computeScopePreDigest collapses all-same-status excluded dir into aggregate row", async () => {
  const files = [
    { path: "dist/a.js", status: "generated", reason: "build output" },
    { path: "dist/b.js", status: "generated", reason: "build output" },
    { path: "dist/c.js", status: "generated", reason: "build output" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const distRows = digest.excluded_summary.filter(
    (r): r is AggregatedExcludedRow => "prefix" in r && r.prefix === "dist",
  );
  expect(distRows.length, "should produce exactly one aggregate row for dist/").toBe(1);
  expect(distRows[0].file_count).toBe(3);
  expect(distRows[0].status).toBe("generated");

  // Total files represented must equal total excluded count
  expect(countTotalFiles(digest.excluded_summary), "total files represented must equal excluded count").toBe(files.length);
});

test("computeScopePreDigest emits individual rows for oddballs in mixed dir", async () => {
  // src/ has mostly included files, but one is excluded
  const files = [
    { path: "src/a.ts", status: "included", reason: "" },
    { path: "src/b.ts", status: "included", reason: "" },
    { path: "src/oddball.ts", status: "excluded", reason: "manual exclusion" },
  ];
  // Only the excluded files end up in `excluded` array; included are not in excluded_summary
  // So src/oddball.ts should appear as an individual row
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const oddballRows = digest.excluded_summary.filter(
    (r) => "path" in r && r.path === "src/oddball.ts",
  );
  expect(oddballRows.length, "oddball excluded file should appear as individual row").toBe(1);
  expect(oddballRows[0].status).toBe("excluded");
});

test("computeScopePreDigest total files matches total excluded count", async () => {
  const files = [
    { path: "dist/a.js", status: "generated", reason: "build" },
    { path: "dist/b.js", status: "generated", reason: "build" },
    { path: "vendor/x.js", status: "vendor", reason: "third party" },
    { path: "src/ok.ts", status: "included", reason: "" },
    { path: "docs/readme.md", status: "doc_only", reason: "docs" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const excludedCount = files.filter((f) => f.status !== "included").length;
  expect(countTotalFiles(digest.excluded_summary), "total files represented should equal total excluded").toBe(excludedCount);
});

// ---------------------------------------------------------------------------
// 2. disposition_override_proposals
// ---------------------------------------------------------------------------

test("computeScopePreDigest emits proposal for build-output file with status included", async () => {
  const files = [
    { path: "dist/index.js", status: "included", reason: "" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const proposals = digest.disposition_override_proposals;
  const distProposal = proposals.find((p) => p.path === "dist/index.js");
  expect(distProposal, "should propose override for dist/ file with included status").toBeTruthy();
  expect(distProposal!.proposed_status).toBe("generated");
});

test("computeScopePreDigest emits proposal for vendor file with status included", async () => {
  const files = [
    { path: "vendor/lib.js", status: "included", reason: "" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const proposals = digest.disposition_override_proposals;
  const vendorProposal = proposals.find((p) => p.path === "vendor/lib.js");
  expect(vendorProposal, "should propose override for vendor/ file with included status").toBeTruthy();
  expect(vendorProposal!.proposed_status).toBe("vendor");
});

test("computeScopePreDigest does NOT propose override for correctly excluded file", async () => {
  const files = [
    { path: "dist/index.js", status: "generated", reason: "build output" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const proposals = digest.disposition_override_proposals;
  expect(proposals.length, "correctly excluded file should not appear in proposals").toBe(0);
});

test("computeScopePreDigest does NOT propose override for clean included source file", async () => {
  const files = [
    { path: "src/app.ts", status: "included", reason: "" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  expect(digest.disposition_override_proposals.length, "clean included source file should not appear in proposals").toBe(0);
});

// ---------------------------------------------------------------------------
// 3. lens_propositions (note 1: canonical table, one disposition per lens)
// ---------------------------------------------------------------------------

const QUESTION_LENSES = ["behavior", "security", "architecture", "performance", "operability", "config_deployment", "tests"];

test("computeScopePreDigest emits one proposition per canonical lens", async () => {
  const bundle = makeBaseBundle({ unit_manifest: { units: [] } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  // Pin the actual seven names, not the prior per-file lens taxonomy.
  const lenses = digest.lens_propositions.map((p) => p.lens);
  expect([...lenses].sort()).toEqual([...QUESTION_LENSES].sort());
  for (const p of digest.lens_propositions) {
    expect(["recommend_include", "recommend_exclude"].includes(p.disposition), `disposition must express applicability, got ${p.disposition}`).toBeTruthy();
    expect(p.reason, "every proposition has a reason").toBeTruthy();
  }
});

test("computeScopePreDigest recommends excluding operability when no network-surface units", async () => {
  const bundle = makeBaseBundle({ unit_manifest: { units: [] } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  const operability = digest.lens_propositions.find((p) => p.lens === "operability");
  expect(operability?.disposition).toBe("recommend_exclude");
});

test("Tests remains inapplicable when the only candidate is outside admitted source", async () => {
  const bundle = questionScopeFixture(["docs/resume.md"]);
  bundle.file_disposition!.files[0]!.status = "doc_only";
  const digest = await computeScopePreDigest(bundle, "/repo");
  const tests = digest.lens_propositions.find((p) => p.lens === "tests");
  expect(tests?.disposition).toBe("recommend_exclude");
  const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot" });
  expect(plan.lens_decisions).toContainEqual(expect.objectContaining({ lens: "tests", decision: "not_applicable" }));
});

test("an operation with no detected tests can receive a Tests assignment through the recommended scope", async () => {
  const entry = "src/resume.ts";
  const bundle = questionScopeFixture([entry]);
  const digest = await computeScopePreDigest(bundle, "/repo");
  const include = digest.lens_propositions.filter(row => row.disposition === "recommend_include").map(row => row.lens);
  expect.soft(include).toContain("tests");
  bundle.intent_checkpoint!.lens_selection = { include };
  bundle.review_plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot" });
  const bindings = await questionWorkloadBindings(bundle, "/repo", [], [{ path: entry, fingerprint: entry, line_count: 1 }]);
  const coverage = bindings.find(binding => binding.question.lens === "tests");
  expect(coverage?.assignment.suggested_sources).toEqual([{ path: entry }]);

  bundle.intent_checkpoint!.lens_selection = { exclude: ["tests"], omission_reasons: { tests: "Reviewed separately" } };
  const narrowed = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot" });
  expect(narrowed.questions.some(question => question.lens === "tests")).toBe(false);
  expect(narrowed.lens_decisions).toContainEqual({ lens: "tests", decision: "excluded", reason: "Reviewed separately" });
});

test("computeScopePreDigest recommends lenses from applicable source instead of fixed mandatory lenses", async () => {
  const paths = ["src/routes/job.ts", "worker/background.ts", "tests/job.test.ts", "deploy.yaml"];
  const empty = await computeScopePreDigest(makeBaseBundle(), "/repo");
  expect(empty.lens_propositions.map(({ disposition }) => disposition)).toEqual(
    QUESTION_LENSES.map(() => "recommend_exclude"),
  );
  const bundle = questionScopeFixture(paths);
  bundle.surface_manifest = { surfaces: [
    { id: "job", kind: "interface", exposure: "network", entrypoint: paths[0] },
    { id: "worker", kind: "background", entrypoint: paths[1] },
  ] };
  const applicable = await computeScopePreDigest(bundle, "/repo");
  expect(applicable.lens_propositions.map(({ disposition }) => disposition)).toEqual(
    QUESTION_LENSES.map(() => "recommend_include"),
  );
});

// ---------------------------------------------------------------------------
// docsN-5: mis-scope smells reach the confirm-intent pre-digest
// ---------------------------------------------------------------------------

test("computeScopePreDigest carries mis_scope_smells for a subdirectory of a git repo", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "audit-tools-misscope-"));
  try {
    const repo = join(tmpRoot, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });

    const digest = await computeScopePreDigest(makeBaseBundle(), sub);
    expect(
      digest.mis_scope_smells.some((s) => s.includes("git repository")),
      `expected an ancestor-git-root smell, got: ${JSON.stringify(digest.mis_scope_smells)}`,
    ).toBeTruthy();

    // The repo root itself IS the git root → no ancestor-git smell.
    const rootDigest = await computeScopePreDigest(makeBaseBundle(), repo);
    expect(rootDigest.mis_scope_smells.some((s) => s.includes("git repository"))).toBe(false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// COR-2e048b54: buildExcludedSummary majority-of-1 drop regression
// ---------------------------------------------------------------------------

test("COR-2e048b54: excluded-summary includes ALL files when every file in a prefix group has a unique status+reason", async () => {
  // Before the fix: when majorityCount===1 and oddballs.length>0, the "majority"
  // file (1 file) was silently dropped. After the fix all files are emitted individually.
  const files = [
    { path: "src/a.ts", status: "excluded", reason: "reason-a" },
    { path: "src/b.ts", status: "excluded", reason: "reason-b" },
    { path: "src/c.ts", status: "excluded", reason: "reason-c" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  // All three files have unique status+reason → majorityCount===1 → must emit all 3 individually.
  expect(countTotalFiles(digest.excluded_summary), "all 3 files must appear in excluded_summary (COR-2e048b54 drop regression)").toBe(3);
  const paths = digest.excluded_summary.filter((r) => "path" in r).map((r) => r.path).sort();
  expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"].sort());
});

test("COR-2e048b54: excluded-summary includes the majority file when it is a genuine majority of 2+", async () => {
  // 3 files: 2 share "excluded|majority-reason", 1 is an oddball.
  // majorityCount===2 → aggregate row for 2 files + individual row for the oddball.
  const files = [
    { path: "src/a.ts", status: "excluded", reason: "majority-reason" },
    { path: "src/b.ts", status: "excluded", reason: "majority-reason" },
    { path: "src/c.ts", status: "excluded", reason: "different-reason" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = await computeScopePreDigest(bundle, "/repo");

  expect(countTotalFiles(digest.excluded_summary), "aggregate + oddball must total 3 files").toBe(3);
  const aggregateRows = digest.excluded_summary.filter(
    (r): r is AggregatedExcludedRow => "prefix" in r && r.prefix === "src",
  );
  expect(aggregateRows.length, "should produce 1 aggregate row for the 2-file majority").toBe(1);
  expect(aggregateRows[0].file_count).toBe(2);
  const individualRows = digest.excluded_summary.filter((r) => "path" in r);
  expect(individualRows.length, "oddball should appear as an individual row").toBe(1);
  expect(individualRows[0].path).toBe("src/c.ts");
});

// ---------------------------------------------------------------------------
// 3b. scope-rule outcomes — a SKIPPED rule must reach the operator
// ---------------------------------------------------------------------------

test("computeScopePreDigest surfaces a skipped scope rule (untracked root guard) with its guard branch", async () => {
  // The shape `buildFileDisposition` persists when the untracked rule's root
  // guard fires: the per-file records are UNCHANGED (the rule was skipped, so
  // nothing was re-classified) and the summary carries the skip. Before the
  // fix, the pre-digest was built from the per-file records alone, so this
  // state was byte-identical to "the rule ran and matched nothing".
  const files = [
    { path: "src/a.ts", status: "included", reason: "Default included source or config artifact." },
    { path: "src/b.ts", status: "included", reason: "Default included source or config artifact." },
  ];
  const bundle = makeBaseBundle({
    file_disposition: {
      files,
      untracked: {
        applied: false,
        ignored_count: 2,
        skipped_reason:
          "untracked rule skipped: every included candidate is untracked (the repository has no tracked files in the audit scope)",
        guard_branch: "root_untracked",
      },
    },
  });

  const digest = await computeScopePreDigest(bundle, "/repo");
  const untracked = digest.scope_rules!.find((r) => r.rule === "untracked");

  expect(untracked, "the untracked rule must have a row even though it was skipped").toBeDefined();
  expect(untracked!.applied, "a guard-skipped rule is not applied").toBe(false);
  expect(untracked!.guard_branch).toBe("root_untracked");
  expect(
    untracked!.skipped_reason?.includes("no tracked files"),
    `skipped_reason must carry the rule's own explanation, got: ${untracked!.skipped_reason}`,
  ).toBeTruthy();
});

test("computeScopePreDigest reports a rule with no record as skipped, never as applied", async () => {
  // A heuristics-only disposition (`buildFileDisposition` with no root) carries
  // no summaries at all. Reporting it as applied would be a false claim that a
  // rule ran; omitting the row would read as "the rule ran clean".
  const bundle = makeBaseBundle({
    file_disposition: {
      files: [{ path: "src/a.ts", status: "included", reason: "Default included source or config artifact." }],
    },
  });

  const digest = await computeScopePreDigest(bundle, "/repo");
  expect(digest.scope_rules!.map((r) => r.rule)).toEqual(["vcs_ignore", "untracked"]);
  for (const rule of digest.scope_rules!) {
    expect(rule.applied, `${rule.rule} has no record and must not claim it ran`).toBe(false);
    expect(rule.skipped_reason, `${rule.rule} must state why it has no outcome`).toBeTruthy();
  }
});

test("computeScopePreDigest counts each rule's delivered exclusions off the per-file records", async () => {
  // The rule summary's `ignored_count` is the RAW match count (2, including a
  // file the higher-precedence gitignore rule already claimed); the DELIVERED
  // count is what the per-file records actually hold for that reason (1). Both
  // are surfaced because they disagree exactly when the two rules interact.
  const files = [
    { path: "src/kept.ts", status: "included", reason: "Default included source or config artifact." },
    { path: "build/out.js", status: "excluded", reason: "vcs_ignored" },
    { path: "tmp/scratch.ts", status: "excluded", reason: "untracked" },
  ];
  const bundle = makeBaseBundle({
    file_disposition: {
      files,
      vcs_ignore: { applied: true, ignored_count: 1 },
      untracked: { applied: true, ignored_count: 2 },
    },
  });

  const digest = await computeScopePreDigest(bundle, "/repo");
  const untracked = digest.scope_rules!.find((r) => r.rule === "untracked")!;
  expect(untracked.matched_count, "raw match count comes from the rule summary").toBe(2);
  expect(untracked.excluded_count, "delivered count comes from the per-file records").toBe(1);
});

// ---------------------------------------------------------------------------
// 4. confirmed disposition overrides in question planning
// ---------------------------------------------------------------------------

function questionScopeFixture(paths: string[]) {
  return makeBaseBundle({
    repo_manifest: {
      repository: { name: "fixture" }, generated_at: "x",
      files: paths.map(path => ({ path, language: "typescript", size_bytes: 500, hash: path })),
    },
    file_disposition: { files: paths.map(path => ({ path, status: "included" })) },
    unit_manifest: { units: paths.map((path, index) => ({
      unit_id: "unit-" + index, name: "u" + index, files: [path], required_lenses: [],
    })) },
    surface_manifest: { surfaces: paths.map((path, index) => ({
      id: "surface-" + index, kind: "interface", entrypoint: path,
    })) },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1", confirmed_at: "x", confirmed_by: "host",
      scope_summary: "test", intent_summary: "test",
    },
  });
}

test.each(["src/generated", "src/generated/", "src\\generated", "src\\generated\\"])(
  "question coverage and structural context share disposition prefix matching for %s", (path) => {
    const paths = ["src/generated/a.ts", "src/generated/nested/b.ts", "src/generated-other/c.ts"];
    const bundle = questionScopeFixture(paths);
    bundle.intent_checkpoint!.disposition_overrides = [{ path, status: "generated", reason: "generated output" }];
    expect(reviewSourceScope(bundle).allowedSourcePaths).toEqual([paths[2]]);
    const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot" });
    expect(plan.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface_id: "surface-0", reason: "generated output" }),
      expect.objectContaining({ surface_id: "surface-1", reason: "generated output" }),
    ]));
    expect(plan.questions.some(question => question.source_dependencies.some(dep => dep.key === paths[2]))).toBe(true);
    expect(plan.questions.every(question => question.source_dependencies.every(dep =>
      dep.kind !== "source" || dep.key === paths[2],
    ))).toBe(true);
    const review = renderSharedStructuralContext(bundle, 1);
    bundle.risk_register = { items: paths.map((_, index) => ({
      unit_id: "unit-" + index, risk_score: 100 - index, signals: [],
    })) };
    const rankedReview = renderSharedStructuralContext(bundle, 1);
    for (const prompt of [review, rankedReview]) {
      const starts = prompt.split("### Starting points (orient, then roam)")[1]!;
      expect(starts).toContain("**unit-2**");
      expect(starts).not.toMatch(/\*\*unit-[01]\*\*|src\/generated\//u);
      expect(starts).toContain("Excluded units are dependency context only");
    }
    expect(review).toContain("unit-0 [excluded: generated output]");
    expect(review).toContain("unit-1 [excluded: generated output]");
    expect(review).toContain("unit-2 [in scope]");
  },
);

test.each(["included", "excluded", "generated", "vendor", "binary", "doc_only"] as const)(
  "question scope preserves first-match %s and exact file matching", (status) => {
    const paths = ["src/app.ts", "src/app.tsx"];
    const bundle = questionScopeFixture(paths);
    bundle.intent_checkpoint!.disposition_overrides = [
      { path: paths[0], status, reason: "first match" },
      { path: paths[0], status: status === "included" ? "excluded" : "included", reason: "later match" },
    ];
    const scope = reviewSourceScope(bundle);
    expect(scope.allowedSourcePaths).toEqual(status === "included" ? paths : [paths[1]]);
    expect(scope.allowedContractPaths).toEqual(status === "included" || status === "doc_only" ? paths : [paths[1]]);
  },
);

test("IntentCheckpoint with disposition_overrides round-trips through JSON without loss", () => {
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test scope",
    intent_summary: "full-audit",
    disposition_overrides: [
      { path: "dist/index.js", status: "generated", reason: "build output" },
      { path: "vendor/lib.js", status: "vendor", reason: "third party" },
    ],
  };
  const roundTripped = JSON.parse(JSON.stringify(checkpoint));
  expect(roundTripped.disposition_overrides).toEqual(checkpoint.disposition_overrides);
});

test("IntentCheckpoint with lens_selection round-trips through JSON without loss", () => {
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test scope",
    intent_summary: "full-audit",
    lens_selection: { include: ["security", "correctness"], exclude: ["performance"] },
  };
  const roundTripped = JSON.parse(JSON.stringify(checkpoint));
  expect(roundTripped.lens_selection).toEqual(checkpoint.lens_selection);
});

test("IntentCheckpoint without optional fields is still valid (backward compat)", () => {
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test scope",
    intent_summary: "full-audit",
  };
  // Should not throw; just needs to be a valid object
  const roundTripped = JSON.parse(JSON.stringify(checkpoint));
  expect(roundTripped.schema_version).toBe("intent-checkpoint/v1");
  expect(roundTripped.disposition_overrides).toBe(undefined);
  expect(roundTripped.lens_selection).toBe(undefined);
});
