/**
 * Run hermeticity: a vitest invocation leaves no child of its own still running.
 *
 * WHAT THIS PINS. A leak that lands AFTER teardown belongs to a child that
 * outlived the run, and by the time its file appears the run that spawned it is
 * gone. So the child, not the file, is what gets caught: every async spawn is
 * recorded in a per-run ledger (`tests/helpers/trackedSpawn.ts`) and teardown
 * fails on whatever is still alive, naming pid and command. The run answers for
 * processes it STARTED, which it can establish, rather than for files it may or
 * may not have written, which it cannot.
 *
 * ⚠ This file used to pin a second half — that a run leaves the REPO ROOT as it
 * found it, via a `setup`/`teardown` entry-list delta. That half was DELETED on
 * 2026-08-30 by owner decision, along with `unexpectedRootEntries` and
 * `RUN_OWNED_ROOT_ENTRIES`, so this file no longer asserts anything about the
 * repo root and must not be read as doing so. The reason is in
 * `tests/helpers/global-setup.ts`'s header: the artifacts it chased are written
 * by an agent session sharing this checkout, not by the suite, and no run can
 * attribute them. The diagnosis lives in `docs/backlog/durable-traps.md`.
 *
 * The guard itself runs in `tests/helpers/global-setup.ts`'s teardown, the only
 * place that observes the run after every test has finished. Exercised here
 * through the ledger's own mechanisms, so the contract is red/green without a
 * suite run.
 */
import { describe, it, expect } from "vitest";
import { liveChildProblems } from "../helpers/global-setup.js";
// Straight from the ledger module, not through the `spawn.mjs` barrel every
// other test imports: BOTH async entry points are the contract here, and each
// has to be exercised where the ledger can be read back.
import {
  execFileHidden,
  liveTrackedChildren,
  settleTrackedChildren,
  spawnHidden,
} from "../helpers/trackedSpawn.js";

const HANGING = ["-e", "setTimeout(function () {}, 60000)"];

describe("run hermeticity — a child still running at the end is named", () => {
  it("records a live child, and clears it once the child exits", async () => {
    const child = spawnHidden(process.execPath, HANGING, { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));

    // The ledger is shared by the whole run, so assert about THIS pid — a
    // sibling test's child may legitimately be in flight at the same moment.
    expect(liveTrackedChildren().some((entry) => entry.pid === child.pid)).toBe(true);
    expect(
      liveTrackedChildren().find((entry) => entry.pid === child.pid)?.command,
    ).toContain("setTimeout");

    child.kill();
    await exited;
    expect(liveTrackedChildren().some((entry) => entry.pid === child.pid)).toBe(false);
  });

  it("leaves nothing behind for a child that exits on its own", async () => {
    const child = spawnHidden(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    expect(liveTrackedChildren().some((entry) => entry.pid === child.pid)).toBe(false);
  });

  it("records the OTHER async entry point too — execFileHidden, not just spawnHidden", () => {
    // Two async entry points reach the ledger, and a guard that covers one of
    // them covers the tests that happen to use that one.
    const child = execFileHidden(process.execPath, HANGING, {}, () => {});
    try {
      expect(liveTrackedChildren().some((entry) => entry.pid === child.pid)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it("names the pid AND the command, because a bare count locates nothing", () => {
    // The end-to-end proof is a detached child surviving a real run: teardown
    // exits 1 with exactly this text. Pinned here on the pure half so the
    // message cannot rot into a count.
    const [report] = liveChildProblems([{ pid: 4242, command: "node -e setTimeout(f, 60000)" }]);
    expect(report).toContain("pid 4242");
    expect(report).toContain("node -e setTimeout(f, 60000)");
    expect(liveChildProblems([])).toEqual([]);
  });

  it("settles rather than reporting a child that is on its way out", async () => {
    // The grace window is what keeps a kill landing in the last milliseconds of
    // a test from reading as a leak — a false RED here would get the guard
    // switched off, which costs more than the leak it catches.
    const child = spawnHidden(process.execPath, HANGING, { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    const live = await settleTrackedChildren(5_000);
    await exited;
    expect(live.some((entry) => entry.pid === child.pid)).toBe(false);
  });
});
