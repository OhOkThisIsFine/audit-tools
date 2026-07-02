/**
 * Meta-invariants for the shared package test suite infrastructure.
 * INV-shared-tests-01 through INV-shared-tests-07.
 *
 * These tests verify that the test suite itself satisfies its structural
 * contracts: coverage completeness, framework consistency, and stable
 * export shape of the shared public API.
 */
import { test, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = resolve(__dirname);
const SRC_DIR = resolve(__dirname, "../../src/shared");

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
    expect(hidden.length, `Found ${hidden.length} .test.mjs file(s) in subdirectory '${dir.name}' — these are NOT covered by the package.json test glob (tests/*.test.mjs). Move them to the top-level tests/ directory.`).toBe(0);
  }

  // At least one test file must be present (sanity).
  expect(testFiles.length > 0, "tests/ must contain at least one .test.mjs file").toBeTruthy();
});

test("INV-shared-tests-01: vitest config picks up the shared .test.mjs glob", () => {
  const configPath = resolve(TESTS_DIR, "../../vitest.config.ts");
  expect(existsSync(configPath), "vitest.config.ts must exist at the repo root").toBeTruthy();
  const config = readFileSync(configPath, "utf8");
  // Single runner: vitest picks up all three areas. The shared suite is included
  // via the `tests/shared/**/*.test.mjs` glob (node:test was retired).
  expect(config.includes("tests/shared/**/*.test.mjs"), `vitest.config.ts must include the glob 'tests/shared/**/*.test.mjs' — INV-shared-tests-01`).toBeTruthy();
});

// ── INV-shared-tests-02: Test files use the single canonical runner (vitest) ──

test("INV-shared-tests-02: every .test.mjs file imports vitest", () => {
  const testFiles = readdirSync(TESTS_DIR).filter((f) =>
    f.endsWith(".test.mjs"),
  );

  const violations = [];
  for (const file of testFiles) {
    const content = readFileSync(resolve(TESTS_DIR, file), "utf8");
    // Must reference vitest — the single canonical runner. node:assert is still
    // permitted as an assertion library, but the runner must be vitest.
    if (!content.includes("from \"vitest\"") && !content.includes("from 'vitest'")) {
      violations.push(file);
    }
  }

  expect(violations, `The following test files do not import vitest — vitest is the single canonical runner in shared: ${violations.join(", ")} — INV-shared-tests-02`).toEqual([]);
});

test("INV-shared-tests-02: no .test.mjs file imports node:test, jest, mocha, or jasmine", () => {
  const testFiles = readdirSync(TESTS_DIR).filter((f) =>
    f.endsWith(".test.mjs"),
  );
  const disallowed = ["node:test", "jest", "mocha", "jasmine"];

  const violations = [];
  for (const file of testFiles) {
    const content = readFileSync(resolve(TESTS_DIR, file), "utf8");
    for (const framework of disallowed) {
      if (content.includes(`from '${framework}'`) || content.includes(`from "${framework}"`)) {
        violations.push(`${file} (imports ${framework})`);
      }
    }
  }

  expect(violations, `Non-canonical test runner found in shared test file(s) — only vitest is allowed: ${violations.join(", ")} — INV-shared-tests-02`).toEqual([]);
});

// ── INV-shared-tests-03: Schema invariant coverage is present ─────────────────
// INV-shared-core-01 (schema drift detection) must be covered by a test that
// can be located in the test suite. Regression-locking this prevents the schema
// guard from being accidentally deleted.

test("INV-shared-tests-03: shared-core-invariants.test.mjs exists and covers schema drift (INV-shared-core-01)", () => {
  const filePath = resolve(TESTS_DIR, "shared-core-invariants.test.mjs");
  expect(existsSync(filePath), "shared-core-invariants.test.mjs must exist in tests/ — INV-shared-tests-03 (schema invariant coverage)").toBeTruthy();
  const content = readFileSync(filePath, "utf8");
  expect(content.includes("INV-shared-core-01"), "shared-core-invariants.test.mjs must contain INV-shared-core-01 (schema drift detection) — INV-shared-tests-03").toBeTruthy();
  // Must reference the actual schema files under audit-code/schemas.
  expect(content.includes("finding.schema.json") || content.includes("audit_result.schema.json"), "shared-core-invariants.test.mjs must reference at least one audit-code schema file — INV-shared-tests-03").toBeTruthy();
});

test("INV-shared-tests-03: validateAuditFindingsReport is importable and validates contract_version", async () => {
  // Spot-check: the validation function referenced by INV-shared-core-06 is importable
  // and rejects an object missing contract_version.
  const { validateAuditFindingsReport } = await import("../../src/shared/validation/findingsReport.ts");
  const issues = validateAuditFindingsReport({ findings: [], work_blocks: [] });
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.some((i) => i.message.includes("contract_version")), "validateAuditFindingsReport must flag missing contract_version as an error — INV-shared-tests-03 schema guard").toBeTruthy();
});

// ── INV-shared-tests-04: Lock invariant coverage is present ──────────────────
// INV-shared-quota-06 (file lock token contract) must be covered. Regression-locking
// this prevents the lock-token clobber guard from being silently removed.

test("INV-shared-tests-04: shared-quota-invariants.test.mjs exists and covers lock token invariant (INV-shared-quota-06)", () => {
  const filePath = resolve(TESTS_DIR, "shared-quota-invariants.test.mjs");
  expect(existsSync(filePath), "shared-quota-invariants.test.mjs must exist — INV-shared-tests-04 (lock invariant coverage)").toBeTruthy();
  const content = readFileSync(filePath, "utf8");
  expect(content.includes("INV-shared-quota-06"), "shared-quota-invariants.test.mjs must cover INV-shared-quota-06 (lock token contract) — INV-shared-tests-04").toBeTruthy();
  // Must reference acquireLock / releaseLock.
  expect(content.includes("acquireLock") && content.includes("releaseLock"), "INV-shared-quota-06 tests must exercise acquireLock and releaseLock — INV-shared-tests-04").toBeTruthy();
});

test("INV-shared-tests-04: fileLock.ts exports acquireLock, releaseLock, withFileLock, and FileLockTimeoutError", async () => {
  const { acquireLock, releaseLock, withFileLock, FileLockTimeoutError } =
    await import("../../src/shared/quota/fileLock.ts");
  expect(typeof acquireLock, "acquireLock must be exported — INV-shared-tests-04").toBe("function");
  expect(typeof releaseLock, "releaseLock must be exported — INV-shared-tests-04").toBe("function");
  expect(typeof withFileLock, "withFileLock must be exported — INV-shared-tests-04").toBe("function");
  expect(typeof FileLockTimeoutError, "FileLockTimeoutError must be exported as a class — INV-shared-tests-04").toBe("function");
});

// ── INV-shared-tests-05: Concurrency invariant coverage is present ────────────
// INV-shared-quota-10 (parallel recordWaveOutcome convergence) and
// INV-shared-quota-01 (host-limit partitioning) must both be covered.

test("INV-shared-tests-05: shared-quota-invariants.test.mjs covers concurrency invariants (INV-shared-quota-01 and -10)", () => {
  const filePath = resolve(TESTS_DIR, "shared-quota-invariants.test.mjs");
  const content = readFileSync(filePath, "utf8");
  expect(content.includes("INV-shared-quota-01"), "shared-quota-invariants.test.mjs must cover INV-shared-quota-01 (host limit partitioning) — INV-shared-tests-05").toBeTruthy();
  expect(content.includes("INV-shared-quota-10"), "shared-quota-invariants.test.mjs must cover INV-shared-quota-10 (parallel recordWaveOutcome convergence) — INV-shared-tests-05").toBeTruthy();
});

test("INV-shared-tests-05: computeDispatchCapacity partitions shared host limit correctly (spot-check)", async () => {
  // Spot-verify the concurrency invariant without relying on the full test file.
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");

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
  expect(capacity.total_slots <= 2, `total_slots ${capacity.total_slots} must not exceed shared host limit 2 (concurrent over-dispatch guard) — INV-shared-tests-05`).toBeTruthy();
});

// ── INV-shared-tests-06: Cycle detection invariant coverage is present ────────
// INV-shared-core-07 (obligation cycle detection at construction) must be covered.

test("INV-shared-tests-06: shared-core-invariants.test.mjs covers obligation cycle detection (INV-shared-core-07)", () => {
  const filePath = resolve(TESTS_DIR, "shared-core-invariants.test.mjs");
  const content = readFileSync(filePath, "utf8");
  expect(content.includes("INV-shared-core-07"), "shared-core-invariants.test.mjs must cover INV-shared-core-07 (cycle detection at construction) — INV-shared-tests-06").toBeTruthy();
  expect(content.includes("cycle"), "INV-shared-core-07 tests must contain the word 'cycle' — INV-shared-tests-06").toBeTruthy();
});

test("INV-shared-tests-06: detectObligationCycle and buildObligationLedger are both exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");
  expect(typeof shared.detectObligationCycle, "detectObligationCycle must be exported from shared index — INV-shared-tests-06").toBe("function");
  expect(typeof shared.buildObligationLedger, "buildObligationLedger must be exported from shared index — INV-shared-tests-06").toBe("function");
});

test("INV-shared-tests-06: detectObligationCycle returns a non-null result for a direct cycle", async () => {
  const { detectObligationCycle } = await import("../../src/shared/types/obligationLedger.ts");
  const cycle = detectObligationCycle([
    { id: "X", description: "x", kind: "behavioral", depends_on: ["Y"], status: "pending" },
    { id: "Y", description: "y", kind: "behavioral", depends_on: ["X"], status: "pending" },
  ]);
  expect(Array.isArray(cycle) && cycle.length > 0, "direct cycle X→Y→X must be detected — INV-shared-tests-06").toBeTruthy();
  expect(cycle.includes("X") && cycle.includes("Y"), "cycle result must name both participants — INV-shared-tests-06").toBeTruthy();
});

test("INV-shared-tests-06: detectObligationCycle returns null for an acyclic graph", async () => {
  const { detectObligationCycle } = await import("../../src/shared/types/obligationLedger.ts");
  const result = detectObligationCycle([
    { id: "A", description: "a", kind: "behavioral", depends_on: [], status: "pending" },
    { id: "B", description: "b", kind: "behavioral", depends_on: ["A"], status: "pending" },
    { id: "C", description: "c", kind: "behavioral", depends_on: ["A", "B"], status: "pending" },
  ]);
  expect(result, "valid DAG must return null from detectObligationCycle — INV-shared-tests-06").toBe(null);
});

// ── INV-shared-tests-07: Key shared exports are stable ───────────────────────
// A curated subset of the shared public API must be present and callable. This
// provides a typing/export contract check: if a symbol is accidentally renamed
// or removed from index.ts, this test catches it without a full build.

test("INV-shared-tests-07: core validation symbols exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  // Validation.
  expect(typeof shared.validateAuditFindingsReport, "validateAuditFindingsReport — INV-shared-tests-07").toBe("function");
  expect(typeof shared.isValidAuditFindingsReport, "isValidAuditFindingsReport — INV-shared-tests-07").toBe("function");
  expect(typeof shared.validateSessionConfig, "validateSessionConfig — INV-shared-tests-07").toBe("function");
  expect(typeof shared.prefixValidationIssues, "prefixValidationIssues — INV-shared-tests-07").toBe("function");
  expect(typeof shared.requireKeys, "requireKeys — INV-shared-tests-07").toBe("function");
  expect(typeof shared.AUDIT_FINDINGS_CONTRACT_VERSION, "AUDIT_FINDINGS_CONTRACT_VERSION — INV-shared-tests-07").toBe("string");
});

test("INV-shared-tests-07: quota symbols exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  // Quota state.
  expect(typeof shared.setQuotaStateDir, "setQuotaStateDir — INV-shared-tests-07").toBe("function");
  expect(typeof shared.readQuotaState, "readQuotaState — INV-shared-tests-07").toBe("function");
  expect(typeof shared.writeQuotaState, "writeQuotaState — INV-shared-tests-07").toBe("function");
  expect(typeof shared.recordWaveOutcome, "recordWaveOutcome — INV-shared-tests-07").toBe("function");
  expect(typeof shared.computeMaxSafeConcurrency, "computeMaxSafeConcurrency — INV-shared-tests-07").toBe("function");

  // Capacity.
  expect(typeof shared.computeDispatchCapacity, "computeDispatchCapacity — INV-shared-tests-07").toBe("function");
  expect(typeof shared.detectLivelock, "detectLivelock — INV-shared-tests-07").toBe("function");
  expect(typeof shared.buildEmptyPoolTerminal, "buildEmptyPoolTerminal — INV-shared-tests-07").toBe("function");

  // Scheduler.
  expect(typeof shared.scheduleWave, "scheduleWave — INV-shared-tests-07").toBe("function");
  expect(typeof shared.parseHostModelRoster, "parseHostModelRoster — INV-shared-tests-07").toBe("function");

  // Lock.
  expect(typeof shared.acquireLock, "acquireLock — INV-shared-tests-07").toBe("function");
  expect(typeof shared.releaseLock, "releaseLock — INV-shared-tests-07").toBe("function");
  expect(typeof shared.withFileLock, "withFileLock — INV-shared-tests-07").toBe("function");
});

test("INV-shared-tests-07: provider factory symbols exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  expect(typeof shared.createFreshSessionProvider, "createFreshSessionProvider — INV-shared-tests-07").toBe("function");
  expect(typeof shared.resolveFreshSessionProviderName, "resolveFreshSessionProviderName — INV-shared-tests-07").toBe("function");
  expect(typeof shared.spawnLoggedCommand, "spawnLoggedCommand — INV-shared-tests-07").toBe("function");
});

test("INV-shared-tests-07: obligation ledger symbols exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  expect(typeof shared.buildObligationLedger, "buildObligationLedger — INV-shared-tests-07").toBe("function");
  expect(typeof shared.detectObligationCycle, "detectObligationCycle — INV-shared-tests-07").toBe("function");
  expect(typeof shared.CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION, "CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION — INV-shared-tests-07").toBe("string");
});

test("INV-shared-tests-07: finding identity and lens vocabulary exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  expect(typeof shared.findingIdentity, "findingIdentity — INV-shared-tests-07").toBe("function");
  expect(Array.isArray(shared.LENSES) || shared.LENSES instanceof Set, "LENSES must be exported — INV-shared-tests-07").toBeTruthy();
  expect(shared.VALID_LENSES instanceof Set, "VALID_LENSES must be a Set — INV-shared-tests-07").toBeTruthy();
  expect(shared.VALID_SEVERITIES instanceof Set, "VALID_SEVERITIES must be a Set — INV-shared-tests-07").toBeTruthy();
  expect(shared.VALID_CONFIDENCES instanceof Set, "VALID_CONFIDENCES must be a Set — INV-shared-tests-07").toBeTruthy();
});

test("INV-shared-tests-07: rolling dispatch symbols exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  expect(typeof shared.createRollingDispatcher, "createRollingDispatcher — INV-shared-tests-07").toBe("function");
  expect(typeof shared.selectProvider, "selectProvider — INV-shared-tests-07").toBe("function");
  expect(typeof shared.InFlightTokenTracker, "InFlightTokenTracker (class) — INV-shared-tests-07").toBe("function");
  expect(typeof shared.ROLLING_DISPATCH_ENGINE_VERSION, "ROLLING_DISPATCH_ENGINE_VERSION — INV-shared-tests-07").toBe("string");
});

test("INV-shared-tests-07: observability and IO symbols exported from shared index", async () => {
  const shared = await import("../../src/shared/index.ts");

  expect(typeof shared.RunLogger, "RunLogger (class) — INV-shared-tests-07").toBe("function");
  expect(typeof shared.readJsonFile, "readJsonFile — INV-shared-tests-07").toBe("function");
  expect(typeof shared.writeJsonFile, "writeJsonFile — INV-shared-tests-07").toBe("function");
  expect(typeof shared.appendNdjsonFile, "appendNdjsonFile — INV-shared-tests-07").toBe("function");
  expect(typeof shared.estimateTokensFromBytes, "estimateTokensFromBytes — INV-shared-tests-07").toBe("function");
});
