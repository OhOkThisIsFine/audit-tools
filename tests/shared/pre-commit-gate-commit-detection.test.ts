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
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    const r = runGate(`git -C ${JSON.stringify(repo)} commit -m x`);
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
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
      JSON.stringify({ worktreeTree, stagedTree, at: new Date().toISOString() }),
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

    const r = runGate(); // BAD staged would block — but the live lock must fail open
    expect(r.status, `expected fail-open allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("another staged-snapshot round-trip is in flight");
    // Worktree untouched by the skipped round-trip.
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("GOOD");
  });

  test("chained `git add -A && git commit` gates the WORKTREE (what actually lands)", () => {
    // Staged GOOD, worktree BAD: the chained add will stage the BAD content, so
    // that is what the commit carries — the gate must check the worktree and
    // block. (The old behavior materialized the PRE-add staged snapshot: GOOD →
    // false allow → unchecked content landed.)
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // will be swept in by add -A

    const r = runGate("git add -A && git commit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
  });

  test("`git commit -am x` is a stage command too (cluster flag, not just `-a`)", () => {
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");

    const r = runGate("git commit -am x");
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
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n"); // worktree == index, both BAD

    const r = runGate("git \\\ncommit -m x");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
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

    const r = runGate();
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
