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

describe("pre-commit gate: every commit-creating subcommand is DETECTED (P9)", () => {
  // git merge / rebase / cherry-pick / revert / am all WRITE HISTORY. Under P53
  // the legs that judge the snapshot run in git's own hooks (pre-commit for a
  // commit, pre-merge-commit for a merge commit, pre-applypatch for am —
  // measured 2026-09-05; the sequencer runs NO pre-commit for cherry-pick,
  // revert or a rebase replay), so this hook has to SEE each verb for the
  // bypass refusal git cannot make, and ROUTE the unhooked verbs' gated content.
  const commitCreating = [
    "git merge feature",
    "git rebase --continue",
    "git cherry-pick abc123",
    "git revert abc123",
    "git am patch.mbox",
  ];
  for (const cmd of commitCreating) {
    test(`detects \`${cmd}\` — a bypass token on it is refused`, () => {
      const r = runGate(`${cmd} --no-verify`);
      expect(r.status, `expected bypass refusal (2) for "${cmd}"; stderr:\n${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/bypass/i);
    });
  }

  test("a red snapshot alone no longer blocks here — git's hook is the judge", () => {
    writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
    g("add", "sentinel.txt");
    const r = runGate("git cherry-pick abc123");
    expect(r.status, `expected pass-through (0); stderr:\n${r.stderr}`).toBe(0);
  });

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

  // P53: git runs NO pre-commit for a cherry-pick or revert (the sequencer
  // commits directly) and none for a fast-forward merge, so the tool-boundary
  // hook ROUTES gated incoming content to a hooked commit instead of judging it
  // with a second copy of the attestation legs: `--no-ff` for a merge,
  // `-n`/`--no-commit` (then `git commit`) for cherry-pick and revert.
  test("a cherry-pick of a loop-core commit is refused unless it lands through `git commit` (-n)", () => {
    const sha = sideBranchWithLoopCore();
    expect(g("status", "--porcelain").stdout.trim(), "index must be clean").toBe("");
    const direct = runGate(`git cherry-pick ${sha}`);
    expect(direct.status, `expected block (2); stderr:\n${direct.stderr}`).toBe(2);
    expect(direct.stderr).toMatch(/loop-core/i);
    expect(direct.stderr).toContain("--no-commit");
    const routed = runGate(`git cherry-pick -n ${sha}`);
    expect(routed.status, `expected pass-through (0); stderr:\n${routed.stderr}`).toBe(0);
  });

  test("a merge that introduces a loop-core path and could fast-forward is refused, naming --no-ff", () => {
    sideBranchWithLoopCore();
    const r = runGate("git merge side");
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/loop-core/i);
    expect(r.stderr).toContain("--no-ff");
  });

  test("the same merge with --no-ff passes through — pre-merge-commit will judge the merged index", () => {
    sideBranchWithLoopCore();
    const r = runGate("git merge --no-ff side");
    expect(r.status, `expected pass-through (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("a merge introducing NO loop-core or constitutional path is left alone (not a false red)", () => {
    g("checkout", "-q", "-b", "plain");
    writeFileSync(join(repo, "notes.md"), "hello\n");
    g("add", "-A");
    g("commit", "-qm", "docs only");
    g("checkout", "-q", "-");
    const r = runGate("git merge plain");
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("an unresolvable merge ref FAILS OPEN and NAMES the check it skipped", () => {
    const r = runGate("git merge deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/FAIL-OPEN/);
    expect(r.stderr).toMatch(/incoming ref/i);
  });
});
