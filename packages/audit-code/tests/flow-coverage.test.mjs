import test from "node:test";
import assert from "node:assert/strict";

const { buildFlowCoverage } = await import(
  "../src/orchestrator/flowCoverage.ts"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CriticalFlowManifest with a single flow.
 */
function makeFlow({ id = "flow-1", paths = [], concerns = [] } = {}) {
  return {
    flows: [
      {
        id,
        name: id,
        entrypoints: [],
        paths,
        concerns,
      },
    ],
  };
}

/**
 * Build a minimal CoverageMatrix containing exactly the provided file records.
 * Each entry: { path, audit_status?, completed_lenses? }
 */
function makeMatrix(files) {
  return {
    files: files.map(({ path, audit_status = "audited", completed_lenses = [] }) => ({
      path,
      audit_status,
      completed_lenses,
      classification_status: "classified",
      unit_ids: [],
      required_lenses: [],
    })),
  };
}

// ---------------------------------------------------------------------------
// status='complete' when all required lenses are covered across flow paths
// ---------------------------------------------------------------------------

test("buildFlowCoverage status=complete when all required lenses are covered across flow paths", () => {
  const manifest = makeFlow({
    paths: ["src/auth.ts", "src/session.ts"],
    concerns: ["security", "reliability"],
  });
  const matrix = makeMatrix([
    { path: "src/auth.ts", completed_lenses: ["security", "reliability"] },
    { path: "src/session.ts", completed_lenses: ["security"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  assert.equal(result.flows.length, 1);
  const flow = result.flows[0];

  assert.equal(flow.status, "complete");
  assert.deepEqual(flow.required_lenses.sort(), ["reliability", "security"]);
  assert.ok(
    flow.completed_lenses.includes("security"),
    "completed_lenses must include security",
  );
  assert.ok(
    flow.completed_lenses.includes("reliability"),
    "completed_lenses must include reliability",
  );
  assert.equal(flow.completed_lenses.length, 2);
});

// ---------------------------------------------------------------------------
// status='partial' when only some required lenses are covered
// ---------------------------------------------------------------------------

test("buildFlowCoverage status=partial when only some required lenses are covered", () => {
  const manifest = makeFlow({
    paths: ["src/auth.ts"],
    concerns: ["security", "reliability"],
  });
  const matrix = makeMatrix([
    { path: "src/auth.ts", completed_lenses: ["security"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  assert.equal(flow.status, "partial");
  assert.deepEqual(flow.required_lenses.sort(), ["reliability", "security"]);
  assert.deepEqual(flow.completed_lenses, ["security"]);
});

// ---------------------------------------------------------------------------
// status='pending' when no required lenses are covered
// ---------------------------------------------------------------------------

test("buildFlowCoverage status=pending when no required lenses are covered", () => {
  const manifest = makeFlow({
    paths: ["src/handler.ts"],
    concerns: ["correctness"],
  });
  const matrix = makeMatrix([
    { path: "src/handler.ts", completed_lenses: [] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  assert.equal(flow.status, "pending");
  assert.deepEqual(flow.required_lenses, ["correctness"]);
  assert.deepEqual(flow.completed_lenses, []);
});

// ---------------------------------------------------------------------------
// COR-59c25418: lensSetForFlow must accept ALL valid lenses via isLens
// ---------------------------------------------------------------------------

test("COR-59c25418: lensSetForFlow accepts architecture, maintainability, config_deployment (previously dropped)", () => {
  // Before the fix these 3 valid lenses were silently filtered by a hardcoded
  // 7-lens allowlist. After the fix, isLens is the gate and all are accepted.
  const manifest = makeFlow({
    paths: ["src/a.ts"],
    concerns: ["architecture", "maintainability", "config_deployment"],
  });
  const matrix = makeMatrix([
    { path: "src/a.ts", completed_lenses: ["architecture", "maintainability"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  // All three are valid lenses — they must appear in required_lenses.
  assert.deepEqual(flow.required_lenses.sort(), ["architecture", "config_deployment", "maintainability"]);
  // Two of three are completed.
  assert.deepEqual(flow.completed_lenses.sort(), ["architecture", "maintainability"]);
  // config_deployment is required but not completed → partial.
  assert.equal(flow.status, "partial");
});

test("COR-59c25418: lensSetForFlow still drops truly invalid (unknown) concern strings", () => {
  const manifest = makeFlow({
    paths: ["src/a.ts"],
    concerns: ["security", "not_a_real_lens", "reliability"],
  });
  const matrix = makeMatrix([
    { path: "src/a.ts", completed_lenses: ["security", "reliability"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  // "not_a_real_lens" must be filtered out; the two valid lenses are accepted.
  assert.deepEqual(flow.required_lenses.sort(), ["reliability", "security"]);
  assert.deepEqual(flow.completed_lenses.sort(), ["reliability", "security"]);
  assert.equal(flow.status, "complete");
});

// ---------------------------------------------------------------------------
// lensSetForFlow keeps all valid lenses in a mixed list
// ---------------------------------------------------------------------------

test("lensSetForFlow keeps all valid lenses (including architecture) and drops truly unknown ones", () => {
  const manifest = makeFlow({
    paths: ["src/service.ts"],
    concerns: ["security", "architecture", "reliability"],
  });
  const matrix = makeMatrix([
    { path: "src/service.ts", completed_lenses: ["security"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  // All three are valid lenses — all survive the isLens filter.
  assert.deepEqual(flow.required_lenses.sort(), ["architecture", "reliability", "security"]);
  assert.deepEqual(flow.completed_lenses, ["security"]);
  assert.equal(flow.status, "partial");
});

// ---------------------------------------------------------------------------
// Excluded files do not contribute completed lenses
// ---------------------------------------------------------------------------

test("buildFlowCoverage ignores excluded files when computing completed lenses", () => {
  const manifest = makeFlow({
    paths: ["src/generated.ts"],
    concerns: ["correctness", "security"],
  });
  const matrix = makeMatrix([
    {
      path: "src/generated.ts",
      audit_status: "excluded",
      completed_lenses: ["correctness", "security"],
    },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  // The excluded record's completed_lenses must not count.
  assert.deepEqual(flow.completed_lenses, []);
  assert.equal(flow.status, "pending");
});

// ---------------------------------------------------------------------------
// Coverage satisfied across multiple paths (union of completed lenses)
// ---------------------------------------------------------------------------

test("buildFlowCoverage coverage can be satisfied across multiple paths", () => {
  const manifest = makeFlow({
    paths: ["src/a.ts", "src/b.ts"],
    concerns: ["security", "reliability"],
  });
  const matrix = makeMatrix([
    { path: "src/a.ts", completed_lenses: ["security"] },
    { path: "src/b.ts", completed_lenses: ["reliability"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  assert.equal(flow.status, "complete");
  assert.deepEqual(flow.completed_lenses.sort(), ["reliability", "security"]);
  assert.deepEqual(flow.required_lenses.sort(), ["reliability", "security"]);
});
