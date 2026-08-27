/**
 * repo-root.test.mjs — repo-root anchoring that untrusts a drifted process cwd
 * (open bug, observed 2026-07-04). A remediate/audit run whose cwd wandered into
 * `.audit-tools/` recomputed repo_root as that dir and minted a phantom nested
 * `.audit-tools/.audit-tools/` tree forked off the real run. These tests pin the
 * three defenses: climb-out-of-.audit-tools, nearest-existing-marker re-anchor,
 * and the loud `auditToolsDir` guard that makes the phantom tree impossible.
 */
import { test, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  resolveRepoRoot,
  climbOutOfAuditTools,
  discoverRepoRoot,
  callerWorkingDirectory,
  REPO_ROOT_MARKERS,
  auditToolsDir,
  remediationArtifactsDir,
  AUDIT_TOOLS_CALLER_CWD_ENV,
} from "audit-tools/shared";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "repo-root-"));
}

test("climbOutOfAuditTools truncates to the parent of the outermost .audit-tools", () => {
  const root = resolve(sep, "repo");
  expect(climbOutOfAuditTools(join(root, ".audit-tools"))).toBe(root);
  expect(climbOutOfAuditTools(join(root, ".audit-tools", "remediation"))).toBe(root);
  // Nested phantom collapses back to the real root, not the inner .audit-tools.
  expect(
    climbOutOfAuditTools(join(root, ".audit-tools", ".audit-tools", "remediation")),
  ).toBe(root);
});

test("climbOutOfAuditTools leaves a path not inside .audit-tools unchanged", () => {
  const p = resolve(sep, "repo", "src", "shared");
  expect(climbOutOfAuditTools(p)).toBe(p);
});

test("resolveRepoRoot climbs a drifted-into-.audit-tools root back to the repo", () => {
  const repo = tempRepo();
  try {
    mkdirSync(join(repo, ".audit-tools", "remediation"), { recursive: true });
    // Simulate the cwd having drifted into the artifact tree.
    const drifted = join(repo, ".audit-tools", "remediation");
    expect(resolveRepoRoot(drifted)).toBe(resolve(repo));
    // And the default artifacts dir rebases onto the REAL repo — no nesting.
    expect(remediationArtifactsDir(resolveRepoRoot(drifted))).toBe(
      join(repo, ".audit-tools", "remediation"),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveRepoRoot leaves an independent sub-project root untouched (no git/marker over-reach)", () => {
  // A clean dir with no .audit-tools segment must be returned as-is even when it
  // is nested inside a larger git repo / a dir that owns a .audit-tools tree —
  // the fix must not re-home a legitimate sub-project root to the outer repo.
  const repo = tempRepo();
  try {
    const subProject = join(repo, "packages", "widget");
    mkdirSync(subProject, { recursive: true });
    mkdirSync(join(repo, ".audit-tools"), { recursive: true });
    expect(resolveRepoRoot(subProject)).toBe(resolve(subProject));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// discoverRepoRoot — canonical root for a run given NO explicit --root. The
// audit loader used to demand `--root` on every command precisely because this
// did not exist: the default resolved the process cwd verbatim, so the same
// repository got a different root (and a phantom `.audit-tools/`) per cwd.
// ---------------------------------------------------------------------------

test("discoverRepoRoot resolves the repo root from a nested cwd inside the repo", () => {
  const repo = tempRepo();
  try {
    mkdirSync(join(repo, ".git"), { recursive: true });
    const nested = join(repo, "src", "audit", "cli");
    mkdirSync(nested, { recursive: true });
    expect(discoverRepoRoot(nested)).toBe(resolve(repo));
    // Every command in the same repo agrees, whatever the cwd.
    expect(discoverRepoRoot(join(repo, "tests"))).toBe(resolve(repo));
    expect(discoverRepoRoot(repo)).toBe(resolve(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discoverRepoRoot resolves the repo root from a cwd inside .audit-tools/", () => {
  const repo = tempRepo();
  try {
    mkdirSync(join(repo, ".git"), { recursive: true });
    const drifted = join(repo, ".audit-tools", "audit", "steps");
    mkdirSync(drifted, { recursive: true });
    expect(discoverRepoRoot(drifted)).toBe(resolve(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discoverRepoRoot accepts a .git FILE (git worktree / submodule checkout)", () => {
  const repo = tempRepo();
  try {
    // A linked worktree's `.git` is a file holding `gitdir: …`, not a directory.
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    const nested = join(repo, "packages", "widget");
    mkdirSync(nested, { recursive: true });
    expect(discoverRepoRoot(nested)).toBe(resolve(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discoverRepoRoot stops at the NEAREST marker — an existing run is never re-homed to an outer repo", () => {
  const outer = tempRepo();
  try {
    mkdirSync(join(outer, ".git"), { recursive: true });
    const sub = join(outer, "packages", "widget");
    // The sub-project already owns a run tree, so it IS the root for a cwd
    // beneath it — the outer git repo must not swallow it.
    mkdirSync(join(sub, ".audit-tools", "audit"), { recursive: true });
    mkdirSync(join(sub, "src"), { recursive: true });
    expect(discoverRepoRoot(join(sub, "src"))).toBe(resolve(sub));
    expect(discoverRepoRoot(join(sub, ".audit-tools", "audit"))).toBe(resolve(sub));
    // A sibling with no run tree still belongs to the outer repo.
    const sibling = join(outer, "packages", "other");
    mkdirSync(sibling, { recursive: true });
    expect(discoverRepoRoot(sibling)).toBe(resolve(outer));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("discoverRepoRoot never claims a marker-less directory as a root", () => {
  // Machine-independent by construction: the fixture carries no marker, so no
  // directory inside it may be chosen. Whatever the ancestors of the OS temp
  // dir happen to hold, the answer is either a genuine marker-bearing ancestor
  // or the start dir itself — never a marker-less intermediate, which is what
  // "outside any target repo behaves as before" reduces to.
  const base = tempRepo();
  try {
    const nested = join(base, "pkg", "src");
    mkdirSync(nested, { recursive: true });
    const found = discoverRepoRoot(nested);
    expect(
      found === resolve(nested) ||
        REPO_ROOT_MARKERS.some((marker) => existsSync(join(found, marker))),
      `discoverRepoRoot returned ${found}, which is neither the start dir nor a marker-bearing ancestor`,
    ).toBe(true);
    expect(found).not.toBe(join(base, "pkg"));
    expect(found).not.toBe(resolve(base));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Run `fn` with the process's reported home directory pointed at `dir`.
 * `os.homedir()` reads USERPROFILE on win32 and HOME on posix, so setting both
 * is the portable redirect — the same mechanism `verifyHostsIsolated` uses to
 * keep an installer smoke test out of the operator's real config.
 */
function withHomeDir<T>(dir: string, fn: () => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

test("discoverRepoRoot never climbs past the home directory — ~/.audit-tools is the cache home, not a run root", () => {
  // Caught for real: `~/.audit-tools/` holds the machine-wide analyzer cache on
  // every box, so an unbounded marker climb from any directory outside a
  // repository resolved the operator's HOME as the target repo (an audit of the
  // entire home tree). tests/audit/linux-cycle-regression.test.ts went red on
  // exactly this.
  const home = tempRepo();
  try {
    mkdirSync(join(home, ".audit-tools", "analyzer-cache"), { recursive: true });
    const outsideAnyRepo = join(home, "scratch", "fixture", "repo");
    mkdirSync(outsideAnyRepo, { recursive: true });
    expect(withHomeDir(home, () => discoverRepoRoot(outsideAnyRepo))).toBe(
      resolve(outsideAnyRepo),
    );
    // A real repository BELOW home is still discovered — the ceiling bounds the
    // climb, it does not disable it.
    const repo = join(home, "code", "project");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    expect(withHomeDir(home, () => discoverRepoRoot(join(repo, "src")))).toBe(
      resolve(repo),
    );
    // Standing IN the home directory still yields the home directory (unchanged
    // from the pre-discovery "the cwd is the root" behaviour).
    expect(withHomeDir(home, () => discoverRepoRoot(home))).toBe(resolve(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("callerWorkingDirectory prefers the wrapper-stamped caller cwd over process.cwd()", () => {
  const previous = process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
  try {
    delete process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
    expect(callerWorkingDirectory()).toBe(process.cwd());
    const stamped = resolve(sep, "somewhere", "the-caller-really-was");
    process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = stamped;
    expect(callerWorkingDirectory()).toBe(stamped);
    // An empty stamp is not a location — fall back rather than resolve "".
    process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = "";
    expect(callerWorkingDirectory()).toBe(process.cwd());
  } finally {
    if (previous === undefined) delete process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
    else process.env[AUDIT_TOOLS_CALLER_CWD_ENV] = previous;
  }
});

test("auditToolsDir refuses to nest under a path already inside .audit-tools", () => {
  const inside = resolve(sep, "repo", ".audit-tools");
  expect(() => auditToolsDir(inside)).toThrow(/already inside .audit-tools/);
  expect(() => auditToolsDir(join(inside, "remediation"))).toThrow(
    /already inside .audit-tools/,
  );
  // A clean repo root is fine.
  expect(auditToolsDir(resolve(sep, "repo"))).toBe(
    join(resolve(sep, "repo"), ".audit-tools"),
  );
});
