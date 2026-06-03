import test from "node:test";
import assert from "node:assert/strict";

// Direct unit coverage for the coverage-matrix module. orchestration.test.mjs
// defines its own local createCoverageMatrix fixture and never exercises these
// exports, so this file is the dedicated test for the real module.
const {
  createCoverageMatrix,
  markExcludedPath,
  applyUnitCoverage,
  applyFileCoverage,
  findUncoveredFiles,
  buildRequeueTargets,
} = await import("../src/coverage.ts");

test("createCoverageMatrix builds one record per path with pending/unclassified defaults", () => {
  const matrix = createCoverageMatrix(["a.ts", "b.ts"]);
  assert.equal(matrix.files.length, 2);
  for (const record of matrix.files) {
    assert.equal(record.audit_status, "pending");
    assert.equal(record.classification_status, "unclassified");
    assert.deepEqual(record.unit_ids, []);
    assert.deepEqual(record.required_lenses, []);
    assert.deepEqual(record.completed_lenses, []);
  }
  assert.deepEqual(
    matrix.files.map((f) => f.path),
    ["a.ts", "b.ts"],
  );
});

test("markExcludedPath sets excluded status and clears lens/unit arrays", () => {
  const matrix = createCoverageMatrix(["a.ts"]);
  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness", "security"]);
  // Seed a completed lens so we can confirm it is cleared too.
  matrix.files[0].completed_lenses = ["correctness"];

  markExcludedPath(matrix, "a.ts", "excluded_generated");

  const record = matrix.files[0];
  assert.equal(record.audit_status, "excluded");
  assert.equal(record.classification_status, "excluded_generated");
  assert.deepEqual(record.required_lenses, []);
  assert.deepEqual(record.completed_lenses, []);
  assert.deepEqual(record.unit_ids, []);

  // markExcludedPath on an unknown path must be a no-op (no throw).
  assert.doesNotThrow(() => markExcludedPath(matrix, "missing.ts", "x"));
});

test("applyUnitCoverage adds deduped unit + required lenses and skips excluded files", () => {
  const matrix = createCoverageMatrix(["a.ts", "skip.ts"]);

  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness"]);
  // Calling twice with the same unit must not duplicate the unit_id, and the
  // required_lenses must be the deduped union of prior + new lenses.
  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness", "security"]);

  const record = matrix.files[0];
  assert.deepEqual(record.unit_ids, ["unit-a"]);
  assert.deepEqual([...record.required_lenses].sort(), ["correctness", "security"]);
  assert.equal(record.classification_status, "classified");

  // An excluded file is left untouched by applyUnitCoverage.
  markExcludedPath(matrix, "skip.ts", "excluded_vendor");
  applyUnitCoverage(matrix, "skip.ts", "unit-skip", ["security"]);
  const skip = matrix.files[1];
  assert.equal(skip.audit_status, "excluded");
  assert.deepEqual(skip.unit_ids, []);
  assert.deepEqual(skip.required_lenses, []);
});

test("applyFileCoverage marks complete only when all required lenses completed, else partial", () => {
  const matrix = createCoverageMatrix(["full.ts", "partial.ts", "excluded.ts"]);
  applyUnitCoverage(matrix, "full.ts", "u-full", ["correctness", "security"]);
  applyUnitCoverage(matrix, "partial.ts", "u-partial", ["correctness", "security"]);
  applyUnitCoverage(matrix, "excluded.ts", "u-ex", ["correctness"]);
  markExcludedPath(matrix, "excluded.ts", "excluded_vendor");
  // Re-add a required lens to the excluded file directly to prove applyFileCoverage
  // never resurrects it (markExcludedPath cleared required_lenses).
  matrix.files[2].required_lenses = ["correctness"];

  applyFileCoverage(matrix, [
    { path: "full.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
    { path: "full.ts", total_lines: 10, pass_id: "p:security", lens: "security" },
    { path: "partial.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
    // A completed lens NOT in required_lenses must not be added.
    { path: "partial.ts", total_lines: 10, pass_id: "p:tests", lens: "tests" },
    { path: "excluded.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
  ]);

  const full = matrix.files[0];
  const partial = matrix.files[1];
  const excluded = matrix.files[2];

  assert.equal(full.audit_status, "complete");
  assert.equal(partial.audit_status, "partial");
  // The non-required 'tests' lens was filtered out.
  assert.deepEqual(partial.completed_lenses, ["correctness"]);
  // Excluded files are never marked complete/partial.
  assert.equal(excluded.audit_status, "excluded");
});

test("findUncoveredFiles and buildRequeueTargets report only outstanding work", () => {
  const matrix = createCoverageMatrix([
    "complete.ts",
    "partial.ts",
    "pending.ts",
    "excluded.ts",
  ]);
  applyUnitCoverage(matrix, "complete.ts", "u1", ["correctness"]);
  applyUnitCoverage(matrix, "partial.ts", "u2", ["correctness", "security"]);
  applyUnitCoverage(matrix, "pending.ts", "u3", ["correctness"]);
  markExcludedPath(matrix, "excluded.ts", "excluded_vendor");

  applyFileCoverage(matrix, [
    { path: "complete.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
    { path: "partial.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
  ]);

  const uncovered = findUncoveredFiles(matrix).map((f) => f.path);
  assert.ok(!uncovered.includes("excluded.ts"), "excluded files are omitted");
  assert.ok(!uncovered.includes("complete.ts"), "complete files are omitted");
  assert.ok(uncovered.includes("partial.ts"), "partial files are included");
  assert.ok(uncovered.includes("pending.ts"), "pending files are included");

  const targets = buildRequeueTargets(matrix);
  const byPath = new Map(targets.map((t) => [t.path, t.missing_lenses]));
  // partial.ts is still missing 'security'.
  assert.deepEqual(byPath.get("partial.ts"), ["security"]);
  // complete.ts has no missing lenses -> not a requeue target.
  assert.ok(!byPath.has("complete.ts"));
  // excluded.ts is never a requeue target.
  assert.ok(!byPath.has("excluded.ts"));
  // pending.ts is missing 'correctness'.
  assert.deepEqual(byPath.get("pending.ts"), ["correctness"]);
});
