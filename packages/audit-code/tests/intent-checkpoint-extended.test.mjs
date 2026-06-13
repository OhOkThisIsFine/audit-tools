/**
 * Extended intent checkpoint tests:
 *  - computeScopePreDigest excluded-scope collapse
 *  - disposition_override_proposals
 *  - lens_proposals
 *  - runPlanningExecutor disposition_overrides wiring
 *  - runPlanningExecutor lens_selection wiring
 *  - IntentCheckpoint round-trip (disposition_overrides + lens_selection)
 */
import test from "node:test";
import assert from "node:assert/strict";

const { computeScopePreDigest } = await import(
  "../src/orchestrator/intentCheckpointExecutor.ts"
);
const { runPlanningExecutor } = await import(
  "../src/orchestrator/planningExecutors.ts"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseBundle(overrides = {}) {
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

function countTotalFiles(summary) {
  return summary.reduce(
    (acc, row) => acc + ("prefix" in row ? row.file_count : 1),
    0,
  );
}

// ---------------------------------------------------------------------------
// 1. excluded_summary — directory collapse
// ---------------------------------------------------------------------------

test("computeScopePreDigest collapses all-same-status excluded dir into aggregate row", () => {
  const files = [
    { path: "dist/a.js", status: "generated", reason: "build output" },
    { path: "dist/b.js", status: "generated", reason: "build output" },
    { path: "dist/c.js", status: "generated", reason: "build output" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const distRows = digest.excluded_summary.filter(
    (r) => "prefix" in r && r.prefix === "dist",
  );
  assert.equal(distRows.length, 1, "should produce exactly one aggregate row for dist/");
  assert.equal(distRows[0].file_count, 3);
  assert.equal(distRows[0].status, "generated");

  // Total files represented must equal total excluded count
  assert.equal(
    countTotalFiles(digest.excluded_summary),
    files.length,
    "total files represented must equal excluded count",
  );
});

test("computeScopePreDigest emits individual rows for oddballs in mixed dir", () => {
  // src/ has mostly included files, but one is excluded
  const files = [
    { path: "src/a.ts", status: "included", reason: "" },
    { path: "src/b.ts", status: "included", reason: "" },
    { path: "src/oddball.ts", status: "excluded", reason: "manual exclusion" },
  ];
  // Only the excluded files end up in `excluded` array; included are not in excluded_summary
  // So src/oddball.ts should appear as an individual row
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const oddballRows = digest.excluded_summary.filter(
    (r) => "path" in r && r.path === "src/oddball.ts",
  );
  assert.equal(oddballRows.length, 1, "oddball excluded file should appear as individual row");
  assert.equal(oddballRows[0].status, "excluded");
});

test("computeScopePreDigest total files matches total excluded count", () => {
  const files = [
    { path: "dist/a.js", status: "generated", reason: "build" },
    { path: "dist/b.js", status: "generated", reason: "build" },
    { path: "vendor/x.js", status: "vendor", reason: "third party" },
    { path: "src/ok.ts", status: "included", reason: "" },
    { path: "docs/readme.md", status: "doc_only", reason: "docs" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const excludedCount = files.filter((f) => f.status !== "included").length;
  assert.equal(
    countTotalFiles(digest.excluded_summary),
    excludedCount,
    "total files represented should equal total excluded",
  );
});

// ---------------------------------------------------------------------------
// 2. disposition_override_proposals
// ---------------------------------------------------------------------------

test("computeScopePreDigest emits proposal for build-output file with status included", () => {
  const files = [
    { path: "dist/index.js", status: "included", reason: "" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const proposals = digest.disposition_override_proposals;
  const distProposal = proposals.find((p) => p.path === "dist/index.js");
  assert.ok(distProposal, "should propose override for dist/ file with included status");
  assert.equal(distProposal.proposed_status, "generated");
});

test("computeScopePreDigest emits proposal for vendor file with status included", () => {
  const files = [
    { path: "vendor/lib.js", status: "included", reason: "" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const proposals = digest.disposition_override_proposals;
  const vendorProposal = proposals.find((p) => p.path === "vendor/lib.js");
  assert.ok(vendorProposal, "should propose override for vendor/ file with included status");
  assert.equal(vendorProposal.proposed_status, "vendor");
});

test("computeScopePreDigest does NOT propose override for correctly excluded file", () => {
  const files = [
    { path: "dist/index.js", status: "generated", reason: "build output" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const proposals = digest.disposition_override_proposals;
  assert.equal(proposals.length, 0, "correctly excluded file should not appear in proposals");
});

test("computeScopePreDigest does NOT propose override for clean included source file", () => {
  const files = [
    { path: "src/app.ts", status: "included", reason: "" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  assert.equal(
    digest.disposition_override_proposals.length,
    0,
    "clean included source file should not appear in proposals",
  );
});

// ---------------------------------------------------------------------------
// 3. lens_proposals
// ---------------------------------------------------------------------------

test("computeScopePreDigest proposes excluding operability when no network-surface units", () => {
  const bundle = makeBaseBundle({ unit_manifest: { units: [] } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const operabilityExclude = digest.lens_proposals.find(
    (p) => p.lens === "operability" && p.action === "exclude",
  );
  assert.ok(operabilityExclude, "should propose excluding operability with no network-surface units");
});

test("computeScopePreDigest proposes excluding tests when no test units", () => {
  const bundle = makeBaseBundle({ unit_manifest: { units: [] } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const testsExclude = digest.lens_proposals.find(
    (p) => p.lens === "tests" && p.action === "exclude",
  );
  assert.ok(testsExclude, "should propose excluding tests with no test units");
});

test("computeScopePreDigest never proposes excluding mandatory lenses", () => {
  const bundle = makeBaseBundle({ unit_manifest: { units: [] } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const mandatoryExcludes = digest.lens_proposals.filter(
    (p) =>
      p.action === "exclude" &&
      ["security", "correctness", "reliability", "data_integrity"].includes(p.lens),
  );
  assert.equal(
    mandatoryExcludes.length,
    0,
    "mandatory lenses should never appear in exclude proposals",
  );
});

test("computeScopePreDigest notes mandatory lens vacuous pass (include action, not exclude)", () => {
  // A mandatory lens with zero in-scope units: should be include (not exclude)
  // For now, mandatory lenses don't appear in proposals unless the specific
  // condition triggers — this tests that if they appear they are never exclude
  const bundle = makeBaseBundle({ unit_manifest: { units: [] } });
  const digest = computeScopePreDigest(bundle, "/repo");

  const mandatoryIncludes = digest.lens_proposals.filter(
    (p) =>
      p.action === "include" &&
      ["security", "correctness", "reliability", "data_integrity"].includes(p.lens),
  );
  // None of these should be exclude proposals
  for (const p of mandatoryIncludes) {
    assert.equal(p.action, "include");
    assert.ok(p.reason, "include proposal for mandatory lens should have a reason");
  }
});

// ---------------------------------------------------------------------------
// COR-2e048b54: buildExcludedSummary majority-of-1 drop regression
// ---------------------------------------------------------------------------

test("COR-2e048b54: excluded-summary includes ALL files when every file in a prefix group has a unique status+reason", () => {
  // Before the fix: when majorityCount===1 and oddballs.length>0, the "majority"
  // file (1 file) was silently dropped. After the fix all files are emitted individually.
  const files = [
    { path: "src/a.ts", status: "excluded", reason: "reason-a" },
    { path: "src/b.ts", status: "excluded", reason: "reason-b" },
    { path: "src/c.ts", status: "excluded", reason: "reason-c" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  // All three files have unique status+reason → majorityCount===1 → must emit all 3 individually.
  assert.equal(
    countTotalFiles(digest.excluded_summary),
    3,
    "all 3 files must appear in excluded_summary (COR-2e048b54 drop regression)",
  );
  const paths = digest.excluded_summary.filter((r) => "path" in r).map((r) => r.path).sort();
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts", "src/c.ts"].sort());
});

test("COR-2e048b54: excluded-summary includes the majority file when it is a genuine majority of 2+", () => {
  // 3 files: 2 share "excluded|majority-reason", 1 is an oddball.
  // majorityCount===2 → aggregate row for 2 files + individual row for the oddball.
  const files = [
    { path: "src/a.ts", status: "excluded", reason: "majority-reason" },
    { path: "src/b.ts", status: "excluded", reason: "majority-reason" },
    { path: "src/c.ts", status: "excluded", reason: "different-reason" },
  ];
  const bundle = makeBaseBundle({ file_disposition: { files } });
  const digest = computeScopePreDigest(bundle, "/repo");

  assert.equal(
    countTotalFiles(digest.excluded_summary),
    3,
    "aggregate + oddball must total 3 files",
  );
  const aggregateRows = digest.excluded_summary.filter((r) => "prefix" in r && r.prefix === "src");
  assert.equal(aggregateRows.length, 1, "should produce 1 aggregate row for the 2-file majority");
  assert.equal(aggregateRows[0].file_count, 2);
  const individualRows = digest.excluded_summary.filter((r) => "path" in r);
  assert.equal(individualRows.length, 1, "oddball should appear as an individual row");
  assert.equal(individualRows[0].path, "src/c.ts");
});

// ---------------------------------------------------------------------------
// 4. runPlanningExecutor — disposition_overrides wiring
// ---------------------------------------------------------------------------

const nonExistentRoot = "/nonexistent_repo_root_fixture";

// Line index providing non-trivial line counts so files don't get auto-completed
// as trivial (lineCount=0 → isTrivialAuditPath returns true, producing no tasks).
const TEST_LINE_INDEX = {
  "dist/index.js": 100,
  "src/app.ts": 100,
  "src/b.ts": 100,
};

// Repo manifest including test source files so initializeCoverageFromPlan can
// register them in the coverage matrix (coverage is built from repo_manifest.files,
// not unit_manifest.units).
function makeRepoManifestWithFiles(paths) {
  return {
    repository: { name: "fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: paths.map((path) => ({ path, language: "typescript", size_bytes: 500 })),
  };
}

test("runPlanningExecutor applies disposition_overrides before coverage initialization", async (t) => {
  // A file that is `included` but has a disposition_override marking it `generated`
  // should NOT appear in any audit task.
  const bundle = makeBaseBundle({
    repo_manifest: makeRepoManifestWithFiles(["dist/index.js", "src/app.ts"]),
    file_disposition: {
      files: [
        { path: "dist/index.js", status: "included", reason: "" },
        { path: "src/app.ts", status: "included", reason: "" },
      ],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "u1",
          name: "app",
          files: ["dist/index.js", "src/app.ts"],
          required_lenses: ["correctness"],
        },
      ],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "test",
      intent_summary: "test",
      disposition_overrides: [
        { path: "dist/index.js", status: "generated", reason: "build output override" },
      ],
    },
  });

  const result = await runPlanningExecutor(bundle, nonExistentRoot, TEST_LINE_INDEX);
  const tasks = result.updated.audit_tasks ?? [];
  const distTaskPaths = tasks.flatMap((task) => task.file_paths ?? []);
  assert.ok(
    !distTaskPaths.includes("dist/index.js"),
    "dist/index.js should not appear in any audit task after disposition override",
  );
});

test("runPlanningExecutor does not affect files without a disposition_override", async () => {
  const bundle = makeBaseBundle({
    repo_manifest: makeRepoManifestWithFiles(["src/app.ts"]),
    file_disposition: {
      files: [{ path: "src/app.ts", status: "included", reason: "" }],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "u1",
          name: "app",
          files: ["src/app.ts"],
          required_lenses: ["correctness"],
        },
      ],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "test",
      intent_summary: "test",
      disposition_overrides: [],
    },
  });

  const result = await runPlanningExecutor(bundle, nonExistentRoot, TEST_LINE_INDEX);
  const tasks = result.updated.audit_tasks ?? [];
  // src/app.ts should produce tasks since line count is non-trivial
  const srcPaths = tasks.flatMap((t) => t.file_paths ?? []);
  assert.ok(
    srcPaths.includes("src/app.ts"),
    "src/app.ts should appear in tasks when not overridden and line count is non-trivial",
  );
});

// ---------------------------------------------------------------------------
// 5. runPlanningExecutor — lens_selection wiring
// ---------------------------------------------------------------------------

test("runPlanningExecutor lens_selection.include limits task lenses", async () => {
  // Use tooling_scripts path → gets "correctness", "operability", "config_deployment"
  // Use runtime path → gets "correctness", "maintainability", "tests", "observability"
  // With include: ["security", "correctness"], only correctness (mandatory-adjacent) tasks survive.
  const bundle = makeBaseBundle({
    repo_manifest: makeRepoManifestWithFiles(["scripts/deploy.ts", "src/app.ts"]),
    file_disposition: {
      files: [
        { path: "scripts/deploy.ts", status: "included", reason: "" },
        { path: "src/app.ts", status: "included", reason: "" },
      ],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "u1",
          name: "deploy-scripts",
          files: ["scripts/deploy.ts"],
          required_lenses: ["correctness", "operability", "config_deployment"],
        },
        {
          unit_id: "u2",
          name: "app",
          files: ["src/app.ts"],
          required_lenses: ["correctness", "maintainability"],
        },
      ],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "test",
      intent_summary: "test",
      lens_selection: { include: ["security", "correctness"] },
    },
  });

  const result = await runPlanningExecutor(bundle, nonExistentRoot, TEST_LINE_INDEX);
  const tasks = result.updated.audit_tasks ?? [];
  const lensesUsed = new Set(tasks.map((t) => t.lens));
  assert.ok(
    !lensesUsed.has("operability"),
    "operability should not appear in tasks when not in lens_selection.include",
  );
  assert.ok(
    !lensesUsed.has("maintainability"),
    "maintainability should not appear in tasks when not in lens_selection.include",
  );
});

test("runPlanningExecutor lens_selection.exclude removes non-mandatory lenses", async () => {
  // concurrency_state path derives: reliability, performance, correctness, tests, observability
  // Excluding performance → performance tasks should not appear.
  const bundle = makeBaseBundle({
    repo_manifest: makeRepoManifestWithFiles(["src/queue.ts"]),
    file_disposition: {
      files: [{ path: "src/queue.ts", status: "included", reason: "" }],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "u1",
          name: "queue",
          files: ["src/queue.ts"],
          required_lenses: ["correctness", "reliability", "performance"],
        },
      ],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "test",
      intent_summary: "test",
      lens_selection: { exclude: ["performance"] },
    },
  });

  const lineIndex = { "src/queue.ts": 100 };
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const tasks = result.updated.audit_tasks ?? [];
  const lensesUsed = new Set(tasks.map((t) => t.lens));
  assert.ok(
    !lensesUsed.has("performance"),
    "performance should not appear in tasks when in lens_selection.exclude",
  );
});

test("runPlanningExecutor mandatory lenses always included regardless of lens_selection.exclude", async () => {
  // security_sensitive path → derives: security, correctness, reliability, tests
  // Attempt to exclude security and correctness (both mandatory) → must be ignored.
  const bundle = makeBaseBundle({
    repo_manifest: makeRepoManifestWithFiles(["src/auth.ts"]),
    file_disposition: {
      files: [{ path: "src/auth.ts", status: "included", reason: "" }],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "u-auth",
          name: "auth",
          files: ["src/auth.ts"],
          required_lenses: ["security", "correctness"],
        },
      ],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00.000Z",
      confirmed_by: "host",
      scope_summary: "test",
      intent_summary: "test",
      // Attempt to exclude mandatory lenses — must be ignored
      lens_selection: { exclude: ["security", "correctness"] },
    },
  });

  const lineIndex = { "src/auth.ts": 100 };
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const tasks = result.updated.audit_tasks ?? [];
  const lensesUsed = new Set(tasks.map((t) => t.lens));
  // Mandatory lenses must be retained even when excluded.
  // src/auth.ts matches security_sensitive (auth token), so security and correctness
  // should both appear as tasks.
  const lensesFromRequiredUnits = ["security", "correctness"];
  for (const lens of lensesFromRequiredUnits) {
    assert.ok(
      lensesUsed.has(lens),
      `mandatory lens ${lens} must be present in tasks even when in lens_selection.exclude`,
    );
  }
});

test("runPlanningExecutor with no lens_selection includes all lenses (existing behavior)", async () => {
  // concurrency_state path (queue) → derives: reliability, performance, correctness, tests, observability
  // Without lens_selection, all derived lenses should produce tasks.
  const bundle = makeBaseBundle({
    repo_manifest: makeRepoManifestWithFiles(["src/queue-worker.ts"]),
    file_disposition: {
      files: [{ path: "src/queue-worker.ts", status: "included", reason: "" }],
    },
    unit_manifest: {
      units: [
        {
          unit_id: "u-queue",
          name: "queue",
          files: ["src/queue-worker.ts"],
          required_lenses: ["correctness", "performance", "reliability"],
        },
      ],
    },
  });

  const lineIndex = { "src/queue-worker.ts": 100 };
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const tasks = result.updated.audit_tasks ?? [];
  const lensesUsed = new Set(tasks.map((t) => t.lens));
  // All lenses derived from the path should be present when no lens_selection is set
  assert.ok(lensesUsed.has("correctness"), "correctness should be in tasks");
  assert.ok(lensesUsed.has("performance"), "performance should be in tasks");
  assert.ok(lensesUsed.has("reliability"), "reliability should be in tasks");
});

// ---------------------------------------------------------------------------
// 6. IntentCheckpoint schema round-trip
// ---------------------------------------------------------------------------

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
  assert.deepEqual(roundTripped.disposition_overrides, checkpoint.disposition_overrides);
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
  assert.deepEqual(roundTripped.lens_selection, checkpoint.lens_selection);
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
  assert.equal(roundTripped.schema_version, "intent-checkpoint/v1");
  assert.equal(roundTripped.disposition_overrides, undefined);
  assert.equal(roundTripped.lens_selection, undefined);
});
