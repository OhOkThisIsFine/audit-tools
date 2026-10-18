/**
 * vitest-gate-false-red.test.mjs — the gate's NONZERO-exit verdict.
 *
 * The gate already defends the false-GREEN case (exit 0 with reported failures).
 * This pins its mirror: vitest exits nonzero because its worker RPC timed out
 * under load while every test passed and the reporter finished cleanly. Observed
 * twice in one lap on the full three-area run — `Tests 7400 passed | 0 failed`
 * alongside `Errors 1 error` and a nonzero status.
 *
 * A green run that reads red by exit code is not a harmless annoyance: it is the
 * same false-signal class as a false green, and it trains a reader to wave at
 * reds — which is precisely how `main` sat red for ~a dozen laps while every lap
 * reported "green".
 *
 * The downgrade is deliberately NARROW, and each guard below is a way the naive
 * version ("nonzero but nothing failed ⇒ pass") would swallow a real red.
 */
import { test, expect } from "vitest";
import { isReporterTransportFault, HARNESS_FAULT } from "../../scripts/shared/vitestGateVerdict.mjs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { constants, tmpdir } from "node:os";
import { resolve } from "node:path";

const TOKEN = "run-token-abc";
const RPC_TIMEOUT_STDERR = `
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.js:53:10
`;
const greenLedger = { runToken: TOKEN, outcome: { passed: 7400, failed: 0, skipped: 4, unfinished: 0 } };

test("downgrades a nonzero exit when THIS run's ledger is green and stderr shows the RPC fault", () => {
  expect(
    isReporterTransportFault({ record: greenLedger, token: TOKEN, stderrText: RPC_TIMEOUT_STDERR }),
  ).toBe(true);
});

test("keeps the red when a test actually failed, RPC fault or not", () => {
  // A worker RPC timeout can co-occur with genuine failures; the failures win.
  expect(
    isReporterTransportFault({
      record: { runToken: TOKEN, outcome: { passed: 10, failed: 1 } },
      token: TOKEN,
      stderrText: RPC_TIMEOUT_STDERR,
    }),
  ).toBe(false);
});

test("keeps the red when the nonzero exit has NO recognized harness signature", () => {
  // The critical guard. A crashed worker also exits nonzero having COUNTED zero
  // failures — precisely because its tests never ran. Downgrading on "nothing
  // failed" alone would silently pass a suite that never executed.
  expect(
    isReporterTransportFault({ record: greenLedger, token: TOKEN, stderrText: "FATAL: worker pool died" }),
  ).toBe(false);
  expect(isReporterTransportFault({ record: greenLedger, token: TOKEN, stderrText: "" })).toBe(false);
});

test("keeps the red when the green ledger belongs to a DIFFERENT run", () => {
  // Without the token check, yesterday's green ledger would launder today's red.
  expect(
    isReporterTransportFault({
      record: { ...greenLedger, runToken: "some-older-run" },
      token: TOKEN,
      stderrText: RPC_TIMEOUT_STDERR,
    }),
  ).toBe(false);
});

test("keeps the red when a leaf never REPORTED, even though nothing was counted as failed", () => {
  // The hole this narrow downgrade left open. HARNESS_FAULT matches a timeout on
  // `onTaskUpdate` — the RPC that carries task RESULTS. A result lost to that very
  // timeout leaves its leaf with no state, so a genuinely failed test is never
  // counted and `failed === 0` holds vacuously. Every other downgrade condition is
  // satisfied here; only the unfinished count separates "we never heard back" from
  // "deliberately skipped", and it is what must keep this red.
  expect(
    isReporterTransportFault({
      record: { runToken: TOKEN, outcome: { passed: 7399, failed: 0, skipped: 4, unfinished: 1 } },
      token: TOKEN,
      stderrText: RPC_TIMEOUT_STDERR,
    }),
  ).toBe(false);
});

test("keeps the red when the ledger predates the unfinished counter", () => {
  // An older reporter's ledger cannot PROVE every leaf reported, and absence of
  // evidence must not read as evidence of absence in a gate that can pass a
  // release. Fail closed.
  expect(
    isReporterTransportFault({
      record: { runToken: TOKEN, outcome: { passed: 7400, failed: 0, skipped: 4 } },
      token: TOKEN,
      stderrText: RPC_TIMEOUT_STDERR,
    }),
  ).toBe(false);
});

test("keeps the red when there is no usable ledger at all", () => {
  for (const record of [null, undefined, {}, { runToken: TOKEN }, "not-an-object"]) {
    expect(
      isReporterTransportFault({ record, token: TOKEN, stderrText: RPC_TIMEOUT_STDERR }),
      `record ${JSON.stringify(record)} must not downgrade a red`,
    ).toBe(false);
  }
});

test("the harness signature matches the observed form and not arbitrary prose", () => {
  expect(HARNESS_FAULT.test('[vitest-worker]: Timeout calling "onTaskUpdate"')).toBe(true);
  expect(HARNESS_FAULT.test('[vitest-worker]: Timeout calling "onCollected"')).toBe(true);
  // Test NAMES are author-chosen prose and must never trip it — the same
  // shortcut that produced two false hits when the gate grepped stdout.
  expect(HARNESS_FAULT.test('✓ handles a Timeout calling "onTaskUpdate" gracefully')).toBe(false);
});

test("the full-suite gate owns isolated reruns, observation recording, and repeated-failure repair dispatch", () => {
  const source = readFileSync(resolve("scripts/shared/run-vitest-gate.mjs"), "utf8");
  expect(source).toContain("runIsolatedDiagnostics({ record: transportRecord, attribution })");
  expect(source).toContain("runIsolatedDiagnostics({ record, attribution })");
  expect(source).toContain("AUDIT_TOOLS_ISOLATED_LOAD_DIAGNOSTIC");
  expect(source).toContain("observeAndClaimLoadFlake");
  expect(source).toContain('resolve(profileDir, "load-flake-record.json")');
  expect(source).toContain("dispatch-load-flake-investigation.mjs");
  expect(source).toContain("original gate remains RED");
});

// Exercise the real runner in a tiny Git checkout: a positive stamp control
// prevents a broken fixture from making the abnormal-exit assertions vacuous.
interface GateCase {
  status?: number | null;
  signal?: string | null;
  error?: string;
  ledger?: "missing" | "stale" | "fresh";
  failed?: number;
  unfinished?: number;
  stderr?: string;
  args?: string[];
  sentinel?: boolean;
  mutateTree?: boolean;
}

function runGateCase(scenario: GateCase) {
  const root = mkdtempSync(resolve(tmpdir(), "vitest-gate-boundary-"));
  const stamp = resolve(root, ".claude/hooks/.state/suite-green/latest.json");
  const put = (path: string, text: string) => {
    const target = resolve(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    for (const file of [
      "run-vitest-gate.mjs", "vitestShard.mjs", "vitestGateVerdict.mjs",
      "worktree-tree.mjs", "suiteGreenStamp.mjs", "load-flake-record.mjs", "primitives.mjs",
      "loopCoreAttestationLedger.mjs",
    ]) {
      mkdirSync(resolve(root, "scripts/shared"), { recursive: true });
      copyFileSync(resolve("scripts/shared", file), resolve(root, "scripts/shared", file));
    }
    mkdirSync(resolve(root, '.claude/hooks'), { recursive: true });
    copyFileSync(resolve('.claude/hooks/loop-core-patterns.mjs'), resolve(root, '.claude/hooks/loop-core-patterns.mjs'));
    put("package.json", '{"type":"module"}');
    put(".gitignore", "node_modules/\n.audit-tools-profile/\n.claude/hooks/.state/\nchild-calls.jsonl\n");
    put("node_modules/vitest/package.json", '{"name":"vitest"}');
    put("node_modules/vitest/vitest.mjs", 'throw new Error("must be intercepted");');
    // Not a lock test: fail loudly if an abnormal exit reaches observations.
    put("dist/shared/io/fileLock.js", 'export function withFileLock() { throw new Error("unexpected load-only observation"); }');
    put("scenario.json", JSON.stringify(scenario));
    put("preload.cjs", `
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const original = cp.spawnSync;
const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario.json"), "utf8"));
cp.spawnSync = (command, args, options) => {
  if (command === process.execPath) {
    fs.appendFileSync(path.join(__dirname, "child-calls.jsonl"), JSON.stringify(args) + "\\n");
    if (args[1] !== "run") throw new Error("unexpected isolated diagnostic");
    if (scenario.mutateTree) fs.writeFileSync(path.join(__dirname, "during-run.txt"), "changed");
    const ledger = scenario.ledger ?? "fresh";
    if (ledger !== "missing") {
      const profile = path.join(__dirname, ".audit-tools-profile");
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, "vitest-latest.json"), JSON.stringify({
        runToken: ledger === "fresh" ? options.env.VITEST_GATE_TOKEN : "previous-run",
        outcome: { passed: 2, failed: scenario.failed ?? 0, skipped: 0, total: 2 + (scenario.failed ?? 0) + (scenario.unfinished ?? 0),
          unfinished: scenario.unfinished ?? 0,
          failedFiles: scenario.failed ? ["tests/failed.test.ts"] : [] }
      }));
    }
    return { status: scenario.status, signal: scenario.signal ?? null,
      error: scenario.error ? new Error(scenario.error) : undefined,
      stderr: scenario.stderr ?? "", stdout: "" };
  }
  return original(command, args, options);
};
require("node:module").syncBuiltinESMExports();
`);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("add", "-A");
    // A real HEAD is required by worktreeTree; fixture-only plumbing avoids
    // invoking any developer hooks or creating a commit in the live checkout.
    const tree = git("write-tree");
    const commit = git("-c", "user.name=Gate fixture", "-c", "user.email=fixture@example.invalid",
      "commit-tree", tree, "-m", "Gate fixture");
    git("update-ref", "HEAD", commit);
    if (scenario.sentinel) put(".claude/hooks/.state/suite-green/latest.json", "existing-stamp");
    const result = spawnSync(process.execPath, ["--require", resolve(root, "preload.cjs"),
      resolve(root, "scripts/shared/run-vitest-gate.mjs"), ...(scenario.args ?? [])],
    { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const calls = readFileSync(resolve(root, "child-calls.jsonl"), "utf8").trim().split("\n");
    return { status: result.status, stderr: result.stderr, calls,
      stamp: existsSync(stamp) ? readFileSync(stamp, "utf8") : null,
      loadRecord: existsSync(resolve(root, ".audit-tools-profile/load-flake-record.json")),
      investigation: existsSync(resolve(root, ".audit-tools-profile/load-flake-investigations")) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const abnormalCases: [string, GateCase, RegExp][] = [
  ["signal with no ledger", { status: null, signal: "SIGKILL", ledger: "missing" }, /SIGKILL/],
  ["signal with stale ledger", { status: null, signal: "SIGKILL", ledger: "stale" }, /SIGKILL/],
  ["signal after green ledger", { status: null, signal: "SIGKILL" }, /SIGKILL/],
  ["signal with reporter timeout", { status: null, signal: "SIGKILL", stderr: RPC_TIMEOUT_STDERR }, /SIGKILL/],
  ["signal with failed-file ledger", { status: null, signal: "SIGKILL", failed: 1, stderr: RPC_TIMEOUT_STDERR }, /SIGKILL/],
  ["signal preserves existing stamp", { status: null, signal: "SIGKILL", sentinel: true }, /SIGKILL/],
  ["unknown signal", { status: null, signal: "UNKNOWN_SIGNAL" }, /UNKNOWN_SIGNAL/],
  ["spawn error with reporter timeout", { status: null, error: "synthetic spawn error", stderr: RPC_TIMEOUT_STDERR }, /synthetic spawn error/],
  ["missing status", { status: null }, /without an exit status/],
  ["undefined status with reporter timeout", { stderr: RPC_TIMEOUT_STDERR }, /without an exit status/],
];
for (const [name, scenario, diagnostic] of abnormalCases) {
  test(`runner rejects ${name} before reporter forgiveness or isolated diagnostics`, () => {
    const result = runGateCase(scenario);
    assert.notEqual(result.status, 0);
    if (scenario.signal === "SIGKILL") {
      const number = constants.signals.SIGKILL;
      assert.equal(result.status, typeof number === "number" ? 128 + number : 1);
    }
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, /\[vitest-gate\] ATTRIBUTION: unattributable/);
    assert.doesNotMatch(result.stderr, /Treating as PASS|isolated diagnostic|LOAD-ONLY/);
    assert.equal(result.stamp, scenario.sentinel ? "existing-stamp" : null);
    assert.equal(result.calls.length, 1);
    assert.equal(result.loadRecord, false);
    assert.equal(result.investigation, false);
  });
}

const numericCases: [string, GateCase, number, boolean][] = [
  ["ordinary numeric failure", { status: 7 }, 7, false],
  ["supported reporter forgiveness", { status: 1, stderr: RPC_TIMEOUT_STDERR }, 0, true],
  ["ordinary success", { status: 0 }, 0, true],
  ["during-run edit does not mint a stamp", { status: 0, mutateTree: true }, 0, false],
  ["zero-exit unfinished run does not mint a stamp", { status: 0, unfinished: 1 }, 0, false],
  ["filtered success", { status: 0, args: ["tests/example.test.ts"] }, 0, false],
  ["missing ledger", { status: 0, ledger: "missing" }, 1, false],
  ["stale ledger", { status: 0, ledger: "stale" }, 1, false],
  ["unfinished reporter run", { status: 1, unfinished: 1, stderr: RPC_TIMEOUT_STDERR }, 1, false],
  // Filtered failure avoids deliberately executing the separate solo-rerun workflow.
  ["real failure with timeout", { status: 7, failed: 1, stderr: RPC_TIMEOUT_STDERR,
    args: ["tests/failed.test.ts"] }, 7, false],
];
for (const [name, scenario, status, stamped] of numericCases) {
  test(`runner preserves ${name}`, () => {
    const result = runGateCase(scenario);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stamp !== null, stamped);
    if (stamped) {
      const stamp = JSON.parse(result.stamp!);
      assert.match(stamp.tree, /^[0-9a-f]{40,64}$/);
      assert.equal(stamp.run_evidence.tree_before, stamp.tree);
      assert.equal(stamp.run_evidence.tree_after, stamp.tree);
      assert.equal(stamp.run_evidence.reporter.runToken, stamp.run_evidence.run_token);
      assert.deepEqual(stamp.run_evidence.vitest_args, []);
    }
    assert.equal(result.calls.length, 1);
  });
}

test("Node represents a real signal-killed child without a numeric exit status", () => {
  // Windows does not promise POSIX self-signal semantics. Injected runner cases
  // above still exercise its rejection and fallback mapping on every platform.
  if (process.platform === "win32") return;
  const result = spawnSync(process.execPath, ["-e", 'process.kill(process.pid, "SIGKILL")'],
    { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.error, undefined);
});
