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
function runHook(root: string, command: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSyncHidden(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_CODE_SESSION_ID: "test-session",
      ...env,
    },
  });
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

  it("a feature-branch push is not gated even with no stamp", () => {
    const root = makeRepo({ branch: "feature/x" });
    expect(runHook(root, "git push origin feature/x").status).toBe(0);
    expect(runHook(root, "git push origin HEAD:refs/heads/feature/x").status).toBe(0);
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
