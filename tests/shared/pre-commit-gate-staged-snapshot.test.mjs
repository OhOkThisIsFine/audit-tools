// Focused test for the pre-commit gate's STAGED-SNAPSHOT semantics (CP-NODE-1).
//
// The gate must validate the snapshot that will actually be COMMITTED — the
// staged index — not the dirty working tree. These tests drive the real hook
// binary end-to-end against a throwaway git repo whose `npm run check` is a
// trivial marker script that passes iff a sentinel file's content is "GOOD".
// By staging vs. leaving-in-the-worktree different sentinel values we prove the
// gate checks the STAGED content and always restores the worktree afterward.
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GATE = resolve(HERE, "../../.claude/hooks/pre-commit-gate.mjs");

let repo;

function g(...args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

// Run the gate with a fake `git commit` payload, CLAUDE_PROJECT_DIR = repo.
function runGate(command = "git commit -m x") {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
}

// A `check` script that passes iff sentinel.txt === "GOOD". This stands in for
// `npm run check` — the gate reads `npm run check` from the repo's package.json.
const CHECK_SCRIPT = `import { readFileSync } from "node:fs";
const v = readFileSync(new URL("./sentinel.txt", import.meta.url), "utf8").trim();
process.exit(v === "GOOD" ? 0 : 1);
`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gate-staged-"));
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", scripts: { check: "node check.mjs" } }, null, 2),
  );
  writeFileSync(join(repo, "check.mjs"), CHECK_SCRIPT);
  writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
  g("add", "-A");
  g("commit", "-qm", "init");
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
