/**
 * Run hermeticity: a vitest invocation leaves the repo root as it found it, and
 * leaves no child of its own still running.
 *
 * THE DEFECT THIS PINS. Runs kept leaving empty files in the repo root with
 * names lifted out of source and prose — `o.testId)`, `60s`, `0)`. Each is a
 * shell-redirect artifact: a command STRING handed to a shell carries the
 * shell's grammar, and `cmd.exe` reads `>` as a redirect anywhere in the line,
 * ending the target token at whitespace, `;`, `,` or `=`. So
 * `… .map((o) => o.testId);` writes a file named `o.testId)`, and prose reading
 * `the >60s blocking worker` writes one named `60s`. The artifact is empty and
 * tracked by nothing, so it survives every clean-tree check that looks at
 * CONTENT and only shows up as an untracked path in `git status`.
 *
 * WHY THE CHECK IS A SET DIFFERENCE, not a clean-root assertion: the root of a
 * working checkout legitimately holds artifacts nobody wants a suite to fail
 * on, including artifacts left by an EARLIER leak. The property is ownership of
 * the delta — this run added this entry — which is also what makes the report
 * name a producer rather than an inventory.
 *
 * THE SECOND HALF. A leak that lands AFTER teardown belongs to a child that
 * outlived the run, and by the time its file appears the run that spawned it is
 * gone. So the child, not the file, is what gets caught: every async spawn is
 * recorded in a per-run ledger (`tests/helpers/trackedSpawn.ts`) and teardown
 * fails on whatever is still alive, naming pid and command.
 *
 * The guard itself runs in `tests/helpers/global-setup.ts`'s teardown, the only
 * place that observes the run after every test has finished. Exercised here
 * through the two halves' own mechanisms, so the contract is red/green without
 * a suite run.
 */
import { describe, it, expect } from "vitest";
import {
  RUN_OWNED_ROOT_ENTRIES,
  liveChildProblems,
  unexpectedRootEntries,
} from "../helpers/global-setup.js";
// Straight from the ledger module, not through the `spawn.mjs` barrel every
// other test imports: BOTH async entry points are the contract here, and each
// has to be exercised where the ledger can be read back.
import {
  execFileHidden,
  liveTrackedChildren,
  settleTrackedChildren,
  spawnHidden,
} from "../helpers/trackedSpawn.js";

const BEFORE = ["CLAUDE.md", "package.json", "src", "tests"];

describe("repo-root hermeticity — a run's added entries are reported by name", () => {
  it("reports nothing when the root is unchanged", () => {
    expect(unexpectedRootEntries(BEFORE, [...BEFORE])).toEqual([]);
  });

  it("reports the shell-redirect artifacts that motivated the guard", () => {
    // The three names observed on this repo, each a fragment of real repo text.
    const leaked = unexpectedRootEntries(BEFORE, [...BEFORE, "o.testId)", "60s", "0)"]);
    expect(leaked).toEqual(["0)", "60s", "o.testId)"]);
  });

  it("reports a test writing a deliberate-looking file outside its scratch dir", () => {
    expect(unexpectedRootEntries(BEFORE, [...BEFORE, "result.json"])).toEqual(["result.json"]);
  });

  it("never reports an entry that was already there", () => {
    // A leak from an EARLIER run belongs to that run. Reporting it here would
    // fail every suite until someone deleted it, which trains the failure out.
    const before = [...BEFORE, "0)"];
    expect(unexpectedRootEntries(before, [...before])).toEqual([]);
  });

  it("never reports a declared tool-owned entry", () => {
    const after = [...BEFORE, ...RUN_OWNED_ROOT_ENTRIES, "tsconfig.tsbuildinfo"];
    expect(unexpectedRootEntries(BEFORE, after)).toEqual([]);
  });

  it("reports a removed entry as nothing — the check is about ADDITIONS", () => {
    // Deletion is a different defect with a different owner (a test cleaning up
    // a path it did not create). Folding it in here would make one report mean
    // two things.
    expect(unexpectedRootEntries(BEFORE, ["package.json"])).toEqual([]);
  });
});

/** A child that stays up until it is killed — the straggler shape, on purpose. */
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
