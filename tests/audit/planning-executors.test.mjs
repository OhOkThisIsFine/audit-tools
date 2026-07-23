import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runPlanningExecutor, interpretFreeFormIntent } = await import("../../src/audit/orchestrator/planningExecutors.ts");

const here = dirname(fileURLToPath(import.meta.url));
// The audit-code package root has a package.json with a "test" script,
// so discoverProjectCommands will return a test command when given this root.
const packageRoot = join(here, "..", "..");
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

  expect(result.updated.runtime_validation_report, "runtime_validation_report must be undefined when tasks.length === 0").toBe(undefined);
  expect(!result.artifacts_written.includes("runtime_validation_report.json"), "runtime_validation_report.json must not appear in artifacts_written when no tasks").toBeTruthy();
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

  expect(result.updated.runtime_validation_report, "runtime_validation_report must be defined when tasks.length > 0").not.toBe(undefined);
  expect(result.artifacts_written.includes("runtime_validation_report.json"), "runtime_validation_report.json must appear in artifacts_written when tasks are present").toBeTruthy();
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

  expect(result.progress_summary.includes("Delta scope since abc123"), `progress_summary should contain 'Delta scope since abc123' but was: ${result.progress_summary}`).toBeTruthy();
  expect(result.progress_summary.includes("1 changed file"), `progress_summary should mention seed_files count (1) but was: ${result.progress_summary}`).toBeTruthy();
  expect(result.progress_summary.includes("1 graph neighbour"), `progress_summary should mention expanded_files count (1) but was: ${result.progress_summary}`).toBeTruthy();
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
  expect(!taskPaths.includes("src/gen.ts"), "overridden file must not appear in audit tasks").toBeTruthy();
  expect(taskPaths.includes("src/real.ts"), "non-overridden file must still appear").toBeTruthy();
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
  expect(!taskPaths.includes("vendor/a.ts"), "vendor/a.ts must be excluded via prefix").toBeTruthy();
  expect(!taskPaths.includes("vendor/b.ts"), "vendor/b.ts must be excluded via prefix").toBeTruthy();
  expect(taskPaths.includes("src/main.ts"), "src/main.ts must not be excluded").toBeTruthy();
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
  expect(taskPaths.includes("src/a.ts"), "file must appear in tasks when no overrides").toBeTruthy();
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
  expect(taskPaths.includes("src/a.ts"), "file must appear in tasks when overrides is empty").toBeTruthy();
});

// ---------------------------------------------------------------------------
// interpretFreeFormIntent: keyword → lens mapping
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent: security keywords map to security lens", () => {
  const lenses = interpretFreeFormIntent("focus on auth and security issues");
  expect(lenses.includes("security"), "should include security lens").toBeTruthy();
});

test("interpretFreeFormIntent: data integrity keywords map to data_integrity lens", () => {
  const lenses = interpretFreeFormIntent("check data integrity and validation");
  expect(lenses.includes("data_integrity"), "should include data_integrity lens").toBeTruthy();
});

test("interpretFreeFormIntent: empty string returns empty array", () => {
  const lenses = interpretFreeFormIntent("");
  expect(lenses, "empty input must return empty array").toEqual([]);
});

test("interpretFreeFormIntent: undefined-like blank input returns empty array", () => {
  const lenses = interpretFreeFormIntent("   ");
  expect(lenses, "whitespace-only input must return empty array").toEqual([]);
});

test("interpretFreeFormIntent: performance keywords map to performance lens", () => {
  const lenses = interpretFreeFormIntent("improve perf and latency");
  expect(lenses.includes("performance"), "should include performance lens for perf/latency").toBeTruthy();
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
  expect(secTasks.length > 0, "should produce security tasks").toBeTruthy();
  // Without external signal, security base priority is 'medium'; boosted → 'high'
  for (const task of secTasks) {
    expect(task.priority, `security task should be 'high' after intent boost, got '${task.priority}'`).toBe("high");
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
    expect(corrTasks[0].priority, "correctness task should stay low priority").toBe("low");
  }
});

// ---------------------------------------------------------------------------
// INV-PLAN-PERSIST-COMPLETE (COR-58ccee39): every task in the merged dispatch
// task list (audit tasks + folded pending requeue tasks) is persisted in
// audit_tasks before dispatch — the task-affinity graph and plan metrics are
// built over EXACTLY the persisted set, never over phantom tasks that dispatch
// (buildPendingAuditTasks reads bundle.audit_tasks) can never see.
// INV-PLAN-FROZEN-ESTIMATES: every persisted dispatch task carries frozen
// provider-neutral token_estimate + risk_estimate.
// ---------------------------------------------------------------------------

function makeTwoFileBundle() {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", lines: 100 },
        { path: "src/b.ts", lines: 120 },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "audit" },
        { path: "src/b.ts", status: "audit" },
      ],
    },
    unit_manifest: {
      units: [{ unit_id: "u1", name: "u1", files: ["src/a.ts", "src/b.ts"] }],
    },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
  };
}

test("INV-PLAN-PERSIST-COMPLETE: task_affinity_graph nodes are exactly the persisted audit_tasks", async () => {
  const result = await runPlanningExecutor(
    makeTwoFileBundle(),
    nonExistentRoot,
    { "src/a.ts": 100, "src/b.ts": 120 },
  );
  const persistedIds = (result.updated.audit_tasks ?? []).map((t) => t.task_id).sort();
  const graphIds = (result.updated.task_affinity_graph?.nodes ?? []).map((n) => n.task_id).sort();
  expect(graphIds, "affinity graph must partition exactly the persisted dispatch set — a graph node dispatch cannot see is a phantom task").toEqual(persistedIds);
});

test("INV-PLAN-PERSIST-COMPLETE: audit_plan_metrics counts exactly the persisted audit_tasks", async () => {
  const result = await runPlanningExecutor(
    makeTwoFileBundle(),
    nonExistentRoot,
    { "src/a.ts": 100, "src/b.ts": 120 },
  );
  const persisted = result.updated.audit_tasks ?? [];
  expect(result.updated.audit_plan_metrics?.task_count, "plan metrics must describe the persisted dispatch set, not an unpersisted merge").toBe(persisted.length);
});

test("INV-PLAN-FROZEN-ESTIMATES: every persisted dispatch task carries frozen token_estimate and risk_estimate", async () => {
  const result = await runPlanningExecutor(
    makeTwoFileBundle(),
    nonExistentRoot,
    { "src/a.ts": 100, "src/b.ts": 120 },
  );
  for (const task of result.updated.audit_tasks ?? []) {
    expect(typeof task.token_estimate, `task ${task.task_id} must freeze token_estimate at planning`).toBe("number");
    expect(typeof task.risk_estimate, `task ${task.task_id} must freeze risk_estimate at planning`).toBe("number");
  }
});

// ---------------------------------------------------------------------------
// Requeue fold: dedupe is COVERAGE-based, not task_id-based. A pending requeue
// task whose (path × lens) an existing audit task already covers is a duplicate
// (fresh-plan requeue mirrors the whole pending set under different ids); only
// a genuinely-uncovered gap survives the fold — and then it must be persisted.
// ---------------------------------------------------------------------------

test("requeue fold: coverage-covered pending requeue tasks are deduped; genuine gaps survive", async () => {
  const { selectUncoveredRequeueTasks } = await import("../../src/audit/orchestrator/planningExecutors.ts");
  expect(typeof selectUncoveredRequeueTasks, "fold helper must exist (coverage-based dedupe)").toBe("function");
  const auditTasks = [
    {
      task_id: "u1:security",
      unit_id: "u1",
      pass_id: "p",
      lens: "security",
      file_paths: ["src/a.ts", "src/b.ts"],
      rationale: "r",
      status: "pending",
    },
  ];
  const requeueTasks = [
    // duplicate coverage (security over a.ts is covered by u1:security)
    { task_id: "requeue:security:src/a.ts", unit_id: "requeue:src/a.ts", pass_id: "requeue:security", lens: "security", file_paths: ["src/a.ts"], rationale: "r", status: "pending" },
    // genuine gap (correctness over a.ts has no covering audit task)
    { task_id: "requeue:correctness:src/a.ts", unit_id: "requeue:src/a.ts", pass_id: "requeue:correctness", lens: "correctness", file_paths: ["src/a.ts"], rationale: "r", status: "pending" },
    // non-pending never folds
    { task_id: "requeue:tests:src/a.ts", unit_id: "requeue:src/a.ts", pass_id: "requeue:tests", lens: "tests", file_paths: ["src/a.ts"], rationale: "r", status: "complete" },
  ];
  const folded = selectUncoveredRequeueTasks(requeueTasks, auditTasks);
  expect(folded.map((t) => t.task_id)).toEqual(["requeue:correctness:src/a.ts"]);
});

test("requeue fold: an operator-excluded lens never re-enters through the fold", async () => {
  const { selectUncoveredRequeueTasks } = await import("../../src/audit/orchestrator/planningExecutors.ts");
  const requeueTasks = [
    { task_id: "requeue:tests:src/a.ts", unit_id: "requeue:src/a.ts", pass_id: "requeue:tests", lens: "tests", file_paths: ["src/a.ts"], rationale: "r", status: "pending" },
    { task_id: "requeue:security:src/a.ts", unit_id: "requeue:src/a.ts", pass_id: "requeue:security", lens: "security", file_paths: ["src/a.ts"], rationale: "r", status: "pending" },
  ];
  const folded = selectUncoveredRequeueTasks(requeueTasks, [], ["security", "correctness"]);
  expect(folded.map((t) => t.task_id), "a lens the operator excluded (absent from effective lenses) must not sneak back in as a requeue dispatch task").toEqual(["requeue:security:src/a.ts"]);
});

test("fresh full-coverage plan folds no requeue duplicates into the persisted dispatch set", async () => {
  const result = await runPlanningExecutor(
    makeTwoFileBundle(),
    nonExistentRoot,
    { "src/a.ts": 100, "src/b.ts": 120 },
  );
  const requeueIds = (result.updated.audit_tasks ?? [])
    .map((t) => t.task_id)
    .filter((id) => id.startsWith("requeue:"));
  expect(requeueIds, "fresh plan: every requeue task duplicates unit-task coverage, so none may be persisted as dispatch tasks").toEqual([]);
  // requeue_tasks.json (the full gap record) still carries the whole payload
  expect((result.updated.requeue_tasks ?? []).length > 0, "requeue_tasks artifact keeps the full coverage-gap record").toBeTruthy();
});
