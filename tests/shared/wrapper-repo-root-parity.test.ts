/**
 * wrapper-repo-root-parity — the wrapper's repo-root discovery is a MIRROR of
 * the shared one, and this is what stops the two copies from drifting.
 *
 * The wrapper cannot import the shared TypeScript (or its build output): the
 * installer verbs `ensure` / `install` / `verify-install` are answered entirely
 * in plain node BEFORE any build, so the copy in `wrapper/repo-root.mjs` exists
 * for the same bootstrap constraint that forces `quoteForCmd` to be mirrored
 * there. That copy is bin-neutral — BOTH wrappers import it, so this parity test
 * covers audit-code's and remediate-code's installer verbs at once. Both copies
 * are run here over the same fixture trees; a divergence in ANY case is red.
 *
 * Cases are chosen to cover each decision the walk makes: nested cwd, drift
 * into `.audit-tools/`, a `.git` FILE (linked worktree), nearest-marker-wins
 * over an outer repo, the start dir itself, and a marker-less tree.
 */
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRepoRoot as sharedDiscoverRepoRoot,
  climbOutOfAuditTools as sharedClimbOutOfAuditTools,
  REPO_ROOT_MARKERS as SHARED_REPO_ROOT_MARKERS,
} from "audit-tools/shared";
import {
  discoverRepoRoot as wrapperDiscoverRepoRoot,
  climbOutOfAuditTools as wrapperClimbOutOfAuditTools,
  REPO_ROOT_MARKERS as WRAPPER_REPO_ROOT_MARKERS,
} from "../../wrapper/repo-root.mjs";

test("the wrapper and shared copies declare the same root markers", () => {
  expect([...WRAPPER_REPO_ROOT_MARKERS]).toEqual([...SHARED_REPO_ROOT_MARKERS]);
});

test("wrapper and shared discoverRepoRoot agree on every fixture shape", () => {
  const base = mkdtempSync(join(tmpdir(), "wrapper-root-parity-"));
  try {
    // repo/            .git
    //   src/audit/
    //   .audit-tools/audit/steps/
    //   packages/widget/.audit-tools   (nearest-marker-wins)
    //   packages/other/                (belongs to repo)
    // worktree/        .git as a FILE
    // bare/pkg/src/    no marker at all
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "audit"), { recursive: true });
    mkdirSync(join(repo, ".audit-tools", "audit", "steps"), { recursive: true });
    mkdirSync(join(repo, "packages", "widget", ".audit-tools"), { recursive: true });
    mkdirSync(join(repo, "packages", "widget", "src"), { recursive: true });
    mkdirSync(join(repo, "packages", "other"), { recursive: true });

    const worktree = join(base, "worktree");
    mkdirSync(join(worktree, "lib"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");

    const bare = join(base, "bare", "pkg", "src");
    mkdirSync(bare, { recursive: true });

    const cases = [
      repo,
      join(repo, "src", "audit"),
      join(repo, ".audit-tools"),
      join(repo, ".audit-tools", "audit", "steps"),
      join(repo, "packages", "widget", "src"),
      join(repo, "packages", "other"),
      worktree,
      join(worktree, "lib"),
      bare,
      join(base, "bare"),
    ];

    for (const start of cases) {
      expect(
        wrapperDiscoverRepoRoot(start),
        `wrapper/shared discoverRepoRoot disagree for ${start}`,
      ).toBe(sharedDiscoverRepoRoot(start));
      expect(
        wrapperClimbOutOfAuditTools(start),
        `wrapper/shared climbOutOfAuditTools disagree for ${start}`,
      ).toBe(sharedClimbOutOfAuditTools(start));
    }

    // Spot-pin the substantive answers so parity alone cannot be satisfied by
    // two copies that are identically wrong.
    expect(sharedDiscoverRepoRoot(join(repo, "src", "audit"))).toBe(repo);
    expect(sharedDiscoverRepoRoot(join(repo, ".audit-tools", "audit", "steps"))).toBe(repo);
    expect(sharedDiscoverRepoRoot(join(repo, "packages", "widget", "src"))).toBe(
      join(repo, "packages", "widget"),
    );
    expect(sharedDiscoverRepoRoot(join(repo, "packages", "other"))).toBe(repo);
    expect(sharedDiscoverRepoRoot(join(worktree, "lib"))).toBe(worktree);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
