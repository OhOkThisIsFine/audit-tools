// Contract test for the PreToolUse push gate (.claude/hooks/push-gate.mjs).
//
// The gap it closes: an agent push to `main` was gated on nothing but the
// touched area's checks, and a CROSS-AREA invariant is only reachable by the
// full suite — which nothing local runs before a push (two commits shipped red
// on 2026-08-27 this way). `scripts/shared/suiteGreenStamp.mjs` already records
// a full-suite green bound to the tree it ran on; this hook is the push boundary
// consuming that same single-sourced verdict.
//
// The hook is spawned by its REAL path with a real PreToolUse payload, and the
// stamp is written through the REAL writer, so the test cannot drift from the
// gate the way a hand-rolled stamp file would.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { writeSuiteGreenStamp } from "../../scripts/shared/suiteGreenStamp.mjs";
import { worktreeTree } from "../../scripts/shared/worktree-tree.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = resolve(REPO_ROOT, ".claude", "hooks", "push-gate.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A repo on `branch`, optionally carrying a suite-green stamp bound to its own
 * CURRENT tree (or to a deliberately DIFFERENT tree, for the stale case).
 */
function makeRepo({ branch = "main", stamp = "none" }: { branch?: string; stamp?: "none" | "bound" | "stale" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "push-gate-"));
  dirs.push(root);
  const git = (...args: string[]) => {
    const r = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", branch);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
  // Mirrors the real repo: the stamp lands under .claude/, which is gitignored,
  // so writing it cannot move the very tree it describes. Without this the
  // "bound" case could never hold — the stamp would invalidate itself.
  writeFileSync(join(root, ".gitignore"), ".claude/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  if (stamp === "bound") writeSuiteGreenStamp(root, worktreeTree(root));
  if (stamp === "stale") writeSuiteGreenStamp(root, "0".repeat(40));
  return root;
}

/** Drive the hook exactly as the harness would: payload on stdin, env markers set. */
function runHook(
  root: string,
  command: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  const env: NodeJS.ProcessEnv = options.env ?? {};
  const cwd: string | undefined = options.cwd;
  return spawnSyncHidden(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command,
        ...(cwd ? { cwd } : {}),
      },
      ...(cwd ? { cwd } : {}),
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_CODE_SESSION_ID: "test-session",
      ...env,
    },
  });
}

function makeWorktree(mainRoot: string, branchName = "wt-branch") {
  const wtDir = mkdtempSync(join(tmpdir(), "push-gate-wt-"));
  dirs.push(wtDir);
  const git = (...args: string[]) => {
    const r = spawnSyncHidden("git", args, { cwd: mainRoot, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("worktree", "add", "-q", "-b", branchName, wtDir);
  return wtDir;
}

describe("push-gate: an agent push to a protected branch needs a full-suite stamp", () => {
  it("REFUSES a push to main with no stamp, and says how to mint one", () => {
    const root = makeRepo();
    const r = runHook(root, "git push origin main");
    expect(r.status, `expected refusal (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/push to a PROTECTED branch/);
    expect(r.stderr).toMatch(/no full-suite green stamp exists/);
    expect(r.stderr).toMatch(/npm test/);
  });

  it("ALLOWS the same push once a full-suite stamp binds the pushed tree", () => {
    const root = makeRepo({ stamp: "bound" });
    const r = runHook(root, "git push origin main");
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
  });

  it("REFUSES when the stamp covers DIFFERENT content — an edit voids the run", () => {
    // The whole point of binding to the tree: a stamp written before the last
    // edit is not evidence about the tree being pushed.
    const root = makeRepo({ stamp: "stale" });
    const r = runHook(root, "git push origin main");
    expect(r.status, `expected refusal (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/covered different content/);
  });

  it("a bare `git push` is judged by HEAD — refused ON main, allowed OFF it", () => {
    const onMain = makeRepo();
    expect(runHook(onMain, "git push").status).toBe(2);
    const onBranch = makeRepo({ branch: "feature/x" });
    const r = runHook(onBranch, "git push");
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
  });

  it("an explicit HEAD source on main still targets the protected branch", () => {
    const root = makeRepo({ branch: "main" });
    expect(runHook(root, "git push origin HEAD").status).toBe(2);
  });

  it("--all includes the protected local branch even when a feature branch is checked out", () => {
    const root = makeRepo({ branch: "main" });
    const checkout = spawnSyncHidden("git", ["checkout", "-qb", "feature"], { cwd: root, encoding: "utf8" });
    expect(checkout.status).toBe(0);
    expect(runHook(root, "git push --all origin").status).toBe(2);
  });

  it("a feature-branch push is not gated even with no stamp", () => {
    const root = makeRepo({ branch: "feature/x" });
    expect(runHook(root, "git push origin feature/x").status).toBe(0);
    expect(runHook(root, "git push origin HEAD:refs/heads/feature/x").status).toBe(0);
  });

  it("evaluates explicit refspecs against the sent local ref's tree", () => {
    const root = makeRepo({ stamp: "none" });
    const git = (...args: string[]) => {
      const r = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    git("checkout", "-b", "feature");
    writeFileSync(join(root, "feature.txt"), "feature data\n");
    git("add", "-A");
    git("commit", "-qm", "feat");

    // With no stamp for feature tree, explicit refspecs to main refuse
    const r1 = runHook(root, "git push origin feature:main");
    expect(r1.status).toBe(2);
    expect(r1.stderr).toMatch(/no full-suite green stamp exists/);

    const r2 = runHook(root, "git push origin HEAD:main");
    expect(r2.status).toBe(2);

    const r3 = runHook(root, "git push origin +feature:main");
    expect(r3.status).toBe(2);

    // Stamping the feature tree allows all explicit refspecs sending that tree
    writeSuiteGreenStamp(root, worktreeTree(root));
    expect(runHook(root, "git push origin feature:main").status).toBe(0);
    expect(runHook(root, "git push origin HEAD:main").status).toBe(0);
    expect(runHook(root, "git push origin +feature:main").status).toBe(0);

    // If stamp is stale for feature tree, refuse
    writeSuiteGreenStamp(root, "0".repeat(40));
    const rStale = runHook(root, "git push origin feature:main");
    expect(rStale.status).toBe(2);
    expect(rStale.stderr).toMatch(/covered different content/);
  });

  it("judges a worktree push by the worktree's own stamp and never substitutes CLAUDE_PROJECT_DIR", () => {
    // Main checkout has NO stamp, worktree has a bound stamp
    const mainRoot = makeRepo({ stamp: "none" });
    const wtDir = makeWorktree(mainRoot, "wt-lap");
    writeFileSync(join(wtDir, "worktree.txt"), "lap data\n");
    spawnSyncHidden("git", ["add", "-A"], { cwd: wtDir });
    spawnSyncHidden("git", ["commit", "-qm", "wt commit"], { cwd: wtDir });

    writeSuiteGreenStamp(wtDir, worktreeTree(wtDir));

    // CLAUDE_PROJECT_DIR points to mainRoot, but command runs in wtDir
    const r = runHook(mainRoot, "git push origin HEAD:main", { cwd: wtDir });
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
  });

  it("cross-main/worktree stamps cannot certify each other accidentally", () => {
    const mainRoot = makeRepo({ stamp: "bound" });
    const wtDir = makeWorktree(mainRoot, "wt-lap-2");
    writeFileSync(join(wtDir, "worktree2.txt"), "lap data 2\n");
    spawnSyncHidden("git", ["add", "-A"], { cwd: wtDir });
    spawnSyncHidden("git", ["commit", "-qm", "wt commit 2"], { cwd: wtDir });

    // 1. Main has bound stamp, worktree has NO stamp: push from worktree must be REFUSED
    const rWt = runHook(mainRoot, "git push origin HEAD:main", { cwd: wtDir });
    expect(rWt.status, `expected refusal (2); stderr:\n${rWt.stderr}`).toBe(2);
    expect(rWt.stderr).toMatch(/no full-suite green stamp exists for this checkout/);

    // 2. Now stamp worktree, but make main's stamp stale
    writeSuiteGreenStamp(wtDir, worktreeTree(wtDir));
    writeSuiteGreenStamp(mainRoot, "0".repeat(40));

    // Worktree push now succeeds with its own stamp
    expect(runHook(mainRoot, "git push origin HEAD:main", { cwd: wtDir }).status).toBe(0);

    // Push from mainRoot fails because mainRoot's stamp is stale
    const rMain = runHook(mainRoot, "git push origin main", { cwd: mainRoot });
    expect(rMain.status, `expected refusal (2); stderr:\n${rMain.stderr}`).toBe(2);
    expect(rMain.stderr).toMatch(/covered different content/);
  });

  it("does NOT fire for a non-agent session — a plain terminal pushes as before", () => {
    const root = makeRepo();
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_PID;
    delete env.AUDIT_TOOLS_CHILD_SESSION;
    const r = spawnSyncHidden(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" } }),
      encoding: "utf8",
      env,
    });
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
  });

  it("does NOT fire on a non-push command — the trigger stays narrow", () => {
    const root = makeRepo();
    for (const cmd of ["git status", "npm run build", "git log --oneline", "git push --dry-run"]) {
      const r = runHook(root, cmd);
      expect(r.status, `"${cmd}" must not be gated; stderr:\n${r.stderr}`).toBe(0);
    }
  });

  it("recognizes git push --delete, -d, and :dst as deletions and does not demand a green stamp", () => {
    // Root on main with NO stamp
    const root = makeRepo({ branch: "main", stamp: "none" });

    // Ordinary push to main fails
    expect(runHook(root, "git push origin main").status).toBe(2);

    // Deletion of protected branch via --delete, -d, or :main sends no local ref -> allowed
    expect(runHook(root, "git push origin --delete main").status).toBe(0);
    expect(runHook(root, "git push origin -d main").status).toBe(0);
    expect(runHook(root, "git push -d origin main").status).toBe(0);
    expect(runHook(root, "git push --delete origin main").status).toBe(0);
    expect(runHook(root, "git push origin :main").status).toBe(0);

    // Deletion of a non-protected branch while on main must not demand a stamp for HEAD
    expect(runHook(root, "git push origin --delete feature").status).toBe(0);
    expect(runHook(root, "git push origin -d feature").status).toBe(0);
    expect(runHook(root, "git push origin :feature").status).toBe(0);
  });

  it("inspects every explicit refspec in a multi-ref push: branch1:main branch2:master requires stamps for both", () => {
    const root = makeRepo({ stamp: "none" });
    const git = (...args: string[]) => {
      const r = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };

    // Create branch1 with unique tree
    git("checkout", "-b", "branch1");
    writeFileSync(join(root, "b1.txt"), "branch1 data\n");
    git("add", "-A");
    git("commit", "-qm", "commit branch1");
    const b1Tree = worktreeTree(root);

    // Create branch2 with different unique tree
    git("checkout", "-b", "branch2");
    writeFileSync(join(root, "b2.txt"), "branch2 data\n");
    git("add", "-A");
    git("commit", "-qm", "commit branch2");
    const b2Tree = worktreeTree(root);

    // Neither branch stamped: must refuse
    const rNeither = runHook(root, "git push origin branch1:main branch2:master");
    expect(rNeither.status).toBe(2);
    expect(rNeither.stderr).toMatch(/push to a PROTECTED branch/);

    // Only branch1 stamped: must refuse because branch2 is not stamped
    writeSuiteGreenStamp(root, b1Tree);
    const rOnlyB1 = runHook(root, "git push origin branch1:main branch2:master");
    expect(rOnlyB1.status, `expected refusal (2); stderr:\n${rOnlyB1.stderr}`).toBe(2);
    expect(rOnlyB1.stderr).toMatch(/push to a PROTECTED branch/);

    // Only branch2 stamped: must refuse because branch1 is not stamped
    writeSuiteGreenStamp(root, b2Tree);
    const rOnlyB2 = runHook(root, "git push origin branch1:main branch2:master");
    expect(rOnlyB2.status, `expected refusal (2); stderr:\n${rOnlyB2.stderr}`).toBe(2);
    expect(rOnlyB2.stderr).toMatch(/push to a PROTECTED branch/);

    // When both target protected and one is a deletion refspec (:main branch2:master):
    // If branch2 is stamped, allowed; if branch2 is unstamped, refused.
    writeSuiteGreenStamp(root, b2Tree);
    expect(runHook(root, "git push origin :main branch2:master").status).toBe(0);

    writeSuiteGreenStamp(root, "0".repeat(40)); // invalid/stale
    const rDelB2 = runHook(root, "git push origin :main branch2:master");
    expect(rDelB2.status).toBe(2);

    // If both refs point to the same stamped tree (e.g. branch2 and branch2_alias), passes
    git("branch", "branch2_alias", "branch2");
    writeSuiteGreenStamp(root, b2Tree);
    expect(runHook(root, "git push origin branch2:main branch2_alias:master").status).toBe(0);
  });

  it("FAILS OPEN, announced, on a relocated push it cannot attribute", () => {
    // The declared uncovered half: a `cd`/`git -C` hop needs the commit gate's
    // jurisdiction machinery to attribute. It is announced rather than silently
    // unjudged, so the skip cannot read as a pass.
    const root = makeRepo();
    const r = runHook(root, "cd /tmp/other && git push origin main");
    expect(r.status, `expected pass (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/FAIL-OPEN/);
    expect(r.stderr).toMatch(/relocated push/);
  });
});
