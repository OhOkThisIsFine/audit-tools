/**
 * Index-only staleness for `file_disposition.json` (residual (b) of the
 * untracked-exclusion entry).
 *
 * The bug: the disposition's untracked rule reads the git INDEX, but the
 * disposition's only declared upstream was `repo_manifest.json` — a pure
 * WORKTREE read whose per-file hashes do not move when a file is merely staged
 * or unstaged. Committing a previously-untracked file mid-run therefore left
 * the persisted disposition (and everything downstream of it) looking fresh.
 *
 * The fix puts the index state INTO the manifest as `scope_index_key`, so the
 * existing `repo_manifest.json → file_disposition.json` edge carries it. These
 * tests pin BOTH halves: the probe actually distinguishes an index-only move in
 * a real git repo, and that move really does re-stale a persisted disposition
 * through the DAG.
 */
import { afterAll, test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { gitAvailable, submoduleRepo } from "./helpers/submoduleRepo.mjs";
import { probeScopeIndexKey, withScopeIndexKey } from "../../src/audit/orchestrator/scopeIndexBaseline.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { computeStaleArtifacts } from "../../src/audit/orchestrator/staleness.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { RepoManifest } from "../../src/audit/types.js";

function git(root: string, args: string[]): void {
  execFileSyncHidden("git", args, { cwd: root, stdio: "ignore" });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-index-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "later.ts"), "export const b = 2;\n");
  git(root, ["add", "src/tracked.ts"]);
  git(root, ["commit", "--quiet", "-m", "init"]);
  return root;
}

function manifest(paths: string[]): RepoManifest {
  return {
    repository: { name: "fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: paths.map((path) => ({
      path,
      language: "typescript",
      size_bytes: 32,
    })),
  };
}

test("probeScopeIndexKey moves when a candidate's tracked state changes with NO content edit", async () => {
  const root = makeRepo();
  try {
    const paths = ["src/tracked.ts", "src/later.ts"];
    const before = await probeScopeIndexKey(root, paths);

    // Index-only move: `later.ts` becomes tracked. Its bytes on disk are
    // untouched, so the manifest's content-only hash cannot see this.
    git(root, ["add", "src/later.ts"]);
    const after = await probeScopeIndexKey(root, paths);

    expect(before, "the probe must return a key for a real repo").toBeTruthy();
    expect(
      before === after,
      `an index-only move must move the key (before=${before}, after=${after})`,
    ).toBe(false);

    // And the un-stage direction moves it back.
    git(root, ["rm", "--cached", "--quiet", "src/later.ts"]);
    expect(await probeScopeIndexKey(root, paths)).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeScopeIndexKey ignores index moves outside the manifest's candidate set", async () => {
  const root = makeRepo();
  try {
    const before = await probeScopeIndexKey(root, ["src/tracked.ts"]);
    // An unrelated file entering the index cannot change this disposition.
    git(root, ["add", "src/later.ts"]);
    expect(
      await probeScopeIndexKey(root, ["src/tracked.ts"]),
      "a path outside the candidate set must not churn the key",
    ).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeScopeIndexKey degrades to null (no index claim) outside a work tree", async () => {
  const bare = mkdtempSync(join(tmpdir(), "scope-index-bare-"));
  try {
    expect(await probeScopeIndexKey(bare, ["src/a.ts"])).toBeNull();
    const m = manifest(["src/a.ts"]);
    expect(
      withScopeIndexKey(m, null),
      "a null probe must leave the manifest untouched, never stamp a sentinel",
    ).toBe(m);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("an index-only move re-stales a persisted file_disposition through the declared DAG", async () => {
  const root = makeRepo();
  try {
    const paths = ["src/tracked.ts", "src/later.ts"];
    const scopeKeyBefore = await probeScopeIndexKey(root, paths);

    const baseManifest = manifest(paths);
    // Built through the production helper, never by hand-stamping the field —
    // so inverting the helper's body reddens this test too.
    const withKey = withScopeIndexKey(baseManifest, scopeKeyBefore)!;
    const buildBundle = (m: RepoManifest): ArtifactBundle => ({
      repo_manifest: m,
      file_disposition: {
        files: m.files.map((file) => ({
          path: file.path,
          status: file.path.includes("later") ? "excluded" : "included",
          reason: file.path.includes("later") ? "untracked" : "Default included source or config artifact.",
        })),
      },
    });

    // First derive: metadata is stamped against the pre-move index key.
    const first = buildBundle(withKey);
    first.artifact_metadata = computeArtifactMetadata(first, undefined, [
      "repo_manifest.json",
      "file_disposition.json",
    ]);
    expect(
      computeStaleArtifacts(first, { emit: false }).has("file_disposition.json"),
      "a freshly-derived disposition is not stale",
    ).toBe(false);

    // Index-only move, then a fresh manifest whose ONLY difference is the index key.
    git(root, ["add", "src/later.ts"]);
    const scopeKeyAfter = await probeScopeIndexKey(root, paths);
    expect(scopeKeyAfter === scopeKeyBefore, "the move must actually move the key").toBe(false);

    const second = buildBundle(withScopeIndexKey(baseManifest, scopeKeyAfter)!);
    // The untracked rule now includes later.ts — the disposition's CONTENT
    // changes, but it was never re-derived: this is the persisted artifact under
    // a moved index, which is exactly the live-run state.
    second.artifact_metadata = computeArtifactMetadata(
      second,
      first.artifact_metadata,
      ["repo_manifest.json"],
    );

    expect(
      computeStaleArtifacts(second, { emit: false }).has("file_disposition.json"),
      "an index-only move must re-stale the persisted disposition via repo_manifest.json",
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The submodule half: the probe must be exactly as recursive as the rule ────
//
// The disposition's untracked rule reads the index with `--recurse-submodules`
// (see `submodule-tracked-corpus.test.ts` for why that flag is load-bearing). A
// probe WITHOUT the flag still returns a stable, moving-looking key — it just
// cannot see a submodule move, so `scope_index_key` never moves, the manifest
// never churns, and a stale `file_disposition.json` is carried forward for a
// repo with first-party submodules. That is the residual exactly: silent,
// and invisible to every test that only ever stages a parent-repo file.

const hasGit = await gitAvailable();
const maybe = hasGit ? test : test.skip;
const submoduleRoots: string[] = [];

afterAll(async () => {
  while (submoduleRoots.length > 0) {
    await rm(submoduleRoots.pop()!, { recursive: true, force: true });
  }
});

maybe(
  "probeScopeIndexKey sees a submodule index move (the recursive index state)",
  async () => {
    const fixture = await submoduleRepo();
    submoduleRoots.push(fixture.root);
    const root = fixture.root;
    // The candidate set names a file INSIDE the submodule — the shape the
    // manifest carries once the disposition has classified it.
    const paths = ["b.ts", "sub/a.ts"];

    const before = await probeScopeIndexKey(root, paths);
    expect(
      before,
      "the probe must return a key for a repo with a first-party submodule",
    ).toBeTruthy();

    // Index-only move INSIDE the submodule: its bytes on disk are untouched, and
    // the parent's own `ls-files` output is byte-identical (only the gitlink
    // line, which is not in the candidate set). Without `--recurse-submodules`
    // this is invisible.
    git(join(root, "sub"), ["rm", "--cached", "--quiet", "a.ts"]);
    const after = await probeScopeIndexKey(root, paths);

    expect(
      before === after,
      `a submodule index move must move the key (before=${before}, after=${after})`,
    ).toBe(false);
  },
  // Stated so a missing git reads as a SKIP, never as a pass.
  30_000,
);
