// The commit gate at GIT's boundary (P53, owner decision 2026-09-05).
//
// The legs that judge a commit — `npm run check` on the staged snapshot, the
// derived verify:checks legs, the doc-contract subset, the constitutional-doc
// refusal, the loop-core attestation, the branch-strand refusal, the
// child-session refusal — used to run inside a Claude Code PreToolUse hook that
// parsed shell text to guess WHICH repository a `git commit` targeted, and
// claimed this repository whenever it could not tell. Now they run from
// `.githooks/pre-commit` (and `pre-merge-commit`, `pre-applypatch`) through
// `.claude/hooks/commit-gate.mjs`: git runs THIS repository's hook for THIS
// repository's commits and never for anyone else's, so jurisdiction cannot be
// wrong by construction. `core.hooksPath` is pointed at `.githooks` by the
// SessionStart guard.
//
// This file drives a REAL `git commit` in a fixture repo whose hooks dir runs
// the real commit-gate.mjs, and pins the tracked hook files' shape. A vacuous
// pass is excluded by asserting BOTH directions: a GOOD snapshot commits (HEAD
// advances — a missing or crashing gate would refuse it) and a BAD snapshot is
// refused WITH the gate's own text and HEAD unchanged (a hook that merely exits
// non-zero for any reason would not print it).
//
// Fixture + rationale in pre-commit-gate-harness.ts.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { g as gIn, initGateRepo } from "./pre-commit-gate-harness.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const COMMIT_GATE = resolve(REPO_ROOT, ".claude/hooks/commit-gate.mjs");
const TRACKED_HOOKS = ["pre-commit", "pre-merge-commit", "pre-applypatch"] as const;

let repo: string;
let hooksDir: string;
const g = (...args: string[]) => gIn(repo, ...args);
const head = () => g("rev-parse", "HEAD").stdout.trim();

/** A real `git commit` in the fixture — status, stderr, and whether HEAD moved. */
function realCommit(...args: string[]) {
  const before = head();
  const env = { ...process.env };
  delete env.AUDIT_TOOLS_AGENT_GIT;
  delete env.AUDIT_TOOLS_CHILD_SESSION;
  delete env.GIT_INDEX_FILE;
  const r = spawnSync("git", ["commit", "-q", ...args], { cwd: repo, encoding: "utf8", env });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "", landed: head() !== before };
}

beforeEach(() => {
  repo = initGateRepo();
  // A hooks dir OUTSIDE the fixture whose pre-commit runs the REAL gate, the
  // way the tracked .githooks/pre-commit does — but pointing at this checkout's
  // gate so the fixture needs no copy of it.
  hooksDir = mkdtempSync(join(tmpdir(), "gate-hooks-"));
  const gatePath = COMMIT_GATE.replace(/\\/g, "/");
  writeFileSync(join(hooksDir, "pre-commit"), `#!/bin/sh\nexec node "${gatePath}" pre-commit\n`);
  chmodSync(join(hooksDir, "pre-commit"), 0o755);
  g("config", "core.hooksPath", hooksDir.replace(/\\/g, "/"));
});

afterEach(() => {
  for (const d of [hooksDir, repo]) if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe("commit-gate at git's boundary: a real `git commit` is judged by git running the gate", () => {
  test("a GOOD staged snapshot commits — the gate ran and allowed it", () => {
    writeFileSync(join(repo, "note.txt"), "fine\n");
    g("add", "note.txt");
    const r = realCommit("-m", "good");
    expect(r.status, `expected the commit to land; stderr:\n${r.stderr}`).toBe(0);
    expect(r.landed).toBe(true);
  });

  test("a BAD staged snapshot is refused by the gate's own check, and HEAD does not move", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    const r = realCommit("-m", "bad");
    expect(r.status, `expected git to refuse; stderr:\n${r.stderr}`).not.toBe(0);
    expect(r.landed).toBe(false);
    expect(r.stderr).toMatch(/`npm run check` FAILED/);
    // The staged snapshot is left intact for the operator to fix.
    expect(g("diff", "--cached", "--name-only").stdout.trim()).toBe("sentinel.txt");
  });

  test("the gate judges the STAGED snapshot, not the worktree, and restores the worktree afterward", () => {
    // Staged GOOD, worktree BAD: the commit must land (staged is green) and the
    // worktree edit must survive the round-trip byte for byte.
    writeFileSync(join(repo, "note.txt"), "fine\n");
    g("add", "note.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // unstaged
    const r = realCommit("-m", "staged good, worktree bad");
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.landed).toBe(true);
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8")).toBe("BAD\n");
    expect(g("show", "HEAD:sentinel.txt").stdout).toBe("GOOD\n");
  });

  test("`git commit -a` with an untracked file present: -a content is judged, the untracked file survives", () => {
    // Under -a git hands the hook a temporary index (GIT_INDEX_FILE) that
    // already holds the -a content; the untracked file makes the worktree
    // diverge so the round-trip runs, and must put it back.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // tracked, modified, NOT staged
    writeFileSync(join(repo, "scratch.txt"), "untracked\n");
    const bad = realCommit("-a", "-m", "bad via -a");
    expect(bad.status, `expected refusal; stderr:\n${bad.stderr}`).not.toBe(0);
    expect(bad.landed).toBe(false);
    expect(bad.stderr).toMatch(/`npm run check` FAILED/);
    expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("untracked\n");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    writeFileSync(join(repo, "other.txt"), "tracked later\n");
    g("add", "other.txt");
    const good = realCommit("-a", "-m", "good via -a");
    expect(good.status, `stderr:\n${good.stderr}`).toBe(0);
    expect(good.landed).toBe(true);
    expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("untracked\n");
  });

  test("a routed cherry-pick (-n, then `git commit`) is judged by pre-commit on the applied tree — and left staged for the attestation", () => {
    // The sequencer runs no pre-commit of its own (measured 2026-09-05), so the
    // tool-boundary hook routes a gated cherry-pick to `-n`; the applied result
    // is staged and the `git commit` that lands it runs THIS gate, which finds a
    // loop-core path with no attestation and refuses — leaving the index staged
    // so the operator can attest against exactly that tree and commit again.
    g("checkout", "-q", "-b", "side");
    mkdirSync(join(repo, "src", "shared", "engine"), { recursive: true });
    writeFileSync(join(repo, "src", "shared", "engine", "x.ts"), "export const x = 1;\n");
    g("add", "-A");
    // Fixture setup, not the behaviour under test: this commit stands for one
    // made elsewhere (another checkout, a branch without the gate), so it skips
    // the hook that every commit in this fixture otherwise runs.
    g("commit", "--no-verify", "-qm", "loop-core change");
    const sha = head();
    g("checkout", "-q", "-");
    const before = head();
    const env = { ...process.env };
    delete env.AUDIT_TOOLS_AGENT_GIT;
    delete env.AUDIT_TOOLS_CHILD_SESSION;
    g("cherry-pick", "-n", sha);
    expect(g("diff", "--cached", "--name-only").stdout).toContain("src/shared/engine/x.ts");
    const r = spawnSync("git", ["commit", "-q", "-m", "land the pick"], { cwd: repo, encoding: "utf8", env });
    expect(r.status, `expected git to refuse; stderr:\n${r.stderr}`).not.toBe(0);
    expect(head()).toBe(before);
    expect(r.stderr).toMatch(/loop-core/i);
    expect(g("diff", "--cached", "--name-only").stdout).toContain("src/shared/engine/x.ts");
  });

  test("`--no-verify` skips the hook — which is why the tool-boundary hook still refuses that token", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    const r = realCommit("--no-verify", "-m", "bypass");
    expect(r.status).toBe(0);
    expect(r.landed).toBe(true);
  });
});

describe("the tracked hook files", () => {
  test("each commit-creating hook is tracked, executable in the index, and runs commit-gate.mjs relative to itself", () => {
    for (const hook of TRACKED_HOOKS) {
      const path = `.githooks/${hook}`;
      const ls = spawnSync("git", ["ls-files", "-s", path], { cwd: REPO_ROOT, encoding: "utf8" }).stdout ?? "";
      expect(ls, `${path} is not tracked`).not.toBe("");
      expect(ls.startsWith("100755"), `${path} is not executable in the index (mode ${ls.slice(0, 6)})`).toBe(true);
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      expect(text.startsWith("#!/bin/sh\n")).toBe(true);
      expect(text).toContain("commit-gate.mjs");
      // Resolved from the HOOK FILE's own location, so a linked worktree checked
      // out on a pre-P53 branch still runs the current gate.
      expect(text).toContain('$(dirname "$0")');
      expect(text).not.toMatch(/\r/);
    }
  });

  test("the tracked pre-push delegates to the local, never-committed .git/hooks/pre-push", () => {
    const path = ".githooks/pre-push";
    const ls = spawnSync("git", ["ls-files", "-s", path], { cwd: REPO_ROOT, encoding: "utf8" }).stdout ?? "";
    expect(ls.startsWith("100755"), `${path} missing or not executable`).toBe(true);
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    expect(text).toContain("--git-common-dir");
    expect(text).toContain("hooks/pre-push");
    expect(text).toContain('exec "$local" "$@"');
  });
});
