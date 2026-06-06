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
// lensSetForFlow silently drops all non-whitelisted concerns
// ---------------------------------------------------------------------------

test("lensSetForFlow silently drops non-whitelisted concerns (architecture, maintainability, config_deployment)", () => {
  const manifest = makeFlow({
    paths: ["src/a.ts"],
    concerns: ["architecture", "maintainability", "config_deployment"],
  });
  const matrix = makeMatrix([
    { path: "src/a.ts", completed_lenses: ["architecture", "maintainability"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  // None of the concerns pass the allowlist filter.
  assert.deepEqual(flow.required_lenses, []);
  // status: required.length === 0 → required.every(...) is vacuously true → "complete"
  // (This is the current implementation's behaviour for an empty required set.)
  assert.equal(flow.completed_lenses.length, 0);
  // No error must be thrown — verified by reaching this assertion.
});

// ---------------------------------------------------------------------------
// lensSetForFlow keeps allowed lenses and drops disallowed in a mixed list
// ---------------------------------------------------------------------------

test("lensSetForFlow keeps allowed lenses and drops disallowed ones in a mixed concerns list", () => {
  const manifest = makeFlow({
    paths: ["src/service.ts"],
    concerns: ["security", "architecture", "reliability"],
  });
  const matrix = makeMatrix([
    { path: "src/service.ts", completed_lenses: ["security"] },
  ]);

  const result = buildFlowCoverage(manifest, matrix);
  const flow = result.flows[0];

  // 'architecture' is not in the 7-item allowlist; only security and reliability survive.
  assert.deepEqual(flow.required_lenses.sort(), ["reliability", "security"]);
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
