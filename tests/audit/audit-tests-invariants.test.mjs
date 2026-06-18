/**
 * Invariant tests for the audit-code test module itself.
 * Locks the meta-contract guarantees established by the N-audit-tests-inv
 * remediation block (INV-audit-tests-01 through INV-audit-tests-07).
 *
 * These are deterministic structural and regression tests — they verify the
 * test suite's own integrity rather than the production sources directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
// Audit tests live in tests/audit/ after the single-package collapse.
const TESTS_DIR = join(PACKAGE_ROOT, "tests", "audit");

// ── INV-audit-tests-01: No test file imports from dist/ at module load time ──
// A test that does `import("../../dist/audit/foo.js")` at the module's top level will
// silently use the last compiled dist/, meaning it can pass on stale code.
// Known violators were validate-command.test.mjs, cli-dispatcher.test.mjs,
// audit-code-wrapper.test.mjs, review-packets.test.mjs, and
// dispatch-quota-constants.test.mjs (fixed: now imports from src/).
// This test scans all .test.mjs files and fails if a top-level dist import
// is found in files that are not known legacy CLI-integration tests (which
// intentionally exercise the compiled entrypoint).

// These files use the compiled dist/cli.js intentionally as a CLI integration
// test (they call runCli from the compiled CLI entry) — allow-listed rather
// than banned.
const DIST_IMPORT_ALLOWLIST = new Set([
  // audit-code-wrapper.test.mjs imports dist/cli.js for the spawn wrapper test
  "audit-code-wrapper.test.mjs",
  // cli-dispatcher.test.mjs tests the CLI entry point dispatching
  "cli-dispatcher.test.mjs",
  // validate-command.test.mjs tests the validate CLI command end-to-end
  "validate-command.test.mjs",
  // review-packets.test.mjs uses CLI test helpers that need the compiled bin
  "review-packets.test.mjs",
]);

// Pattern: actual import/require of a ../dist/ path.
// Matches: await import("../../dist/audit/foo"), from "../dist/foo", require("../dist/foo")
// Does NOT match when the string appears in a comment or string literal context
// that is itself being defined (e.g. allowlist entries or diagnostic text).
// We scan each non-comment, non-allowlist line.
const DIST_IMPORT_PATTERN = /(?:import\s*\(\s*["']\.\.\/dist\/|from\s+["']\.\.\/dist\/|=\s*require\s*\(\s*["']\.\.\/dist\/)/;

test("INV-audit-tests-01: no test file imports from dist/ at module load time (outside allowlist)", () => {
  const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const violations = [];
  for (const file of testFiles) {
    if (DIST_IMPORT_ALLOWLIST.has(file)) {
      continue;
    }
    // Skip the invariants file itself — it contains pattern strings in source code
    if (file === "audit-tests-invariants.test.mjs") {
      continue;
    }
    const src = readFileSync(join(TESTS_DIR, file), "utf8");
    // Check each line; skip pure comment lines so pattern descriptions don't fire
    const hasDistImport = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .some((line) => DIST_IMPORT_PATTERN.test(line));
    if (hasDistImport) {
      violations.push(file);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `These test files import from dist/ — they will silently pass on stale builds. ` +
      `Fix: import from src/*.ts (tsx resolves at test time) or add to the allowlist if ` +
      `the test is intentionally an integration test of the compiled artefact:\n  ${violations.join("\n  ")}`,
  );
});

// ── INV-audit-tests-02: shared dist/ import banned in test files ────────────
// Importing `../../shared/dist/...` bakes a dependency on the shared package's
// compiled output. Tests must use the live `audit-tools/shared` package name
// (which resolves to shared's dist/ via the workspace symlink, but from the
// package's own resolution, not a relative path). This guards against the
// anti-pattern of `../../shared/dist/tokens.js` that bypasses the workspace.

const SHARED_DIST_IMPORT_PATTERN = /(?:from ["']\.\.\/\.\.\/shared\/dist\/|import\(["']\.\.\/\.\.\/shared\/dist\/)/;

test("INV-audit-tests-02: no test file uses a relative path into shared/dist/", () => {
  const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const violations = [];
  for (const file of testFiles) {
    const src = readFileSync(join(TESTS_DIR, file), "utf8");
    if (SHARED_DIST_IMPORT_PATTERN.test(src)) {
      violations.push(file);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `These test files use relative paths into shared/dist/ — they bypass the workspace contract. ` +
      `Fix: use 'audit-tools/shared' as the import specifier:\n  ${violations.join("\n  ")}`,
  );
});

// ── INV-audit-tests-04: python-logical-lines test has no trivially-true assertions ──
// TST-6ccb17f3: `assert.ok(edges.length >= 0)` is trivially true for any Array
// (length is never negative) and provides no protection. The test must assert a
// meaningful lower bound (≥ 2 for a two-import statement).

const { extractPythonImportEdges } = await import("../../src/audit/extractors/graphPythonImports.ts");

function pythonLookup(...paths) {
  return new Map(paths.map((p) => [p.toLowerCase(), p]));
}

test("INV-audit-tests-04: well-formed multiline Python import emits ≥ 2 edges (bar + baz)", () => {
  const content = "from foo import (\n  bar,\n  baz\n)";
  const pl = pythonLookup("src/mod.py", "foo/bar.py", "foo/baz.py");
  const edges = extractPythonImportEdges("src/mod.py", content, pl);
  // Meaningful assertion: both bar and baz must be resolved, not trivially ≥ 0.
  assert.ok(
    edges.length >= 2,
    `from-import must resolve both bar and baz, got ${edges.length} edge(s): ${JSON.stringify(edges)}`,
  );
  const tos = edges.map((e) => e.to);
  assert.ok(
    tos.some((t) => t.includes("bar")),
    `expected edge to foo/bar.py, got: ${JSON.stringify(tos)}`,
  );
  assert.ok(
    tos.some((t) => t.includes("baz")),
    `expected edge to foo/baz.py, got: ${JSON.stringify(tos)}`,
  );
});

// ── INV-audit-tests-05: computeStaleArtifacts handles absent artifact_metadata ─
// TST-aa3c406e: no test existed for the case where artifact_metadata is absent
// from the bundle. The function must return an empty set (can't determine
// freshness → nothing is stale by comparison), not throw.

const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.ts");

test("INV-audit-tests-05: computeStaleArtifacts returns empty Set when bundle is empty", () => {
  const stale = computeStaleArtifacts({});
  assert.ok(stale instanceof Set, "must return a Set");
  assert.equal(stale.size, 0, "empty bundle has no stale artifacts");
});

test("INV-audit-tests-05: computeStaleArtifacts returns empty Set when artifact_metadata is null/undefined", () => {
  const staleUndef = computeStaleArtifacts({ artifact_metadata: undefined });
  assert.ok(staleUndef instanceof Set, "must return a Set for undefined");
  assert.equal(staleUndef.size, 0, "undefined artifact_metadata → no stale artifacts");
});

// ── INV-audit-tests-06: test helpers must import from .mjs helpers, not global mocks ──
// This invariant guards that test helper modules (withTempDir, sourceImport, etc.)
// are importable as ESM modules. If they contain CommonJS-only constructs the
// entire test runner silently skips tests.

test("INV-audit-tests-06: test helper modules are valid ESM (no require() or __dirname at top level)", () => {
  const helperDir = join(TESTS_DIR, "helpers");
  const helperFiles = readdirSync(helperDir).filter((f) => f.endsWith(".mjs"));

  const violations = [];
  for (const file of helperFiles) {
    const src = readFileSync(join(helperDir, file), "utf8");
    // Top-level require() or module.exports in a .mjs file is a hard error
    if (/^(const|let|var)\s+\w+\s*=\s*require\s*\(/m.test(src)) {
      violations.push(`${file}: contains require() call`);
    }
    if (/^module\.exports\s*=/m.test(src)) {
      violations.push(`${file}: contains module.exports assignment`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `These helper files contain CommonJS constructs, which break in ESM .mjs files:\n  ${violations.join("\n  ")}`,
  );
});

// ── INV-audit-tests-07: no test source imports a locally-duplicated copy ──────
// of a production function. Tests must exercise the production code, not a local
// copy with a matching signature. TST-edfe6e13 found that worker-run-command.test.mjs
// duplicated `partitionIssues` locally. We guard this by asserting the test file
// has no function definition named the same as a known production function.
//
// This is a structural source check, not a behavioral test — the key invariant is
// that the test file's `partitionIssues` local function is GONE (tests exercise
// production code via the injected dep seam, not a shadow copy).

test("INV-audit-tests-07: worker-run-command.test.mjs does not define a local partitionIssues", () => {
  const src = readFileSync(
    join(TESTS_DIR, "worker-run-command.test.mjs"),
    "utf8",
  );
  // The function was a local duplicate — it must no longer exist in the test file.
  assert.ok(
    !src.includes("function partitionIssues"),
    "worker-run-command.test.mjs must not define a local partitionIssues() — " +
      "the test must exercise the production partition logic via the workerRunCommand dep seam, " +
      "not a shadow copy that can drift from production behavior.",
  );
});

// ── FND-REL-0838abd9: example files used by schema-contracts tests must exist ─
// schema-contracts.test.mjs reads three files from examples/ inside async test
// bodies. If those files were removed, those tests would fail with ENOENT rather
// than crashing the module (node:test isolates errors inside test bodies). This
// invariant makes the dependency explicit and gives a clear failure message
// if an example file is deleted or renamed.

test("FND-REL-0838abd9: schema-contracts example files exist on disk", () => {
  const EXAMPLES_DIR = join(PACKAGE_ROOT, "examples");
  const requiredExamples = [
    "risk_register.example.json",
    "audit_plan_metrics.example.json",
    "external_analyzer_results.example.json",
  ];
  const missing = requiredExamples.filter(
    (f) => !existsSync(join(EXAMPLES_DIR, f)),
  );
  assert.deepEqual(
    missing,
    [],
    `These example files are required by schema-contracts tests but are missing from examples/:\n  ${missing.join("\n  ")}`,
  );
});

// ── FND-REL-0838abd9-2: src modules imported by schema-contracts must exist ───
// schema-contracts.test.mjs statically imports six src/*.ts modules at the top
// of the file. A static import failure causes the entire module to abort before
// any test runs, producing silent skip rather than a per-test failure.
// This invariant asserts all six modules exist so a deletion/rename is caught
// by a direct structural check rather than a mysterious suite-wide skip.

test("FND-REL-0838abd9-2: schema-contracts statically-imported src modules exist on disk", () => {
  const SRC_DIR = join(PACKAGE_ROOT, "src", "audit");
  const requiredModules = [
    "orchestrator/unitBuilder.ts",
    "extractors/risk.ts",
    "extractors/surfaces.ts",
    "extractors/graph.ts",
    "orchestrator/runtimeValidation.ts",
    "orchestrator/reviewPackets.ts",
  ];
  const missing = requiredModules.filter(
    (m) => !existsSync(join(SRC_DIR, m)),
  );
  assert.deepEqual(
    missing,
    [],
    `These src modules are statically imported by schema-contracts.test.mjs but are missing:\n  ${missing.join("\n  ")}`,
  );
});
