/**
 * No worker blocks its event loop ≥ 60s in a synchronous spawn.
 *
 * The claim this pins comes from the "vitest worker RPC starvation" entry: the
 * false-RED exit is closed at the gate, but the >60s blocking worker was never
 * LOCATED. A sync spawn (`spawnSync*`) holds its worker's event loop for the
 * whole child run, starving vitest's worker RPC, the pool heartbeats, and every
 * `setTimeout` in that worker. The observable symptom is a test that reads as
 * flaky under load; the cause is a command nobody measured.
 *
 * MEASURED, NOT REVIEWED. `tests/helpers/trackedSpawn.ts` wraps the sync spawn
 * helper and appends one `(file, command, ms)` row per call to a run-scoped
 * ledger; this file is the gate over that ledger. A contributor who makes a
 * checker slow — a network call, a full-tree walk, an accidental recursion —
 * gets a red test naming the command and the file, without anyone having to
 * remember the budget exists.
 *
 * The budget is single-sourced as `SYNC_BLOCK_BUDGET_MS`; this test asserts
 * against that constant, never a second copy of the number.
 *
 * WHAT IT CANNOT SEE, stated so the covered half is not read as a close: a sync
 * spawn that bypasses the helper (a raw `node:child_process` import) is not
 * recorded. `tests/shared/shared-tests-invariants.test.mjs` (INV-WH) is the
 * sibling guard that fails a test file importing a raw spawn entry point, so the
 * uncovered half is closed by a different mechanism rather than left to memory.
 */
import { describe, it, expect } from "vitest";
// Imported from `trackedSpawn.js` — the module that OWNS the ledger — rather
// than through the `tests/helpers/spawn.mjs` bridge. Both work at runtime, but
// only a `.ts` import site is visible to `check:deadcode`: knip does not follow
// a `.mjs` re-export into a `.ts` module, so an export reached only through the
// bridge reads as dead. `tests/shared/run-hermeticity.test.ts` takes the same
// route for the same reason.
import {
  CLI_CALL_DEADLINE_MS,
  SYNC_BLOCK_BUDGET_MS,
  currentTestFile,
  readSyncSpawns,
  runBounded,
  spawnSyncHidden,
  syncSpawnsOverBudget,
  type SyncSpawnRecord,
} from "../helpers/trackedSpawn.js";

/** A child that never exits on its own — the wedge, reproduced in one line. */
const NEVER_EXITS = ["-e", "setInterval(() => {}, 1000)"];

/** A tiny synchronous spawn that always succeeds and is certainly under budget. */
function trivialSpawn(): void {
  const result = spawnSyncHidden(process.execPath, ["-e", "0"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
}

describe("the sync-spawn ledger records what it claims to", () => {
  it("a synchronous spawn appends a row naming the command it ran", () => {
    const before = readSyncSpawns().length;
    trivialSpawn();
    const after = readSyncSpawns();

    expect(
      after.length,
      "the wrapper must record one row per sync spawn, or the gate over it is vacuous",
    ).toBeGreaterThan(before);

    const last = after[after.length - 1]!;
    expect(last.command).toContain(process.execPath);
    expect(typeof last.ms).toBe("number");
    expect(last.ms).toBeGreaterThanOrEqual(0);
    expect(last.file, "each row must name the test file that spawned it").toMatch(/\.test\.ts$/);
  });

  it("the budget predicate separates an over-budget row from the rest — non-vacuous self-check", () => {
    // Driven with SYNTHETIC records so the predicate is proven to have teeth
    // without making the suite actually block for a minute. A budget test whose
    // only input is a fast run cannot distinguish "nothing was slow" from "the
    // comparison never fires", and that is precisely the false-green shape.
    const synthetic: SyncSpawnRecord[] = [
      { file: "tests/shared/example.test.ts", command: "node slow.mjs", ms: 90_000 },
      { file: "tests/shared/example.test.ts", command: "node fast.mjs", ms: 120 },
      { file: "tests/shared/example.test.ts", command: "node exact.mjs", ms: SYNC_BLOCK_BUDGET_MS },
    ];
    const over = syncSpawnsOverBudget(synthetic);

    expect(over.map((r) => r.command)).toEqual(["node slow.mjs", "node exact.mjs"]);
    // Worst first: the first row a reader sees is the one to fix.
    expect(over[0]!.ms).toBe(90_000);
  });
});

describe("the ledger attributes a spawn to a test file on both platforms", () => {
  // The parser is driven with SYNTHETIC stacks rather than the real one: the
  // real stack only ever exercises this host's path shape, so a Linux-only or
  // win32-only frame would go untested on the other platform. Splitting the
  // drive letter and both separators is exactly the part that breaks silently.
  it("reads a win32 frame with a drive letter and backslashes", () => {
    const stack = [
      "Error",
      "    at recordSyncSpawn (C:\\repo\\tests\\helpers\\trackedSpawn.ts:180:3)",
      "    at Object.<anonymous> (C:\\repo\\tests\\shared\\example.test.ts:42:5)",
    ].join("\n");
    expect(currentTestFile(stack)).toBe("C:/repo/tests/shared/example.test.ts");
  });

  it("reads a posix frame, and the bare no-parens form", () => {
    expect(
      currentTestFile("    at Object.<anonymous> (/repo/tests/audit/other.test.mjs:7:1)"),
    ).toBe("/repo/tests/audit/other.test.mjs");
    expect(currentTestFile("    at /repo/tests/shared/bare.test.ts:9:2")).toBe(
      "/repo/tests/shared/bare.test.ts",
    );
  });

  it("NAMES an unattributable stack instead of inventing a file", () => {
    // Returning the first path-looking token would charge the row to a test that
    // did not spawn it — worse than admitting the miss, because it reads as
    // evidence.
    expect(currentTestFile("Error\n    at somewhere/else.ts:1:1")).toBe("(unknown test file)");
    expect(currentTestFile("")).toBe("(unknown test file)");
  });
});

describe("the async CLI bound fails at the command, not as a test-ceiling abort", () => {
  // The CI orchestration shard's failure mode: a wedged `next-step` leaves the
  // 300s test ceiling to fire on a different test each run, with the child still
  // alive. The bound has to reject FIRST, naming what it waited on.

  it("a never-exiting child REJECTS at the bound instead of pending forever", async () => {
    const started = Date.now();
    const error = await runBounded(process.execPath, NEVER_EXITS, {
      timeoutMs: 1_500,
      killGraceMs: 500,
    }).then(
      () => null,
      (caught: Error) => caught,
    );
    const elapsed = Date.now() - started;

    // Getting here at all is the assertion that matters: before the bound the
    // promise never settled, so this test would fail by TIMING OUT — which is
    // precisely the unattributable signal the bound exists to replace.
    expect(error, "a child that never exits must reject, not resolve").not.toBeNull();
    expect(elapsed, `rejection must happen at the bound, took ${String(elapsed)}ms`).toBeLessThan(60_000);
  });

  it("the rejection NAMES the command, the bound, and the child — not just 'timed out'", async () => {
    const error = await runBounded(process.execPath, NEVER_EXITS, {
      timeoutMs: 1_500,
      killGraceMs: 500,
    }).then(
      () => null,
      (caught: Error) => caught,
    );

    // A bare "timed out" is the message this replaces: the reader had to guess
    // which of a walk's many CLI calls wedged.
    expect(error!.message).toContain(NEVER_EXITS[1]!);
    expect(error!.message).toContain("1500ms");
    expect(error!.message).toMatch(/pid \d+/u);
    expect(error!.message).toContain("SIGKILL");
  });

  it("the deadline is one exported formulation, and it sits below the test ceiling", () => {
    // Call sites consume this, never their own number — the same rule
    // RUNTIME_COMMAND_TIMEOUT_MS is pinned by in the audit tree.
    expect(Number.isFinite(CLI_CALL_DEADLINE_MS)).toBe(true);
    expect(CLI_CALL_DEADLINE_MS).toBeGreaterThan(0);
    // Under the 300s vitest config ceiling: the CALL must fail first, so the
    // ceiling can only be reached by a walk genuinely doing work.
    expect(CLI_CALL_DEADLINE_MS).toBeLessThan(300_000);
  });

  it("a normal child still resolves with its output — the bound does not swallow the happy path", async () => {
    const result = await runBounded(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 30_000,
    });
    expect(result.stdout).toBe("ok");
  });

  it("a non-zero exit REJECTS carrying the child's stderr, not just a code", async () => {
    const error = await runBounded(
      process.execPath,
      ["-e", "process.stderr.write('the real cause'); process.exit(3)"],
      { timeoutMs: 30_000 },
    ).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error!.message).toContain("the real cause");
    expect(error!.message).toContain("3");
  });
});

describe("no synchronous spawn in this run exceeded the blocking budget", () => {
  it(`every recorded sync spawn blocked < ${String(SYNC_BLOCK_BUDGET_MS)}ms`, () => {
    // The assertion is over THIS run's ledger. That is the honest scope: the
    // ledger is run-scoped by construction (it lives under the per-invocation
    // temp root), so a run that touched no slow command reports nothing rather
    // than inheriting a stale observation.
    const over = syncSpawnsOverBudget();
    expect(
      over,
      over
        .map(
          (row) =>
            `${row.file} blocked ${String(row.ms)}ms on: ${row.command}\n` +
            `  → a sync spawn holds the worker's event loop for its whole run, starving vitest's ` +
            `worker RPC and every timer in that worker. Move it to the async twin (runTrackedAsync ` +
            `/ spawnHidden + await), or make the command fast — raising SYNC_BLOCK_BUDGET_MS needs a ` +
            `measurement in tests/helpers/trackedSpawn.ts, not a bigger number.`,
        )
        .join("\n"),
    ).toEqual([]);
  });
});
