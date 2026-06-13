/**
 * Meta-invariants for the shared package test suite infrastructure.
 * INV-shared-tests-01 through INV-shared-tests-07.
 *
 * These tests verify that the test suite itself satisfies its structural
 * contracts: coverage completeness, framework consistency, and stable
 * export shape of the shared public API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = resolve(__dirname);
const SRC_DIR = resolve(__dirname, "../src");

// ── INV-shared-tests-01: Test glob covers all test files ─────────────────────
// The package.json test script runs `tests/*.test.mjs`. Every file in tests/
// matching that pattern must be well-formed (parseable as UTF-8 text) and must
// not be silently excluded by a nested directory.

test("INV-shared-tests-01: all files in tests/ with .test.mjs extension are at top level (no nested dirs)", () => {
  const entries = readdirSync(TESTS_DIR, { withFileTypes: true });
  const testFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith(".test.mjs"),
  );
  const dirs = entries.filter((e) => e.isDirectory());

  // No sub-directories should contain additional .test.mjs files that
  // the glob `tests/*.test.mjs` would silently miss.
  for (const dir of dirs) {
    const subEntries = readdirSync(resolve(TESTS_DIR, dir.name), {
      withFileTypes: true,
    });
    const hidden = subEntries.filter(
      (e) => e.isFile() && e.name.endsWith(".test.mjs"),
    );
    assert.equal(
      hidden.length,
      0,
      `Found ${hidden.length} .test.mjs file(s) in subdirectory '${dir.name}' — these are NOT covered by the package.json test glob (tests/*.test.mjs). Move them to the top-level tests/ directory.`,
    );
  }

  // At least one test file must be present (sanity).
  assert.ok(testFiles.length > 0, "tests/ must contain at least one .test.mjs file");
});

test("INV-shared-tests-01: package.json test script matches the canonical shared test glob", () => {
  const pkgPath = resolve(TESTS_DIR, "../package.json");
  assert.ok(existsSync(pkgPath), "package.json must exist next to tests/");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const testScript = pkg.scripts?.test ?? "";
  // The canonical glob is tests/*.test.mjs (or equivalent).
  assert.ok(
    testScript.includes("tests/*.test.mjs"),
    `package.json 'test' script must use glob 'tests/*.test.mjs' to pick up all test files. Got: "${testScript}" — INV-shared-tests-01`,
  );
});

// ── INV-shared-tests-02: Test files use consistent framework (node:test + node:assert/strict) ─

test("INV-shared-tests-02: every .test.mjs file imports node:test or node:assert/strict", () => {
  const testFiles = readdirSync(TESTS_DIR).filter((f) =>
    f.endsWith(".test.mjs"),
  );

  const violations = [];
  for (const file of testFiles) {
    const content = readFileSync(resolve(TESTS_DIR, file), "utf8");
    // Must reference node:test or node:assert/strict — the two canonical modules.
    const usesNodeTest = content.includes("node:test") || content.includes("node:assert");
    if (!usesNodeTest) {
      violations.push(file);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `The following test files do not import node:test or node:assert — non-canonical test frameworks are not allowed in shared: ${violations.join(", ")} — INV-shared-tests-02`,
  );
});

test("INV-shared-tests-02: no .test.mjs file imports vitest, jest, mocha, or jasmine", () => {
  const testFiles = readdirSync(TESTS_DIR).filter((f) =>
    f.endsWith(".test.mjs"),
  );
  const disallowed = ["vitest", "jest", "mocha", "jasmine"];

  const violations = [];
  for (const file of testFiles) {
    const content = readFileSync(resolve(TESTS_DIR, file), "utf8");
    for (const framework of disallowed) {
      if (content.includes(`from '${framework}'`) || content.includes(`from "${framework}"`)) {
        violations.push(`${file} (imports ${framework})`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Third-party test framework found in shared test file(s) — only node:test is allowed: ${violations.join(", ")} — INV-shared-tests-02`,
  );
});

// ── INV-shared-tests-03: Schema invariant coverage is present ─────────────────
// INV-shared-core-01 (schema drift detection) must be covered by a test that
// can be located in the test suite. Regression-locking this prevents the schema
// guard from being accidentally deleted.

test("INV-shared-tests-03: shared-core-invariants.test.mjs exists and covers schema drift (INV-shared-core-01)", () => {
  const filePath = resolve(TESTS_DIR, "shared-core-invariants.test.mjs");
  assert.ok(
    existsSync(filePath),
    "shared-core-invariants.test.mjs must exist in tests/ — INV-shared-tests-03 (schema invariant coverage)",
  );
  const content = readFileSync(filePath, "utf8");
  assert.ok(
    content.includes("INV-shared-core-01"),
    "shared-core-invariants.test.mjs must contain INV-shared-core-01 (schema drift detection) — INV-shared-tests-03",
  );
  // Must reference the actual schema files under audit-code/schemas.
  assert.ok(
    content.includes("finding.schema.json") || content.includes("audit_result.schema.json"),
    "shared-core-invariants.test.mjs must reference at least one audit-code schema file — INV-shared-tests-03",
  );
});

test("INV-shared-tests-03: validateAuditFindingsReport is importable and validates contract_version", async () => {
  // Spot-check: the validation function referenced by INV-shared-core-06 is importable
  // and rejects an object missing contract_version.
  const { validateAuditFindingsReport } = await import("../src/validation/findingsReport.ts");
  const issues = validateAuditFindingsReport({ findings: [], work_blocks: [] });
  const errors = issues.filter((i) => i.severity === "error");
  assert.ok(
    errors.some((i) => i.message.includes("contract_version")),
    "validateAuditFindingsReport must flag missing contract_version as an error — INV-shared-tests-03 schema guard",
  );
});

// ── INV-shared-tests-04: Lock invariant coverage is present ──────────────────
// INV-shared-quota-06 (file lock token contract) must be covered. Regression-locking
// this prevents the lock-token clobber guard from being silently removed.

test("INV-shared-tests-04: shared-quota-invariants.test.mjs exists and covers lock token invariant (INV-shared-quota-06)", () => {
  const filePath = resolve(TESTS_DIR, "shared-quota-invariants.test.mjs");
  assert.ok(
    existsSync(filePath),
    "shared-quota-invariants.test.mjs must exist — INV-shared-tests-04 (lock invariant coverage)",
  );
  const content = readFileSync(filePath, "utf8");
  assert.ok(
    content.includes("INV-shared-quota-06"),
    "shared-quota-invariants.test.mjs must cover INV-shared-quota-06 (lock token contract) — INV-shared-tests-04",
  );
  // Must reference acquireLock / releaseLock.
  assert.ok(
    content.includes("acquireLock") && content.includes("releaseLock"),
    "INV-shared-quota-06 tests must exercise acquireLock and releaseLock — INV-shared-tests-04",
  );
});

test("INV-shared-tests-04: fileLock.ts exports acquireLock, releaseLock, withFileLock, and FileLockTimeoutError", async () => {
  const { acquireLock, releaseLock, withFileLock, FileLockTimeoutError } =
    await import("../src/quota/fileLock.ts");
  assert.equal(typeof acquireLock, "function", "acquireLock must be exported — INV-shared-tests-04");
  assert.equal(typeof releaseLock, "function", "releaseLock must be exported — INV-shared-tests-04");
  assert.equal(typeof withFileLock, "function", "withFileLock must be exported — INV-shared-tests-04");
  assert.equal(
    typeof FileLockTimeoutError,
    "function",
    "FileLockTimeoutError must be exported as a class — INV-shared-tests-04",
  );
});

// ── INV-shared-tests-05: Concurrency invariant coverage is present ────────────
// INV-shared-quota-10 (parallel recordWaveOutcome convergence) and
// INV-shared-quota-01 (host-limit partitioning) must both be covered.

test("INV-shared-tests-05: shared-quota-invariants.test.mjs covers concurrency invariants (INV-shared-quota-01 and -10)", () => {
  const filePath = resolve(TESTS_DIR, "shared-quota-invariants.test.mjs");
  const content = readFileSync(filePath, "utf8");
  assert.ok(
    content.includes("INV-shared-quota-01"),
    "shared-quota-invariants.test.mjs must cover INV-shared-quota-01 (host limit partitioning) — INV-shared-tests-05",
  );
  assert.ok(
    content.includes("INV-shared-quota-10"),
    "shared-quota-invariants.test.mjs must cover INV-shared-quota-10 (parallel recordWaveOutcome convergence) — INV-shared-tests-05",
  );
});

test("INV-shared-tests-05: computeDispatchCapacity partitions shared host limit correctly (spot-check)", async () => {
  // Spot-verify the concurrency invariant without relying on the full test file.
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");

  function pool(id, limit) {
    return {
      id,
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: { active_subagents: limit, source: "cli_flags", description: "t" },
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: null,
    };
  }

  // Two pools sharing the same limit of 2 must not produce total_slots > 2.
  const capacity = computeDispatchCapacity({
    pools: [pool("a", 2), pool("b", 2)],
    sessionConfig: {},
    pendingItemTokens: new Array(10).fill(5_000),
  });
  assert.ok(
    capacity.total_slots <= 2,
    `total_slots ${capacity.total_slots} must not exceed shared host limit 2 (concurrent over-dispatch guard) — INV-shared-tests-05`,
  );
});

// ── INV-shared-tests-06: Cycle detection invariant coverage is present ────────
// INV-shared-core-07 (obligation cycle detection at construction) must be covered.

test("INV-shared-tests-06: shared-core-invariants.test.mjs covers obligation cycle detection (INV-shared-core-07)", () => {
  const filePath = resolve(TESTS_DIR, "shared-core-invariants.test.mjs");
  const content = readFileSync(filePath, "utf8");
  assert.ok(
    content.includes("INV-shared-core-07"),
    "shared-core-invariants.test.mjs must cover INV-shared-core-07 (cycle detection at construction) — INV-shared-tests-06",
  );
  assert.ok(
    content.includes("cycle"),
    "INV-shared-core-07 tests must contain the word 'cycle' — INV-shared-tests-06",
  );
});

test("INV-shared-tests-06: detectObligationCycle and buildObligationLedger are both exported from shared index", async () => {
  const shared = await import("../src/index.ts");
  assert.equal(
    typeof shared.detectObligationCycle,
    "function",
    "detectObligationCycle must be exported from shared index — INV-shared-tests-06",
  );
  assert.equal(
    typeof shared.buildObligationLedger,
    "function",
    "buildObligationLedger must be exported from shared index — INV-shared-tests-06",
  );
});

test("INV-shared-tests-06: detectObligationCycle returns a non-null result for a direct cycle", async () => {
  const { detectObligationCycle } = await import("../src/types/obligationLedger.ts");
  const cycle = detectObligationCycle([
    { id: "X", description: "x", kind: "behavioral", depends_on: ["Y"], status: "pending" },
    { id: "Y", description: "y", kind: "behavioral", depends_on: ["X"], status: "pending" },
  ]);
  assert.ok(Array.isArray(cycle) && cycle.length > 0, "direct cycle X→Y→X must be detected — INV-shared-tests-06");
  assert.ok(cycle.includes("X") && cycle.includes("Y"), "cycle result must name both participants — INV-shared-tests-06");
});

test("INV-shared-tests-06: detectObligationCycle returns null for an acyclic graph", async () => {
  const { detectObligationCycle } = await import("../src/types/obligationLedger.ts");
  const result = detectObligationCycle([
    { id: "A", description: "a", kind: "behavioral", depends_on: [], status: "pending" },
    { id: "B", description: "b", kind: "behavioral", depends_on: ["A"], status: "pending" },
    { id: "C", description: "c", kind: "behavioral", depends_on: ["A", "B"], status: "pending" },
  ]);
  assert.equal(result, null, "valid DAG must return null from detectObligationCycle — INV-shared-tests-06");
});

// ── INV-shared-tests-07: Key shared exports are stable ───────────────────────
// A curated subset of the shared public API must be present and callable. This
// provides a typing/export contract check: if a symbol is accidentally renamed
// or removed from index.ts, this test catches it without a full build.

test("INV-shared-tests-07: core validation symbols exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  // Validation.
  assert.equal(typeof shared.validateAuditFindingsReport, "function", "validateAuditFindingsReport — INV-shared-tests-07");
  assert.equal(typeof shared.isValidAuditFindingsReport, "function", "isValidAuditFindingsReport — INV-shared-tests-07");
  assert.equal(typeof shared.validateSessionConfig, "function", "validateSessionConfig — INV-shared-tests-07");
  assert.equal(typeof shared.prefixValidationIssues, "function", "prefixValidationIssues — INV-shared-tests-07");
  assert.equal(typeof shared.requireKeys, "function", "requireKeys — INV-shared-tests-07");
  assert.equal(typeof shared.AUDIT_FINDINGS_CONTRACT_VERSION, "string", "AUDIT_FINDINGS_CONTRACT_VERSION — INV-shared-tests-07");
});

test("INV-shared-tests-07: quota symbols exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  // Quota state.
  assert.equal(typeof shared.setQuotaStateDir, "function", "setQuotaStateDir — INV-shared-tests-07");
  assert.equal(typeof shared.readQuotaState, "function", "readQuotaState — INV-shared-tests-07");
  assert.equal(typeof shared.writeQuotaState, "function", "writeQuotaState — INV-shared-tests-07");
  assert.equal(typeof shared.recordWaveOutcome, "function", "recordWaveOutcome — INV-shared-tests-07");
  assert.equal(typeof shared.computeMaxSafeConcurrency, "function", "computeMaxSafeConcurrency — INV-shared-tests-07");

  // Capacity.
  assert.equal(typeof shared.computeDispatchCapacity, "function", "computeDispatchCapacity — INV-shared-tests-07");
  assert.equal(typeof shared.detectLivelock, "function", "detectLivelock — INV-shared-tests-07");
  assert.equal(typeof shared.buildEmptyPoolTerminal, "function", "buildEmptyPoolTerminal — INV-shared-tests-07");

  // Scheduler.
  assert.equal(typeof shared.scheduleWave, "function", "scheduleWave — INV-shared-tests-07");
  assert.equal(typeof shared.parseHostModelRoster, "function", "parseHostModelRoster — INV-shared-tests-07");

  // Lock.
  assert.equal(typeof shared.acquireLock, "function", "acquireLock — INV-shared-tests-07");
  assert.equal(typeof shared.releaseLock, "function", "releaseLock — INV-shared-tests-07");
  assert.equal(typeof shared.withFileLock, "function", "withFileLock — INV-shared-tests-07");
});

test("INV-shared-tests-07: provider factory symbols exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  assert.equal(typeof shared.createFreshSessionProvider, "function", "createFreshSessionProvider — INV-shared-tests-07");
  assert.equal(typeof shared.resolveFreshSessionProviderName, "function", "resolveFreshSessionProviderName — INV-shared-tests-07");
  assert.equal(typeof shared.spawnLoggedCommand, "function", "spawnLoggedCommand — INV-shared-tests-07");
});

test("INV-shared-tests-07: obligation ledger symbols exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  assert.equal(typeof shared.buildObligationLedger, "function", "buildObligationLedger — INV-shared-tests-07");
  assert.equal(typeof shared.detectObligationCycle, "function", "detectObligationCycle — INV-shared-tests-07");
  assert.equal(
    typeof shared.CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    "string",
    "CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION — INV-shared-tests-07",
  );
});

test("INV-shared-tests-07: finding identity and lens vocabulary exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  assert.equal(typeof shared.findingIdentity, "function", "findingIdentity — INV-shared-tests-07");
  assert.ok(Array.isArray(shared.LENSES) || shared.LENSES instanceof Set, "LENSES must be exported — INV-shared-tests-07");
  assert.ok(shared.VALID_LENSES instanceof Set, "VALID_LENSES must be a Set — INV-shared-tests-07");
  assert.ok(shared.VALID_SEVERITIES instanceof Set, "VALID_SEVERITIES must be a Set — INV-shared-tests-07");
  assert.ok(shared.VALID_CONFIDENCES instanceof Set, "VALID_CONFIDENCES must be a Set — INV-shared-tests-07");
});

test("INV-shared-tests-07: rolling dispatch symbols exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  assert.equal(typeof shared.createRollingDispatcher, "function", "createRollingDispatcher — INV-shared-tests-07");
  assert.equal(typeof shared.selectProvider, "function", "selectProvider — INV-shared-tests-07");
  assert.equal(typeof shared.InFlightTokenTracker, "function", "InFlightTokenTracker (class) — INV-shared-tests-07");
  assert.equal(
    typeof shared.ROLLING_DISPATCH_ENGINE_VERSION,
    "string",
    "ROLLING_DISPATCH_ENGINE_VERSION — INV-shared-tests-07",
  );
});

test("INV-shared-tests-07: observability and IO symbols exported from shared index", async () => {
  const shared = await import("../src/index.ts");

  assert.equal(typeof shared.RunLogger, "function", "RunLogger (class) — INV-shared-tests-07");
  assert.equal(typeof shared.readJsonFile, "function", "readJsonFile — INV-shared-tests-07");
  assert.equal(typeof shared.writeJsonFile, "function", "writeJsonFile — INV-shared-tests-07");
  assert.equal(typeof shared.appendNdjsonFile, "function", "appendNdjsonFile — INV-shared-tests-07");
  assert.equal(typeof shared.estimateTokensFromBytes, "function", "estimateTokensFromBytes — INV-shared-tests-07");
});
