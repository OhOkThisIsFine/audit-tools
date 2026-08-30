// Pre-commit gate: every commit-CREATING subcommand is gated (P9). Fixture +
// rationale in pre-commit-gate-harness.ts (shared across the
// pre-commit-gate-*.test.ts family).
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("pre-commit gate: every commit-creating subcommand is gated (P9)", () => {
  // git merge / rebase / cherry-pick / revert / am all WRITE HISTORY and used
  // to skip every leg of the gate — observed live as stray-doc failures on all
  // three merge commits of the v0.34.7 queue. With a BAD sentinel staged, a
  // gated command must block exactly like `git commit` does.
  const commitCreating = [
    "git merge feature",
    "git rebase --continue",
    "git cherry-pick abc123",
    "git revert abc123",
    "git am patch.mbox",
  ];
  for (const cmd of commitCreating) {
    test(`gates \`${cmd}\`, which creates a commit`, () => {
      writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
      g("add", "sentinel.txt");
      const r = runGate(cmd);
      expect(r.status, `expected block (2) for "${cmd}"; stderr:\n${r.stderr}`).toBe(2);
    });
  }

  test("still allows a git subcommand that cannot create a commit", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    expect(runGate("git status").status).toBe(0);
  });

  test("still does not fire on a command merely NAMING a commit-creating word in a path", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    expect(runGate("git status -- src/merge-results.ts").status).toBe(0);
    expect(runGate("git log --merges").status).toBe(0);
  });

  test("a hook-bypass vector on a merge is refused like on a commit", () => {
    const r = runGate("git merge --no-verify feature");
    expect(r.status, `expected bypass refusal (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/bypass/i);
  });

  // Short `-n` means `--no-verify` on `git commit` ALONE. On cherry-pick and
  // revert it is `--no-commit`, which is the SAFER form — it leaves the result
  // staged for this very gate to read — and on merge it is `--no-stat`. Refusing
  // those as a bypass is a false RED that pushes the caller toward the
  // un-inspectable form, which is the opposite of what the gate wants. The
  // long-form `--no-verify` / `core.hooksPath` vectors stay whole-command matched
  // and are unaffected.
  test("`-n` is a bypass on commit, and NOT where it means --no-commit/--no-stat", () => {
    const bypass = runGate("git commit -n -m x");
    expect(bypass.status, `expected bypass refusal (2); stderr:\n${bypass.stderr}`).toBe(2);
    expect(bypass.stderr).toMatch(/bypass/i);

    for (const cmd of [
      "git cherry-pick -n abc123",
      "git revert -n abc123",
      "git merge -n feature",
    ]) {
      const r = runGate(cmd);
      expect(r.stderr, `"${cmd}" must not be refused as a hook bypass`).not.toMatch(/bypass/i);
      expect(r.status, `expected pass (0) on a green snapshot for "${cmd}"; stderr:\n${r.stderr}`).toBe(
        0,
      );
    }
  });
});

// The gate reads the INDEX, so a fresh cherry-pick or merge stages NOTHING: the
// loop-core attestation used to read an empty set and demand nothing while the
// command landed the incoming tree. The gate recorded that as an accepted limit
// until the owner reversed it (2026-08-29), because the incoming path set IS
// derivable before the command runs, from the ref the command names.
describe("pre-commit gate: a history-moving verb is judged on its INCOMING paths", () => {
  // Put the loop-core change on a SIDE BRANCH and come back with a clean index,
  // so the only way to see that content is to resolve the ref.
  // NOT the harness `stageLoopCoreFile` helper: it writes src/shared/quota/x.ts,
  // which isLoopCorePath returns FALSE for, so it does not arm the gate on its
  // own (docs/backlog/open-bugs.md). src/shared/engine/ is a real loop-core path.
  function sideBranchWithLoopCore(): string {
    g("checkout", "-q", "-b", "side");
    mkdirSync(join(repo, "src", "shared", "engine"), { recursive: true });
    writeFileSync(join(repo, "src", "shared", "engine", "x.ts"), "export const x = 1;\n");
    g("add", "-A");
    g("commit", "-qm", "loop-core change");
    const sha = g("rev-parse", "HEAD").stdout.trim();
    g("checkout", "-q", "-");
    return sha;
  }

  test("a cherry-pick of a loop-core commit demands an attestation", () => {
    const sha = sideBranchWithLoopCore();
    expect(g("status", "--porcelain").stdout.trim(), "index must be clean").toBe("");
    const r = runGate(`git cherry-pick ${sha}`);
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/loop-core/i);
  });

  test("a merge that introduces a loop-core path demands an attestation", () => {
    sideBranchWithLoopCore();
    const r = runGate("git merge side");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/loop-core/i);
  });

  test("a cherry-pick introducing NO loop-core path is left alone (not a false red)", () => {
    g("checkout", "-q", "-b", "plain");
    writeFileSync(join(repo, "notes.md"), "hello\n");
    g("add", "-A");
    g("commit", "-qm", "docs only");
    const sha = g("rev-parse", "HEAD").stdout.trim();
    g("checkout", "-q", "-");
    const r = runGate(`git cherry-pick ${sha}`);
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("an unresolvable ref FAILS OPEN and NAMES the check it skipped", () => {
    const r = runGate("git cherry-pick deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/FAIL-OPEN/);
    expect(r.stderr).toMatch(/incoming ref/i);
  });
});
