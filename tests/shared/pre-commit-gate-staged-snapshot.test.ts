// Focused test for the pre-commit gate's STAGED-SNAPSHOT semantics (CP-NODE-1).
//
// The gate must validate the snapshot that will actually be COMMITTED — the
// staged index — not the dirty working tree. Fixture + rationale in
// pre-commit-gate-harness.ts (shared across the pre-commit-gate-*.test.ts family).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  g as gIn,
  initGateRepo,
  runGate as runGateIn,
} from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
const runGate = (command?: string) => runGateIn(repo, command);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe("pre-commit gate: staged-snapshot validation (CP-NODE-1)", () => {
  test("BLOCKS when the STAGED content is broken even if the working tree is good", () => {
    // Stage a BAD sentinel, then overwrite the WORKING TREE with GOOD (unstaged).
    // A working-tree check would pass (GOOD) and wrongly allow the commit; the
    // staged-snapshot check must see BAD and block.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // unstaged working-tree fix

    const r = runGate();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("npm run check");

    // The unstaged working-tree change must be restored intact.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("GOOD");
    // Staged content is unchanged (still BAD).
    expect(g("diff", "--cached", "sentinel.txt").stdout).toContain("+BAD");
  });

  test("ALLOWS when the STAGED content is good even if the working tree is broken", () => {
    // Stage GOOD (already committed GOOD; re-stage to be explicit), then break the
    // WORKING TREE (unstaged BAD). A working-tree check would fail (BAD) and
    // wrongly block; the staged-snapshot check must see GOOD and allow.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // unstaged working-tree break

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);

    // The unstaged working-tree change must be restored intact.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
  });

  test("fast path: clean-vs-index tree checks directly and allows a good staged commit", () => {
    // Everything staged (working tree == index), sentinel GOOD → allow, no churn.
    writeFileSync(join(repo, "new.txt"), "x");
    g("add", "-A");
    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("restores untracked files after the staged-snapshot check", () => {
    // Stage a good change, leave an UNTRACKED file in the tree. The materialized
    // staged snapshot omits it; the restore must bring it back.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "untracked.txt"), "keepme");

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(existsSync(join(repo, "untracked.txt")), "untracked file must be restored").toBe(true);
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("keepme");
  });

  test("git-rm trap: a staged deletion is honored and the tree restores cleanly", () => {
    // Add an extra tracked file, then `git rm` it (stages the deletion
    // immediately) while leaving an unstaged edit elsewhere. The gate must
    // materialize the staged tree (extra.txt deleted), check GOOD, allow, and
    // restore the unstaged worktree edit + keep the staged deletion.
    writeFileSync(join(repo, "extra.txt"), "e");
    g("add", "extra.txt");
    g("commit", "-qm", "add extra");
    g("rm", "-q", "extra.txt"); // stages the deletion immediately
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // unstaged worktree churn

    const r = runGate();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    // Unstaged worktree change restored; staged deletion still staged.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
    const staged = g("diff", "--cached", "--name-status").stdout;
    expect(staged).toContain("extra.txt");
  });

  test("hook-bypass (--no-verify) is still rejected before any snapshot work", () => {
    const r = runGate("git commit --no-verify -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hook-bypass");
  });
});
