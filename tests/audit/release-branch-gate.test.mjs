import { test, expect } from "vitest";

// Importing the release script must be side-effect free: `main()` only runs when
// the module is invoked as the entry script, so importing these pure gate
// helpers here does NOT push/tag/publish.
import {
  evaluateReleaseBranch,
  resolveReleasePushRefspec,
} from "../../scripts/release-and-publish.mjs";

const DEFAULT = "main";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

test("(a) on the default branch: admitted regardless of SHA state", () => {
  const verdict = evaluateReleaseBranch({
    branch: DEFAULT,
    defaultBranch: DEFAULT,
    headSha: null,
    remoteDefaultSha: null,
  });
  expect(verdict.allowed).toBe(true);
  expect(verdict.branch).toBe(DEFAULT);
  expect(verdict.reason).toBe("on_default_branch");
});

test("(b) linked worktree whose HEAD equals origin/<default>: admitted", () => {
  const verdict = evaluateReleaseBranch({
    branch: "claude/eloquent-lap",
    defaultBranch: DEFAULT,
    headSha: SHA,
    remoteDefaultSha: SHA,
  });
  expect(verdict.allowed).toBe(true);
  expect(verdict.branch).toBe("claude/eloquent-lap");
  expect(verdict.reason).toBe("worktree_head_equals_remote_default");
});

test("(c) feature branch whose HEAD diverges from origin/<default>: rejected", () => {
  const verdict = evaluateReleaseBranch({
    branch: "claude/diverged-lap",
    defaultBranch: DEFAULT,
    headSha: SHA,
    remoteDefaultSha: OTHER_SHA,
  });
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toBe("branch_not_synced_with_remote_default");
});

test("(d) off-default branch with unresolved remote/HEAD SHAs: rejected (no accidental admit)", () => {
  const missingRemote = evaluateReleaseBranch({
    branch: "claude/lap",
    defaultBranch: DEFAULT,
    headSha: SHA,
    remoteDefaultSha: null,
  });
  expect(missingRemote.allowed).toBe(false);
  expect(missingRemote.reason).toBe("branch_not_synced_with_remote_default");

  const missingHead = evaluateReleaseBranch({
    branch: "claude/lap",
    defaultBranch: DEFAULT,
    headSha: null,
    remoteDefaultSha: SHA,
  });
  expect(missingHead.allowed).toBe(false);
  expect(missingHead.reason).toBe("branch_not_synced_with_remote_default");
});

test("(e) detached HEAD (empty branch name): rejected", () => {
  const verdict = evaluateReleaseBranch({
    branch: "",
    defaultBranch: DEFAULT,
    headSha: SHA,
    remoteDefaultSha: SHA,
  });
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toBe("detached_head");
});

test("(f) whitespace SHAs are trimmed before comparison", () => {
  const verdict = evaluateReleaseBranch({
    branch: "claude/lap",
    defaultBranch: DEFAULT,
    headSha: `  ${SHA}  `,
    remoteDefaultSha: `${SHA}\n`,
  });
  expect(verdict.allowed).toBe(true);
  expect(verdict.reason).toBe("worktree_head_equals_remote_default");
});

test("push refspec: on the default branch pushes the branch by name", () => {
  expect(resolveReleasePushRefspec({ branch: DEFAULT, defaultBranch: DEFAULT })).toEqual({
    target: DEFAULT,
  });
});

test("push refspec: from a linked worktree pushes HEAD onto the remote default branch", () => {
  expect(
    resolveReleasePushRefspec({ branch: "claude/lap", defaultBranch: DEFAULT }),
  ).toEqual({ target: `HEAD:refs/heads/${DEFAULT}` });
});
