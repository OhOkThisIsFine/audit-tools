// Pre-commit gate: commit DETECTION semantics — subcommand-positional matching,
// crash recovery, and the live-lock fail-open. Fixture + rationale in
// pre-commit-gate-harness.ts (shared across the pre-commit-gate-*.test.ts family).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  g as gIn,
  initGateRepo,
  runCommitGate,
  runGate as runGateIn,
} from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
// Detection, the bypass refusal and prompt crash recovery are the tool-boundary
// hook's; the round-trip, its live lock and the hook-tracking invariant run at
// GIT's boundary (commit-gate.mjs, P53).
const runGate = (command?: string) => runGateIn(repo, command);
const runCommit = () => runCommitGate(repo);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe("pre-commit gate: commit detection is subcommand-positional", () => {
  test("a read-only git command naming a path containing 'commit' is a no-op", () => {
    // `git diff -- .claude/hooks/pre-commit-gate.mjs` contains the token
    // "commit" only inside a PATH. A substring match treats it as a commit and
    // runs the full staged-snapshot round-trip (tree/index rewrites + check) on
    // a read-only command — observed live clobbering the real index. With BAD
    // staged and GOOD in the worktree, a round-trip would BLOCK; a correct
    // detector never engages at all.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent worktree
    const indexTreeBefore = g("write-tree").stdout.trim();

    const r = runGate("git diff --stat -- .claude/hooks/pre-commit-gate.mjs");
    expect(r.status, `expected no-op allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(g("write-tree").stdout.trim(), "real index must be untouched").toBe(indexTreeBefore);
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim(), "worktree must be untouched").toBe("GOOD");
  });

  test("`git -C <path> commit` is still detected through global options", () => {
    // A bypass token is the tool-boundary hook's one commit refusal, so it is
    // the probe for "was the commit detected at all".
    const r = runGate(`git -C ${JSON.stringify(repo)} commit --no-verify -m x`);
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hook-bypass");
  });

  test("crash recovery: a journal left by a killed round-trip heals tree + index on the next call", () => {
    // Build the exact mid-round-trip state a killed gate instance leaves:
    // staged BAD, worktree GOOD + an untracked file → the gate journals both
    // tree SHAs, materializes the STAGED tree (worktree becomes BAD, untracked
    // file deleted) — then dies before restoring. The next gate invocation
    // (ANY command, not just a commit) must restore the worktree and index from
    // the journal.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent worktree
    writeFileSync(join(repo, "untracked.txt"), "keepme"); // untracked

    // Compute the two tree SHAs the same way the gate does.
    const stagedTree = g("write-tree").stdout.trim();
    const scratch = join(repo, "scratch-idx");
    const gs = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: scratch } });
    gs("read-tree", "HEAD");
    gs("add", "-A");
    const worktreeTree = gs("write-tree").stdout.trim();
    rmSync(scratch, { force: true });

    // Simulate the crash: worktree clobbered to the staged snapshot + journal present, no live lock.
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    rmSync(join(repo, "untracked.txt"), { force: true });
    mkdirSync(join(repo, ".claude", "hooks", ".state"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "hooks", ".state", "gate-roundtrip-journal.json"),
      // `head` mirrors what the gate's journal writer records; recovery applies
      // a journal only under the HEAD it was captured under (open-bugs.md:291
      // fix). HEAD does not move in this simulated crash, so recovery heals.
      JSON.stringify({
        worktreeTree,
        stagedTree,
        head: g("rev-parse", "HEAD").stdout.trim(),
        at: new Date().toISOString(),
      }),
    );

    const r = runGate("echo hi"); // NOT a commit — recovery must still run
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("recovered an INTERRUPTED");
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim(), "worktree healed").toBe("GOOD");
    expect(existsSync(join(repo, "untracked.txt")), "untracked file healed").toBe(true);
    expect(g("write-tree").stdout.trim(), "index healed to the staged tree").toBe(stagedTree);
    expect(
      existsSync(join(repo, ".claude", "hooks", ".state", "gate-roundtrip-journal.json")),
      "journal consumed",
    ).toBe(false);
  });

  test("a LIVE lock makes a divergent-tree commit fail open (no interleaved tree surgery)", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent → round-trip path
    mkdirSync(join(repo, ".claude", "hooks", ".state", "gate-roundtrip.lock"), { recursive: true });

    const r = runCommit(); // BAD staged would block — but the live lock must fail open
    expect(r.status, `expected fail-open allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("another staged-snapshot round-trip is in flight");
    // Worktree untouched by the skipped round-trip.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("GOOD");
  });

  test("a chained `git add -A && git commit` is judged on what the add staged — the index is final under git's hook", () => {
    // Staged GOOD, worktree BAD, then the chained add sweeps BAD in: git's hook
    // fires AFTER the add, so the staged snapshot it reads is the BAD content.
    // (The tool-boundary approximation of "what the add WILL stage" is gone.)
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "-A");

    const r = runCommit();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test('`echo "git commit -m x"` is text, not a commit — gate never engages', () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n"); // divergent tree
    const indexTreeBefore = g("write-tree").stdout.trim();

    const r = runGate('echo "git commit -m x"');
    expect(r.status, `expected no-op allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(g("write-tree").stdout.trim()).toBe(indexTreeBefore);
  });

  test("a line-continuation commit (`git \\<newline>commit`) is still detected", () => {
    const r = runGate("git \\\ncommit --no-verify -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hook-bypass");
  });

  test("2c blocks a settings-referenced hook that is PRESENT on disk but gitignored", () => {
    // The commit would not carry the hook file (ignored + untracked), yet it is
    // physically present — an existsSync check passes here; the committed-tree
    // membership check must block.
    writeFileSync(join(repo, ".gitignore"), ".claude/hooks/\n");
    mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ghost.mjs"' }] } }),
    );
    writeFileSync(join(repo, ".claude", "hooks", "ghost.mjs"), "// present but ignored\n");
    g("add", "-A"); // stages settings.json + .gitignore; ghost.mjs stays ignored

    const r = runCommit();
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("ghost.mjs");
  });

  test("`-n` inside a quoted commit message is text, not the no-verify flag", () => {
    // Good staged content → the commit must be ALLOWED; a raw-text `-n` match
    // inside the -m string would false-block it as a hook bypass.
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    const r = runGate('git commit -m "tests: assert on grep -n output; split on -n boundaries"');
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("hook-bypass");
  });
});
