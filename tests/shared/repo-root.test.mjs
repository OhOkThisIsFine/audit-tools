/**
 * repo-root.test.mjs — repo-root anchoring that untrusts a drifted process cwd
 * (open bug, observed 2026-07-04). A remediate/audit run whose cwd wandered into
 * `.audit-tools/` recomputed repo_root as that dir and minted a phantom nested
 * `.audit-tools/.audit-tools/` tree forked off the real run. These tests pin the
 * three defenses: climb-out-of-.audit-tools, nearest-existing-marker re-anchor,
 * and the loud `auditToolsDir` guard that makes the phantom tree impossible.
 */
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  resolveRepoRoot,
  climbOutOfAuditTools,
  auditToolsDir,
  remediationArtifactsDir,
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
