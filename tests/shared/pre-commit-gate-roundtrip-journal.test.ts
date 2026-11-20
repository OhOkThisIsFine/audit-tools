// Round-trip journal HEAD binding (open-bugs.md:291).
//
// The staged-snapshot round-trip journals two tree SHAs before rewriting the
// working tree. A hook killed mid-round-trip may be FOLLOWED by the git command
// executing (PreToolUse death does not stop the tool call), so by the next gate
// invocation HEAD can have MOVED — and an unconditional restore then
// time-travels the worktree and index backward over the new HEAD (observed
// live: a pre-rebase snapshot restored over the rebased tree). These tests pin:
//   1. recovery REFUSES + quarantines the journal when HEAD differs;
//   2. a journal with NO head binding (older gate version) is refused the same;
//   3. history-moving verbs (rebase/merge/cherry-pick/revert/am) never take the
//      materializing round-trip — the DIRECT worktree check gates them;
//   4. `git commit` keeps the staged-snapshot round-trip;
//   5. recovery still heals normally when HEAD has NOT moved.
// Fixture + rationale in pre-commit-gate-harness.ts.
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  COMMIT_GATE,
  g as gIn,
  initGateRepo,
  runCommitGate,
  runGate as runGateIn,
} from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
// Recovery runs in BOTH hooks (the tool-boundary hook heals on every shell
// call); the round-trip itself belongs to the git-boundary commit gate (P53).
const runGate = (command?: string) => runGateIn(repo, command);
const runCommit = () => runCommitGate(repo);
const stateDir = () => join(repo, ".claude", "hooks", ".state");
const journalPath = () => join(stateDir(), "gate-roundtrip-journal.json");
const revParse = (ref: string) => g("rev-parse", ref).stdout.trim();

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

// Intercept only the chosen Git operation in the hook subprocess.
function injectGitFault(condition: string, afterFirstWrite = false): NodeJS.ProcessEnv {
  const preload = join(repo, ".git", "inject-git-fault.cjs");
  writeFileSync(preload, `
    const cp = require("node:child_process");
    const original = cp.spawnSync;
    let count = 0;
    let failAfterWrite = ${afterFirstWrite};
    cp.spawnSync = function(command, args, opts) {
      if (command === "git" && (${condition})) {
        if (failAfterWrite) {
          original.apply(this, arguments);
          failAfterWrite = false;
        }
        return { status: 1, stdout: "", stderr: "injected git fault" };
      }
      return original.apply(this, arguments);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  return { NODE_OPTIONS: '--require="' + preload.replaceAll("\\", "/") + '"' };
}

function installCommitHook() {
  const hooks = join(repo, ".git", "hooks");
  g("config", "core.hooksPath", hooks);
  const shellArg = (arg: string) => "'" + arg.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexec " + shellArg(process.execPath) + " " + shellArg(COMMIT_GATE) + " pre-commit\n", { mode: 0o755 });
}

function makeTwoCommits() {
  writeFileSync(join(repo, "data.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "c1");
  const c1 = revParse("HEAD");
  const t1 = revParse("HEAD^{tree}");
  writeFileSync(join(repo, "data.txt"), "two\n");
  g("add", "-A");
  g("commit", "-qm", "c2");
  return { c1, t1 };
}

function plantJournal(journal: Record<string, unknown>) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify(journal, null, 2));
}

describe("pre-commit gate: round-trip journal HEAD binding (open-bugs.md:291)", () => {
  test("recovery REFUSES and quarantines when HEAD moved since the journal", () => {
    const { c1, t1 } = makeTwoCommits();
    plantJournal({ worktreeTree: t1, stagedTree: t1, head: c1, at: new Date().toISOString() });

    // Any gated invocation runs recovery first; a non-commit command keeps the
    // rest of the gate out of the picture.
    const r = runGate("echo ok");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);

    // The journaled pre-move content must NOT be applied over the new tree…
    expect(readFileSync(join(repo, "data.txt"), "utf8").trim()).toBe("two");
    // …and the index must not be time-traveled either.
    expect(g("status", "--porcelain").stdout.trim()).toBe("");
    // The journal is consumed into a QUARANTINE file, never silently applied.
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(stateDir()).filter((f) => f.includes("quarantine"));
    expect(quarantined.length, "expected exactly one quarantined journal").toBe(1);
  });

  test("a legacy journal with no head binding is refused the same way", () => {
    const { t1 } = makeTwoCommits();
    plantJournal({ worktreeTree: t1, stagedTree: t1, at: new Date().toISOString() });

    const r = runGate("echo ok");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(readFileSync(join(repo, "data.txt"), "utf8").trim()).toBe("two");
    expect(g("status", "--porcelain").stdout.trim()).toBe("");
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(stateDir()).filter((f) => f.includes("quarantine"));
    expect(quarantined.length, "expected exactly one quarantined journal").toBe(1);
  });

  test("the commit gate keeps the staged-snapshot round-trip on a divergent tree", () => {
    // Staged GOOD, worktree BAD: the staged GOOD is what lands, so the
    // round-trip checks it and allows, and the worktree comes back byte-exact.
    // (The old tool-boundary "history-moving verbs take the direct check"
    // carve-out is gone with P53: under a git hook the index is final and the
    // hook runs INSIDE the git command, so there is no command left to race.)
    writeFileSync(join(repo, "sentinel.txt"), "GOOD\n");
    g("add", "sentinel.txt");
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");

    const r = runCommit();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(readFileSync(join(repo, "sentinel.txt"), "utf8").trim()).toBe("BAD");
  });

  test.each([true, false])("restores file/directory transitions (working directory: %s)", (workingDirectory) => {
    const path = join(repo, "shape");
    writeFileSync(path, "flat\n");
    g("add", "shape");
    const fileTree = g("write-tree").stdout.trim();
    rmSync(path);
    mkdirSync(path);
    writeFileSync(join(path, "nested"), "nested\n");
    g("add", "-A");
    const directoryTree = g("write-tree").stdout.trim();
    const [worktreeTree, stagedTree] = workingDirectory ? [directoryTree, fileTree] : [fileTree, directoryTree];
    g("read-tree", stagedTree);
    if (workingDirectory) {
      rmSync(join(path, "nested"));
      rmSync(path, { recursive: true });
      writeFileSync(path, "flat\n");
    }
    plantJournal({ worktreeTree, stagedTree, head: revParse("HEAD") });

    const result = runGate("echo ok");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(journalPath()), result.stderr).toBe(false);
    expect(readFileSync(workingDirectory ? join(path, "nested") : path, "utf8")).toBe(workingDirectory ? "nested\n" : "flat\n");
    expect(g("show", workingDirectory ? ":shape" : ":shape/nested").stdout).toBe(workingDirectory ? "flat\n" : "nested\n");
  });

  test.each(["rollback", "worktree", "index", "pending journal", "held lock"])(
    "a real commit keeps HEAD until recovery from %s", (fault) => {
      installCommitHook();
      const data = join(repo, "data.txt");
      writeFileSync(data, "working\n");
      g("add", "data.txt");
      const worktreeTree = g("write-tree").stdout.trim();
      writeFileSync(data, "stage\n");
      g("add", "data.txt");
      const stagedTree = g("write-tree").stdout.trim();
      const head = revParse("HEAD");
      const lock = join(stateDir(), "gate-roundtrip.lock");
      if (fault === "pending journal") plantJournal({ head, worktreeTree, stagedTree });
      if (fault === "held lock") mkdirSync(lock, { recursive: true });
      // A live round-trip may already have made the worktree match the index.
      if (fault !== "held lock") writeFileSync(data, "working\n");
      const conditions: Record<string, string> = {
        rollback: "args[0] === 'checkout-index'",
        worktree: "args[0] === 'checkout-index' && ++count === 2",
        index: "args[0] === 'read-tree' && !opts.env?.GIT_INDEX_FILE",
        "pending journal": "args[0] === 'checkout-index'",
        "held lock": "false",
      };
      const env = injectGitFault(conditions[fault]!, fault === "rollback");
      const first = spawnSyncHidden("git", ["commit", "-qm", "candidate"], { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8" });
      expect(first.status, first.stderr).not.toBe(0);
      expect(revParse("HEAD")).toBe(head);
      expect(g("show", ":data.txt").stdout).toBe("stage\n");
      if (fault === "held lock") rmSync(lock, { recursive: true });
      else expect(JSON.parse(readFileSync(journalPath(), "utf8"))).toMatchObject({ head, worktreeTree, stagedTree });
      g("commit", "-qm", "retry");
      expect(revParse("HEAD")).not.toBe(head);
      expect(g("show", "HEAD:data.txt").stdout).toBe("stage\n");
      expect(readFileSync(data, "utf8")).toBe(fault === "held lock" ? "stage\n" : "working\n");
      expect(existsSync(journalPath())).toBe(false);
    },
  );

  test.each(["path-limited commit", "caller-supplied index"])(
    "recovery for a %s preserves unrelated staging", (kind) => {
      writeFileSync(join(repo, "selected"), "base\n");
      writeFileSync(join(repo, "other"), "base\n");
      g("add", "selected", "other");
      g("commit", "-qm", "base");
      installCommitHook();
      const alternateIndex = join(repo, ".git", "manual-index");
      // Git resolves this relative override from the fixture worktree. The healer runs from a different cwd.
      const alternateEnv = { ...process.env, GIT_INDEX_FILE: ".git/manual-index" };
      const alternateGit = (...args: string[]) => spawnSyncHidden("git", args, { cwd: repo, env: alternateEnv, encoding: "utf8" });
      writeFileSync(join(repo, "selected"), "selected\n");
      writeFileSync(join(repo, "other"), "user-staged\n");
      g("add", "other");
      writeFileSync(join(repo, "other"), "user-working\n");
      const explicit = kind === "caller-supplied index";
      if (explicit) {
        expect(alternateGit("read-tree", "HEAD").status).toBe(0);
        expect(alternateGit("add", "selected").status).toBe(0);
      }
      const head = revParse("HEAD");
      const env = { ...(explicit ? alternateEnv : process.env), ...injectGitFault("args[0] === 'checkout-index' && ++count === 2") };
      const args = explicit ? ["commit", "-qm", "alternate"] : ["commit", "--only", "selected", "-m", "partial"];
      const failed = spawnSyncHidden("git", args, { cwd: repo, env, encoding: "utf8" });
      expect(failed.status, failed.stderr).not.toBe(0);
      expect(revParse("HEAD")).toBe(head);
      expect(g("show", ":other").stdout).toBe("user-staged\n");
      if (explicit) expect(JSON.parse(readFileSync(journalPath(), "utf8")).indexPath).toBe(alternateIndex);
      expect(runGate("echo healed").status).toBe(0);
      expect(g("show", ":other").stdout).toBe("user-staged\n");
      expect(g("show", ":selected").stdout).toBe("base\n");
      expect(readFileSync(join(repo, "other"), "utf8")).toBe("user-working\n");
      expect(existsSync(journalPath())).toBe(false);
      if (explicit) {
        expect(alternateGit("show", ":other").stdout).toBe("base\n");
        expect(alternateGit("show", ":selected").stdout).toBe("selected\n");
        expect(alternateGit("commit", "-qm", "alternate retry").status).toBe(0);
      } else {
        g("commit", "--only", "selected", "-m", "partial retry");
      }
      expect(g("show", "HEAD:selected").stdout).toBe("selected\n");
      expect(g("show", "HEAD:other").stdout).toBe("base\n");
      expect(g("show", ":other").stdout).toBe("user-staged\n");
      expect(readFileSync(join(repo, "other"), "utf8")).toBe("user-working\n");
    },
  );

  test("a legacy journal with ambiguous index ownership preserves unrelated staging", () => {
    const { t1 } = makeTwoCommits();
    const currentTree = revParse("HEAD^{tree}");
    const saved = { worktreeTree: currentTree, stagedTree: t1, head: revParse("HEAD") };
    plantJournal(saved);
    const r = runGate("echo ok");
    expect(r.stderr).toContain("no index identity");
    expect(r.stderr).toContain(journalPath());
    expect(r.stderr).toContain(`git diff ${t1} ${currentTree} --`);
    expect(JSON.parse(readFileSync(journalPath(), "utf8"))).toEqual(saved);
    expect(g("show", ":data.txt").stdout).toBe("two\n");
    expect(readFileSync(join(repo, "data.txt"), "utf8")).toBe("two\n");
  });

  test("an explicitly bound default index is recovered without writing the healer's alternate index", () => {
    const { t1 } = makeTwoCommits();
    const alternate = join(repo, ".git", "another-index");
    const env = { ...process.env, GIT_INDEX_FILE: alternate };
    const active = (...args: string[]) => spawnSyncHidden("git", args, { cwd: repo, env, encoding: "utf8" });
    expect(active("read-tree", "HEAD").status).toBe(0);
    plantJournal({ worktreeTree: t1, stagedTree: t1, head: revParse("HEAD"), indexPath: null });
    expect(runGateIn(repo, "echo ok", { env }).status).toBe(0);
    expect(g("show", ":data.txt").stdout).toBe("one\n");
    expect(active("show", ":data.txt").stdout).toBe("two\n");
    expect(existsSync(journalPath())).toBe(false);
  });

  test("a second listing failure cannot erase a saved file during checkout", () => {
    const { t1 } = makeTwoCommits();
    plantJournal({ worktreeTree: t1, stagedTree: revParse("HEAD^{tree}"), head: revParse("HEAD") });
    const env = injectGitFault("args[0] === 'ls-tree' && args.at(-1) === " + JSON.stringify(t1) + " && ++count === 2");
    expect(runGateIn(repo, "echo ok", { env }).status).toBe(0);
    expect(readFileSync(join(repo, "data.txt"), "utf8")).toBe("one\n");
    expect(g("show", ":data.txt").stdout).toBe("two\n");
    expect(existsSync(journalPath())).toBe(false);
  });

  test("the commit hook preserves an existing journal when its recovery is incomplete", () => {
    const { t1 } = makeTwoCommits();
    const saved = { worktreeTree: t1, stagedTree: revParse("HEAD^{tree}"), head: revParse("HEAD") };
    plantJournal(saved);
    writeFileSync(join(repo, "data.txt"), "interrupted\n");
    const env = injectGitFault("args[0] === 'checkout-index'");
    expect(runCommitGate(repo, { env }).status).toBe(2);
    expect(JSON.parse(readFileSync(journalPath(), "utf8"))).toEqual(saved);
    expect(runGate("echo ok").status).toBe(0);
    expect(readFileSync(join(repo, "data.txt"), "utf8")).toBe("one\n");
    expect(g("show", ":data.txt").stdout).toBe("two\n");
  });

  test.each(["HEAD read", "listing", "worktree", "index", "held lock"])("retries recovery after %s", (fault) => {
    const { t1 } = makeTwoCommits();
    const journal = { worktreeTree: t1, stagedTree: revParse("HEAD^{tree}"), head: revParse("HEAD") };
    plantJournal({ ...journal, indexPath: null });
    g("read-tree", t1);
    const lock = join(stateDir(), "gate-roundtrip.lock");
    if (fault === "held lock") mkdirSync(lock);
    const env = injectGitFault(
      fault === "HEAD read" ? "args[0] === 'rev-parse' && args[1] === 'HEAD'"
        : fault === "listing" ? "args[0] === 'ls-tree' && args.at(-1) === " + JSON.stringify(t1)
        : fault === "worktree" ? "args[0] === 'checkout-index'"
        : fault === "index" ? "args[0] === 'read-tree' && !opts.env?.GIT_INDEX_FILE"
        : "false",
    );
    const first = runGateIn(repo, "echo ok", { env });
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(readFileSync(journalPath(), "utf8"))).toEqual({ ...journal, indexPath: null });
    expect(readFileSync(join(repo, "data.txt"), "utf8")).toBe(fault === "index" ? "one\n" : "two\n");
    expect(g("show", ":data.txt").stdout).toBe(fault === "worktree" ? "two\n" : "one\n");
    if (fault === "held lock") rmSync(lock, { recursive: true });
    expect(runGate("echo ok").status).toBe(0);
    expect(readFileSync(join(repo, "data.txt"), "utf8")).toBe("one\n");
    expect(g("show", ":data.txt").stdout).toBe("two\n");
    expect(existsSync(journalPath())).toBe(false);
  });

  test.each(["materialization", "rollback", "ordinary worktree restore", "ordinary index restore"])(
    "preserves both trees after failed %s", (fault) => {
      writeFileSync(join(repo, "sentinel.txt"), "stage\n");
      g("add", "sentinel.txt");
      const stagedTree = g("write-tree").stdout.trim();
      writeFileSync(join(repo, "sentinel.txt"), "working\n");
      const env = injectGitFault(
        fault === "ordinary index restore" ? "args[0] === 'read-tree' && !opts.env?.GIT_INDEX_FILE"
          : "args[0] === 'checkout-index' && " + (fault === "rollback" ? "true"
            : fault === "materialization" ? "++count === 1" : "++count === 2"),
        fault === "rollback" || fault === "materialization",
      );
      const first = runCommitGate(repo, { env });
      expect(first.status, first.stderr).toBe(fault === "materialization" ? 0 : 2);
      if (fault === "materialization") {
        expect(existsSync(journalPath())).toBe(false);
      } else {
        const saved = JSON.parse(readFileSync(journalPath(), "utf8"));
        expect(saved.stagedTree).toBe(stagedTree);
        if (fault === "rollback") expect(readFileSync(join(repo, "sentinel.txt"), "utf8")).toBe("stage\n");
        expect(g("show", saved.worktreeTree + ":sentinel.txt").stdout).toBe("working\n");
        expect(runGate("echo ok").status).toBe(0);
      }
      expect(existsSync(journalPath())).toBe(false);
      expect(readFileSync(join(repo, "sentinel.txt"), "utf8")).toBe("working\n");
      expect(g("show", ":sentinel.txt").stdout).toBe("stage\n");
    },
  );

  test("recovery still heals normally when HEAD has NOT moved", () => {
    // Journal captured under the CURRENT Head: recovery applies the trees —
    // the pre-crash worktree content comes back and the journal is consumed.
    const { t1 } = makeTwoCommits();
    const head = revParse("HEAD");
    plantJournal({ indexPath: null, worktreeTree: t1, stagedTree: t1, head, at: new Date().toISOString() });

    const r = runGate("echo ok");
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    // The journaled trees WERE applied: data.txt is back at the journaled "one".
    expect(readFileSync(join(repo, "data.txt"), "utf8").trim()).toBe("one");
    expect(existsSync(journalPath())).toBe(false);
    const quarantined = readdirSync(stateDir()).filter((f) => f.includes("quarantine"));
    expect(quarantined.length, "no quarantine on a clean recovery").toBe(0);
  });
});
