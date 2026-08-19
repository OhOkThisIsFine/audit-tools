// Pre-commit gate: TARGET-REPO scoping. The gate guards CLAUDE_PROJECT_DIR's
// repository, but the hook fires on every Bash/PowerShell call in the session —
// so a commit that targets a DIFFERENT repository (`cd other && git commit`,
// `git -C other commit`, or a plain commit after the session cd'd away) must be
// out of its jurisdiction. Before scoping existed, such commits were gated
// against audit-tools' own staged tree — observed live 2026-08-19: an unrelated
// fresh repo's first commit was blocked because a concurrent session had
// loop-core files staged in audit-tools. That is the false-RED class (a false
// RED is as corrosive as a false green — it trains the reader to distrust or
// bypass the gate). Each case pins either the exemption (foreign repo → exit 0,
// no gate machinery) or the fail-closed residue (this repo, a linked worktree,
// an unresolvable target → still gated).
// Fixture + rationale in pre-commit-gate-harness.ts.
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionRecord } from "../../scripts/shared/sessionRegistry.mjs";
import { g as gIn, initGateRepo, runGate as runGateIn } from "./pre-commit-gate-harness.js";

let repo: string; // the gated project repo (CLAUDE_PROJECT_DIR)
let otherRepo: string; // an unrelated repository
let worktree: string; // linked worktree of `repo` (created per-test when needed)
const g = (...args: string[]) => gIn(repo, ...args);
const runGate = (command?: string, opts?: { sessionId?: string; cwd?: string }) =>
  runGateIn(repo, command, opts);

beforeEach(() => {
  repo = initGateRepo();
  otherRepo = mkdtempSync(join(tmpdir(), "gate-other-"));
  gIn(otherRepo, "init", "-q");
  worktree = "";
});

afterEach(() => {
  for (const d of [worktree, otherRepo, repo]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// Stage a RED snapshot in the project repo — any commit gated against it blocks.
function stageRed(): void {
  writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
  g("add", "sentinel.txt");
}

describe("pre-commit gate: target-repo scoping", () => {
  test("T1 sanity: a commit in THIS repo still blocks on a red snapshot", () => {
    stageRed();
    const r = runGate("git commit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("`npm run check` FAILED");
  });

  test("T2 the observed false RED: `cd <other> && git commit` is exempt while THIS repo is red", () => {
    stageRed();
    const indexTreeBefore = g("write-tree").stdout.trim();
    const r = runGate(`cd ${JSON.stringify(otherRepo)} && git commit -m x`);
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("blocked");
    expect(r.stderr).not.toContain("FAIL-OPEN");
    // Exempt means NO gate machinery ran — the real index was never touched.
    expect(g("write-tree").stdout.trim()).toBe(indexTreeBefore);
  });

  test("T3 `git -C <other> commit` is exempt too", () => {
    stageRed();
    const r = runGate(`git -C ${JSON.stringify(otherRepo)} commit -m x`);
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("T4 a plain commit AFTER the session cd'd away is exempt (payload cwd)", () => {
    stageRed();
    const r = runGate("git commit -m x", { cwd: otherRepo });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("T5 the PowerShell shape (`Set-Location <other>; git commit`) is exempt", () => {
    stageRed();
    const r = runGate(`Set-Location '${otherRepo}'; git commit -m x`);
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("T6 a LINKED WORKTREE of this repo stays gated — identity is the common dir, not the toplevel", () => {
    stageRed();
    worktree = `${repo}-wt`;
    g("worktree", "add", worktree, "-b", "wt-scope");
    const r = runGate(`cd ${JSON.stringify(worktree)} && git commit -m x`);
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("T7 an unresolvable target fails CLOSED — a variable cd still gates", () => {
    stageRed();
    const r = runGate('cd "$SOMEWHERE_ELSE" && git commit -m x');
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("T8 a foreign-repo `--no-verify` commit is not our hook-bypass to refuse", () => {
    stageRed();
    const r = runGate(`cd ${JSON.stringify(otherRepo)} && git commit --no-verify -m x`);
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("hook-bypass");
  });

  test("T9 a MIXED command still gates the half that targets this repo", () => {
    stageRed();
    const r = runGate(`git -C ${JSON.stringify(otherRepo)} commit -m x && git commit -m x`);
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("T10 the child-session refusal has no jurisdiction over a foreign-repo commit either", () => {
    // Arm the registry with a resident id; the payload carries an UNREGISTERED
    // id, so a commit in THIS repo would be refused as a child session — but a
    // commit into another repository is not this repo's git state.
    writeSessionRecord(repo, {
      version: 1,
      session_id: "resident-owner",
      registered_at: new Date().toISOString(),
      source: "test",
      baseline: [],
    });
    const r = runGate(`cd ${JSON.stringify(otherRepo)} && git commit -m x`, {
      sessionId: "child-1",
    });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(/child session/i);
  });
});
