import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runPlanningExecutor, interpretFreeFormIntent } = await import(
  "../src/orchestrator/planningExecutors.ts"
);

const here = dirname(fileURLToPath(import.meta.url));
// The audit-code package root has a package.json with a "test" script,
// so discoverProjectCommands will return a test command when given this root.
const packageRoot = join(here, "..");
// A non-existent root means discoverProjectCommands returns {} (no test script),
// so buildRuntimeValidationTasks gets command=undefined → tasks: [].
const nonExistentRoot = join(here, "__nonexistent_root__");

// ---------------------------------------------------------------------------
// Minimal valid structure-artifact bundle
// ---------------------------------------------------------------------------

function makeFullBundle() {
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
  };
}

// ---------------------------------------------------------------------------
// Guard: missing repo_manifest
// ---------------------------------------------------------------------------

test("runPlanningExecutor throws when repo_manifest is absent", async () => {
  await assert.rejects(
    () => runPlanningExecutor({}, "/tmp"),
    /cannot run planning executor without repo_manifest/i,
  );
});

// ---------------------------------------------------------------------------
// Guard: missing structure artifacts (each individually)
// ---------------------------------------------------------------------------

test("runPlanningExecutor throws when file_disposition is missing", async () => {
  const bundle = {
    repo_manifest: makeFullBundle().repo_manifest,
    // no file_disposition
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
  };
  await assert.rejects(
    () => runPlanningExecutor(bundle, "/tmp"),
    /cannot run planning executor without current structure artifacts/i,
  );
});

test("runPlanningExecutor throws when unit_manifest is missing", async () => {
  const bundle = {
    repo_manifest: makeFullBundle().repo_manifest,
    file_disposition: { files: [] },
    // no unit_manifest
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
  };
  await assert.rejects(
    () => runPlanningExecutor(bundle, "/tmp"),
    /cannot run planning executor without current structure artifacts/i,
  );
});

test("runPlanningExecutor throws when surface_manifest is missing", async () => {
  const bundle = {
    repo_manifest: makeFullBundle().repo_manifest,
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    // no surface_manifest
    critical_flows: { flows: [] },
    risk_register: { items: [] },
  };
  await assert.rejects(
    () => runPlanningExecutor(bundle, "/tmp"),
    /cannot run planning executor without current structure artifacts/i,
  );
});

test("runPlanningExecutor throws when critical_flows is missing", async () => {
  const bundle = {
    repo_manifest: makeFullBundle().repo_manifest,
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    // no critical_flows
    risk_register: { items: [] },
  };
  await assert.rejects(
    () => runPlanningExecutor(bundle, "/tmp"),
    /cannot run planning executor without current structure artifacts/i,
  );
});

test("runPlanningExecutor throws when risk_register is missing", async () => {
  const bundle = {
    repo_manifest: makeFullBundle().repo_manifest,
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    // no risk_register
  };
  await assert.rejects(
    () => runPlanningExecutor(bundle, "/tmp"),
    /cannot run planning executor without current structure artifacts/i,
  );
});

// ---------------------------------------------------------------------------
// Zero-task branch: runtime_validation_report omitted when no tasks produced
// ---------------------------------------------------------------------------

test("runPlanningExecutor omits runtime_validation_report when no tasks are produced", async () => {
  // nonExistentRoot → discoverProjectCommands returns {} → no test command
  // → buildRuntimeValidationTasks({ command: undefined }) → { tasks: [] }
  const result = await runPlanningExecutor(makeFullBundle(), nonExistentRoot);

  assert.strictEqual(
    result.updated.runtime_validation_report,
    undefined,
    "runtime_validation_report must be undefined when tasks.length === 0",
  );
  assert.ok(
    !result.artifacts_written.includes("runtime_validation_report.json"),
    "runtime_validation_report.json must not appear in artifacts_written when no tasks",
  );
});

// ---------------------------------------------------------------------------
// Positive case: runtime_validation_report present when tasks are produced
// ---------------------------------------------------------------------------

test("runPlanningExecutor includes runtime_validation_report when tasks are present", async () => {
  // packageRoot has a package.json with a "test" script, so discoverProjectCommands
  // returns { test: ["npm", "test"] }. We need at least one high-risk unit so
  // buildRuntimeValidationTasks produces tasks.
  const bundle = {
    ...makeFullBundle(),
    unit_manifest: {
      units: [
        {
          unit_id: "auth",
          name: "auth",
          files: ["src/auth.ts"],
          risk_score: 8,
          required_lenses: ["security"],
        },
      ],
    },
  };

  const result = await runPlanningExecutor(bundle, packageRoot);

  assert.notStrictEqual(
    result.updated.runtime_validation_report,
    undefined,
    "runtime_validation_report must be defined when tasks.length > 0",
  );
  assert.ok(
    result.artifacts_written.includes("runtime_validation_report.json"),
    "runtime_validation_report.json must appear in artifacts_written when tasks are present",
  );
});

// ---------------------------------------------------------------------------
// Delta scope: progress_summary contains scope message
// ---------------------------------------------------------------------------

test("runPlanningExecutor includes delta scope summary in progress_summary", async () => {
  const scope = {
    mode: /** @type {"delta"} */ ("delta"),
    since: "abc123",
    seed_files: ["src/a.ts"],
    expanded_files: ["src/b.ts"],
    budget: { max_files: 200 },
  };

  const result = await runPlanningExecutor(
    makeFullBundle(),
    nonExistentRoot,
    {},
    undefined,
    scope,
  );

  assert.ok(
    result.progress_summary.includes("Delta scope since abc123"),
    `progress_summary should contain 'Delta scope since abc123' but was: ${result.progress_summary}`,
  );
  assert.ok(
    result.progress_summary.includes("1 changed file"),
    `progress_summary should mention seed_files count (1) but was: ${result.progress_summary}`,
  );
  assert.ok(
    result.progress_summary.includes("1 graph neighbour"),
    `progress_summary should mention expanded_files count (1) but was: ${result.progress_summary}`,
  );
});

// ---------------------------------------------------------------------------
// Helpers for disposition_overrides and intent-related tests
// ---------------------------------------------------------------------------

/**
 * Build a full bundle with specific files in file_disposition and repo_manifest.
 * Each entry: { path, status }. Default status "included".
 */
function makeBundleWithFiles(fileEntries) {
  const files = fileEntries.map(({ path, status = "included", reason }) => ({
    path,
    status,
    ...(reason ? { reason } : {}),
  }));
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: fileEntries.map(({ path }) => ({ path })),
    },
    file_disposition: { files },
    unit_manifest: {
      units: [
        {
          unit_id: "unit-1",
          name: "unit-1",
          files: fileEntries.map(({ path }) => path),
          risk_score: 5,
          required_lenses: ["correctness", "security"],
        },
      ],
    },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
  };
}

/**
 * Build a line index giving each file 100 lines (above isTrivialAuditPath's 0-line cutoff).
 */
function makeLineIndex(fileEntries, lines = 100) {
  return Object.fromEntries(fileEntries.map(({ path }) => [path, lines]));
}

// ---------------------------------------------------------------------------
// disposition_overrides: exact-path match
// ---------------------------------------------------------------------------

test("disposition_overrides exact-path match excludes the file from audit tasks", async () => {
  const fileEntries = [
    { path: "src/gen.ts", status: "included" },
    { path: "src/real.ts", status: "included" },
  ];
  const bundle = makeBundleWithFiles(fileEntries);
  bundle.intent_checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test",
    intent_summary: "test",
    disposition_overrides: [
      { path: "src/gen.ts", status: "generated", reason: "codegen" },
    ],
  };

  const lineIndex = makeLineIndex(fileEntries);
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const taskPaths = result.updated.audit_tasks.flatMap((t) => t.file_paths);
  assert.ok(!taskPaths.includes("src/gen.ts"), "overridden file must not appear in audit tasks");
  assert.ok(taskPaths.includes("src/real.ts"), "non-overridden file must still appear");
});

// ---------------------------------------------------------------------------
// disposition_overrides: prefix match
// ---------------------------------------------------------------------------

test("disposition_overrides prefix match excludes all files under the prefix", async () => {
  const fileEntries = [
    { path: "vendor/a.ts", status: "included" },
    { path: "vendor/b.ts", status: "included" },
    { path: "src/main.ts", status: "included" },
  ];
  const bundle = makeBundleWithFiles(fileEntries);
  bundle.intent_checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test",
    intent_summary: "test",
    disposition_overrides: [
      { path: "vendor", status: "vendor", reason: "third-party" },
    ],
  };

  const lineIndex = makeLineIndex(fileEntries);
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const taskPaths = result.updated.audit_tasks.flatMap((t) => t.file_paths);
  assert.ok(!taskPaths.includes("vendor/a.ts"), "vendor/a.ts must be excluded via prefix");
  assert.ok(!taskPaths.includes("vendor/b.ts"), "vendor/b.ts must be excluded via prefix");
  assert.ok(taskPaths.includes("src/main.ts"), "src/main.ts must not be excluded");
});

// ---------------------------------------------------------------------------
// disposition_overrides: no-op when absent
// ---------------------------------------------------------------------------

test("disposition_overrides absent: initializeCoverageFromPlan receives original file_disposition", async () => {
  const fileEntries = [{ path: "src/a.ts", status: "included" }];
  const bundle = makeBundleWithFiles(fileEntries);
  // No intent_checkpoint at all
  const lineIndex = makeLineIndex(fileEntries);
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const taskPaths = result.updated.audit_tasks.flatMap((t) => t.file_paths);
  assert.ok(taskPaths.includes("src/a.ts"), "file must appear in tasks when no overrides");
});

test("disposition_overrides empty array is a no-op", async () => {
  const fileEntries = [{ path: "src/a.ts", status: "included" }];
  const bundle = makeBundleWithFiles(fileEntries);
  bundle.intent_checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test",
    intent_summary: "test",
    disposition_overrides: [],
  };
  const lineIndex = makeLineIndex(fileEntries);
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const taskPaths = result.updated.audit_tasks.flatMap((t) => t.file_paths);
  assert.ok(taskPaths.includes("src/a.ts"), "file must appear in tasks when overrides is empty");
});

// ---------------------------------------------------------------------------
// interpretFreeFormIntent: keyword → lens mapping
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent: security keywords map to security lens", () => {
  const lenses = interpretFreeFormIntent("focus on auth and security issues");
  assert.ok(lenses.includes("security"), "should include security lens");
});

test("interpretFreeFormIntent: data integrity keywords map to data_integrity lens", () => {
  const lenses = interpretFreeFormIntent("check data integrity and validation");
  assert.ok(lenses.includes("data_integrity"), "should include data_integrity lens");
});

test("interpretFreeFormIntent: empty string returns empty array", () => {
  const lenses = interpretFreeFormIntent("");
  assert.deepStrictEqual(lenses, [], "empty input must return empty array");
});

test("interpretFreeFormIntent: undefined-like blank input returns empty array", () => {
  const lenses = interpretFreeFormIntent("   ");
  assert.deepStrictEqual(lenses, [], "whitespace-only input must return empty array");
});

test("interpretFreeFormIntent: performance keywords map to performance lens", () => {
  const lenses = interpretFreeFormIntent("improve perf and latency");
  assert.ok(lenses.includes("performance"), "should include performance lens for perf/latency");
});

// ---------------------------------------------------------------------------
// free_form_intent end-to-end: security tasks get higher priority
// ---------------------------------------------------------------------------

test("free_form_intent='security audit' promotes security lens tasks in runPlanningExecutor", async () => {
  const fileEntries = [{ path: "src/auth.ts", status: "included" }];
  const bundle = makeBundleWithFiles(fileEntries);
  bundle.intent_checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test",
    intent_summary: "test",
    free_form_intent: "security audit",
  };

  const lineIndex = makeLineIndex(fileEntries);
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  const secTasks = result.updated.audit_tasks.filter((t) => t.lens === "security");
  assert.ok(secTasks.length > 0, "should produce security tasks");
  // Without external signal, security base priority is 'medium'; boosted → 'high'
  for (const task of secTasks) {
    assert.strictEqual(task.priority, "high", `security task should be 'high' after intent boost, got '${task.priority}'`);
  }
});

test("free_form_intent boost does not affect unrelated lens tasks", async () => {
  const fileEntries = [{ path: "src/auth.ts", status: "included" }];
  const bundle = makeBundleWithFiles(fileEntries);
  bundle.intent_checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test",
    intent_summary: "test",
    free_form_intent: "security audit",
  };

  const lineIndex = makeLineIndex(fileEntries);
  const result = await runPlanningExecutor(bundle, nonExistentRoot, lineIndex);
  // correctness is not a security keyword → should not be boosted above base level
  const corrTasks = result.updated.audit_tasks.filter((t) => t.lens === "correctness");
  if (corrTasks.length > 0) {
    // base correctness priority without signal is 'low', not boosted
    assert.strictEqual(corrTasks[0].priority, "low", "correctness task should stay low priority");
  }
});
