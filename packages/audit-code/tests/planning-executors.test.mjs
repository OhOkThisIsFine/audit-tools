import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runPlanningExecutor } = await import(
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
