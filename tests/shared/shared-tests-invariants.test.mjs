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
  expect(typeof shared.readQuotaStateOrDegrade, "readQuotaStateOrDegrade — INV-shared-tests-07").toBe("function");
  // NEGATIVE: the learned-concurrency inference is deleted, not merely unused.
  // Concurrency is DECLARED by the provider or ABSENT — never learned from an
  // outcome stream. Re-exporting a computeMaxSafeConcurrency would resurrect it.
  expect(shared.computeMaxSafeConcurrency, "computeMaxSafeConcurrency must NOT exist").toBeUndefined();
  expect(shared.computeRampUpConcurrency, "computeRampUpConcurrency must NOT exist").toBeUndefined();

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

// ── INV-WH: every console-popping test/script spawn hides the window on win32 ──
// A windowless parent (node under an IDE/agent) spawning a console child pops a
// console window on win32 unless `windowsHide: true` is passed — and Node's own
// default for `windowsHide` is `false`. Production spawns already route through
// the shared `spawnSyncHidden` / `spawnHidden`. This guard extends the same
// property, mechanically, across the WHOLE test tree plus the two dev/CI scripts
// that spawn (`scripts/release-and-publish.mjs`, `scripts/postinstall.mjs`), so a
// newly-added raw spawn can never silently reintroduce a window flash.
//
// The guard's assertion surface is exactly the rewrite surface: it enumerates the
// same files the sweep touched (every test file / target script that reaches into
// `node:child_process`) and fails the moment one of them spawns without hiding.
//
// Two enforcement rules, one per file class:
//   • Test files must NOT import a spawn/exec entry point from "node:child_process"
//     directly — they route through tests/helpers/spawn.mjs (whose `*Hidden`
//     wrappers force `windowsHide: true`), or via an aliased import from it. The
//     sole exception is a file that fully mocks the module (`vi.mock(
//     "node:child_process")`): there the imported symbol is a test double, and any
//     REAL spawn in that file is separately windowsHide-wrapped.
//   • The two scripts run in the published-package / fresh-install context where
//     the tests helper is not importable, so each raw child_process call there must
//     carry `windowsHide` inline.

const REPO_ROOT = resolve(__dirname, "../..");
const TESTS_ROOT = resolve(__dirname, "..");
const SCRIPTS_ROOT = resolve(REPO_ROOT, "scripts");
const SPAWN_HELPER = resolve(TESTS_ROOT, "helpers/spawn.mjs");

// Files under tests/ that are EXECUTED AS SPAWNED CHILD `node` processes (not run
// under vitest) cannot import tests/helpers/spawn.mjs — it transitively imports
// the shared `src/shared/tooling/exec.ts` source, which a plain node child can't
// load (ERR_UNKNOWN_FILE_EXTENSION ".ts"). They use raw node:child_process with
// `windowsHide: true` inline instead, verified by the inline-windowsHide check
// below rather than the no-raw-import walk.
const CHILD_EXECUTED_SPAWN_FILES = [
  resolve(TESTS_ROOT, "audit/helpers/provider-assisted-bridge.mjs"),
];

// The child_process entry points that create a subprocess (and thus a window).
const SPAWN_CALLEES = ["spawnSync", "spawn", "execSync", "execFileSync", "execFile", "exec"];

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dot-prefixed dirs are transient test fixtures (e.g. a concurrently-running
    // remediate test's `tests/remediate/.test-*/` scratch tree it creates and
    // deletes mid-run) — never real test source. Skipping them keeps the scan off
    // files that vanish between readdir and readFile under a concurrent `vitest run`.
    if (entry.isDirectory() && entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// A file discovered by the walk can still vanish before it is read (a concurrent
// test tears down its fixture tree mid-scan). A file that no longer exists is not a
// violation — tolerate the ENOENT and skip it, rethrowing anything else.
function readFileIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// Does an import statement from the child_process module pull in a spawn/exec name?
// BOTH specifiers must be accepted: `node:child_process` AND the bare `child_process`.
// The guard once matched only the `node:`-prefixed form, which silently exempted every
// file using the bare specifier (that hole is how two smoke scripts reintroduced a
// window flash). Never narrow this back to one specifier.
function importsRawChildProcessSpawn(source) {
  // Match `import { … } from "child_process"` / `"node:child_process"` (either quote).
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (names.some((n) => SPAWN_CALLEES.includes(n))) return true;
  }
  return false;
}

// A raw child_process call site, excluding method calls on some other object — without
// the leading-dot exclusion a plain `someRegex.exec(source)` reads as `child_process.exec()`.
function rawCallRegex(callee) {
  return new RegExp(`(?<![.\\w$])${callee}\\s*\\(`, "g");
}

test("INV-WH: tests/helpers/spawn.mjs exists and exports the window-hidden spawn wrappers", async () => {
  expect(existsSync(SPAWN_HELPER), "tests/helpers/spawn.mjs must exist — INV-WH (shared window-hidden spawn helper)").toBeTruthy();
  const helper = await import("../helpers/spawn.mjs");
  for (const name of ["spawnHidden", "spawnSyncHidden", "execFileSyncHidden", "execSyncHidden", "execFileHidden"]) {
    expect(typeof helper[name], `tests/helpers/spawn.mjs must export ${name} — INV-WH`).toBe("function");
  }
});

test("INV-WH: shared exec.ts exports both spawnSyncHidden and spawnHidden (single source)", async () => {
  const shared = await import("../../src/shared/index.ts");
  expect(typeof shared.spawnSyncHidden, "spawnSyncHidden must be exported from shared — INV-WH").toBe("function");
  expect(typeof shared.spawnHidden, "spawnHidden must be exported from shared — INV-WH").toBe("function");
});

test("INV-WH: no test file imports a raw spawn/exec entry point from node:child_process", () => {
  const files = walkFiles(TESTS_ROOT).filter(
    (f) =>
      (f.endsWith(".mjs") || f.endsWith(".ts")) &&
      f !== SPAWN_HELPER &&
      !CHILD_EXECUTED_SPAWN_FILES.includes(f),
  );

  const violations = [];
  let scanned = 0;
  for (const file of files) {
    const source = readFileIfPresent(file);
    if (source === null) continue;
    if (!importsRawChildProcessSpawn(source)) continue;
    // A file that fully mocks node:child_process binds the imported spawn symbol
    // to a test double; its real spawns are windowsHide-wrapped separately.
    if (source.includes('vi.mock("node:child_process"') || source.includes("vi.mock('node:child_process'")) {
      continue;
    }
    scanned += 1;
    violations.push(file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"));
  }

  expect(
    violations,
    `These test files import a raw spawn/exec entry point from node:child_process — route them through tests/helpers/spawn.mjs (spawnHidden / spawnSyncHidden / execFileSyncHidden / execSyncHidden / execFileHidden) so a windowless parent does not flash a console window on win32: ${violations.join(", ")} — INV-WH`,
  ).toEqual([]);
  // Sanity: the guard actually walked the tree (guards against a broken walker
  // silently passing). `scanned` counts only violations, so we assert the walk
  // found a representative set of files instead.
  expect(files.length > 20, "INV-WH walker must discover the test tree").toBeTruthy();
});

test("INV-WH: EVERY spawn-carrying script + child-executed test helper hides the window on every raw call", () => {
  // Enumerate by WALKING `scripts/`, never by whitelist. A hardcoded two-file list is
  // exactly how `scripts/check-doc-manifest.mjs` (run inside `verify:checks`) and
  // `scripts/remediate/smoke-linked-remediate-code.mjs` silently reintroduced a console
  // flash: they simply were not on the list. Any NEW spawning script is now covered the
  // moment it lands, with no one having to remember to register it.
  const scripts = [
    ...walkFiles(SCRIPTS_ROOT).filter((f) => f.endsWith(".mjs")),
    ...CHILD_EXECUTED_SPAWN_FILES,
  ];

  const violations = [];
  let scanned = 0;
  for (const script of scripts) {
    expect(existsSync(script), `${script} must exist — INV-WH`).toBeTruthy();
    const source = readFileSync(script, "utf8");
    // Only scripts that actually reach into child_process can pop a window.
    if (!importsRawChildProcessSpawn(source)) continue;
    scanned += 1;
    // Find each raw child_process call and require windowsHide within the call's
    // option object (the ~600 chars following the callee comfortably cover the
    // multi-line option objects these scripts use).
    for (const callee of SPAWN_CALLEES) {
      const callRe = rawCallRegex(callee);
      let m;
      while ((m = callRe.exec(source)) !== null) {
        const window = source.slice(m.index, m.index + 600);
        if (!/windowsHide\s*:/.test(window)) {
          const rel = script.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
          violations.push(`${rel}: ${callee}() near offset ${m.index} lacks windowsHide`);
        }
      }
    }
  }

  expect(
    violations,
    `These script spawn calls do not pass windowsHide:true, so a windowless parent flashes a console window on win32 — add windowsHide:true to each: ${violations.join("; ")} — INV-WH`,
  ).toEqual([]);
  // Sanity: a broken walker (or a regex that stops matching the import form) must not
  // silently pass by scanning nothing.
  expect(scanned >= 6, `INV-WH must scan the spawn-carrying scripts (scanned ${scanned})`).toBeTruthy();
});
