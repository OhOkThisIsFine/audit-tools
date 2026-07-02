import { test, expect } from "vitest";
import assert from "node:assert/strict";

// Direct unit coverage for the coverage-matrix module. orchestration.test.mjs
// defines its own local createCoverageMatrix fixture and never exercises these
// exports, so this file is the dedicated test for the real module.
const {
  createCoverageMatrix,
  markExcludedPath,
  applyUnitCoverage,
  applyFileCoverage,
  buildRequeueTargets,
} = await import("../../src/audit/coverage.ts");

test("createCoverageMatrix builds one record per path with pending/unclassified defaults", () => {
  const matrix = createCoverageMatrix(["a.ts", "b.ts"]);
  expect(matrix.files.length).toBe(2);
  for (const record of matrix.files) {
    expect(record.audit_status).toBe("pending");
    expect(record.classification_status).toBe("unclassified");
    expect(record.unit_ids).toEqual([]);
    expect(record.required_lenses).toEqual([]);
    expect(record.completed_lenses).toEqual([]);
  }
  expect(matrix.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
});

test("markExcludedPath sets excluded status and clears lens/unit arrays", () => {
  const matrix = createCoverageMatrix(["a.ts"]);
  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness", "security"]);
  // Seed a completed lens so we can confirm it is cleared too.
  matrix.files[0].completed_lenses = ["correctness"];

  markExcludedPath(matrix, "a.ts", "generated");

  const record = matrix.files[0];
  expect(record.audit_status).toBe("excluded");
  expect(record.classification_status).toBe("generated");
  expect(record.required_lenses).toEqual([]);
  expect(record.completed_lenses).toEqual([]);
  expect(record.unit_ids).toEqual([]);

  // markExcludedPath on an unknown path must be a no-op (no throw).
  assert.doesNotThrow(() => markExcludedPath(matrix, "missing.ts", "excluded"));
});

test("applyUnitCoverage adds deduped unit + required lenses and skips excluded files", () => {
  const matrix = createCoverageMatrix(["a.ts", "skip.ts"]);

  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness"]);
  // Calling twice with the same unit must not duplicate the unit_id, and the
  // required_lenses must be the deduped union of prior + new lenses.
  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness", "security"]);

  const record = matrix.files[0];
  expect(record.unit_ids).toEqual(["unit-a"]);
  expect([...record.required_lenses].sort()).toEqual(["correctness", "security"]);
  expect(record.classification_status).toBe("classified");

  // An excluded file is left untouched by applyUnitCoverage.
  markExcludedPath(matrix, "skip.ts", "vendor");
  applyUnitCoverage(matrix, "skip.ts", "unit-skip", ["security"]);
  const skip = matrix.files[1];
  expect(skip.audit_status).toBe("excluded");
  expect(skip.unit_ids).toEqual([]);
  expect(skip.required_lenses).toEqual([]);
});

test("applyFileCoverage marks complete only when all required lenses completed, else partial", () => {
  const matrix = createCoverageMatrix(["full.ts", "partial.ts", "excluded.ts"]);
  applyUnitCoverage(matrix, "full.ts", "u-full", ["correctness", "security"]);
  applyUnitCoverage(matrix, "partial.ts", "u-partial", ["correctness", "security"]);
  applyUnitCoverage(matrix, "excluded.ts", "u-ex", ["correctness"]);
  markExcludedPath(matrix, "excluded.ts", "vendor");
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

  expect(full.audit_status).toBe("complete");
  expect(partial.audit_status).toBe("partial");
  // The non-required 'tests' lens was filtered out.
  expect(partial.completed_lenses).toEqual(["correctness"]);
  // Excluded files are never marked complete/partial.
  expect(excluded.audit_status).toBe("excluded");
});

test("applyFileCoverage uses Map lookup — correctly matches all 500 covered files in a 1000-file matrix", () => {
  // Build a matrix with 1000 files; the last 500 will be covered.
  const paths = Array.from({ length: 1000 }, (_, i) => `file-${i}.ts`);
  const matrix = createCoverageMatrix(paths);
  for (const path of paths) {
    applyUnitCoverage(matrix, path, "u1", ["correctness"]);
  }

  // Cover only the last 500 paths (indices 500–999).
  const fileCoverage = paths.slice(500).map((path) => ({
    path,
    total_lines: 10,
    pass_id: `p:${path}`,
    lens: "correctness",
  }));

  applyFileCoverage(matrix, fileCoverage);

  // The last 500 files should be complete; the first 500 should remain partial/pending.
  for (let i = 0; i < 500; i++) {
    expect(matrix.files[i].audit_status, `file-${i}.ts should not be complete`).not.toBe("complete");
  }
  for (let i = 500; i < 1000; i++) {
    expect(matrix.files[i].audit_status, `file-${i}.ts should be complete`).toBe("complete");
  }
});

test("markExcludedPath and applyUnitCoverage find records correctly via index and are no-ops for unknown paths", () => {
  const matrix = createCoverageMatrix(["a.ts", "b.ts", "c.ts"]);

  // markExcludedPath mutates exactly the target record.
  markExcludedPath(matrix, "b.ts", "vendor");
  expect(matrix.files[0].audit_status, "a.ts must not be mutated").toBe("pending");
  expect(matrix.files[1].audit_status, "b.ts must be excluded").toBe("excluded");
  expect(matrix.files[2].audit_status, "c.ts must not be mutated").toBe("pending");

  // applyUnitCoverage mutates exactly the target record.
  applyUnitCoverage(matrix, "a.ts", "unit-a", ["correctness"]);
  expect(matrix.files[0].unit_ids).toEqual(["unit-a"]);
  expect(matrix.files[2].unit_ids, "c.ts must not be mutated").toEqual([]);

  // Both are no-ops for a path not present in the matrix.
  assert.doesNotThrow(() => markExcludedPath(matrix, "missing.ts", "excluded"));
  assert.doesNotThrow(() => applyUnitCoverage(matrix, "missing.ts", "unit-x", ["correctness"]));
});

test("buildRequeueTargets reports only outstanding work", () => {
  const matrix = createCoverageMatrix([
    "complete.ts",
    "partial.ts",
    "pending.ts",
    "excluded.ts",
  ]);
  applyUnitCoverage(matrix, "complete.ts", "u1", ["correctness"]);
  applyUnitCoverage(matrix, "partial.ts", "u2", ["correctness", "security"]);
  applyUnitCoverage(matrix, "pending.ts", "u3", ["correctness"]);
  markExcludedPath(matrix, "excluded.ts", "vendor");

  applyFileCoverage(matrix, [
    { path: "complete.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
    { path: "partial.ts", total_lines: 10, pass_id: "p:correctness", lens: "correctness" },
  ]);

  const targets = buildRequeueTargets(matrix);
  const byPath = new Map(targets.map((t) => [t.path, t.missing_lenses]));
  // partial.ts is still missing 'security'.
  expect(byPath.get("partial.ts")).toEqual(["security"]);
  // complete.ts has no missing lenses -> not a requeue target.
  expect(!byPath.has("complete.ts")).toBeTruthy();
  // excluded.ts is never a requeue target.
  expect(!byPath.has("excluded.ts")).toBeTruthy();
  // pending.ts is missing 'correctness'.
  expect(byPath.get("pending.ts")).toEqual(["correctness"]);
});
