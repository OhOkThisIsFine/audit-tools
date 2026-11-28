import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashContent } from "audit-tools/shared";
import { computeArtifactMetadata } from "../dist/audit/orchestrator/artifactMetadata.js";
import {
  probeScopeIndexKey,
  probeScopeIndexKeyCached,
  withScopeIndexKey,
} from "../dist/audit/orchestrator/scopeIndexBaseline.js";

function git(root, ...args) {
  execFileSync("git", args, { cwd: root });
}

async function fixture(t, paths) {
  const root = await mkdtemp(join(tmpdir(), "audit-scope-path-framing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "--template=");
  for (const path of paths) await writeFile(join(root, path), "fixture\n");
  if (paths.length) git(root, "add", "--", ...paths);
  return root;
}

test("scope index refreshes a legacy manifest once and ignores unrelated staged files", async (t) => {
  const root = await fixture(t, ["alpha", "beta"]);
  const paths = ["./beta", "alpha", "untracked"];
  const legacy = {
    files: paths.map((path) => ({ path })),
    scope_index_key: hashContent("alpha\nbeta"),
  };
  const key = await probeScopeIndexKey(root, paths);
  assert.equal(key, hashContent(JSON.stringify(["alpha", "beta"])));
  assert.notEqual(key, legacy.scope_index_key);

  const artifact = "repo_manifest.json";
  const previous = computeArtifactMetadata({ repo_manifest: legacy }, undefined, [artifact]);
  const persisted = JSON.parse(JSON.stringify(withScopeIndexKey(legacy, key)));
  const refreshed = computeArtifactMetadata({ repo_manifest: persisted }, previous, [artifact]);
  assert.equal(refreshed.artifacts[artifact].revision, previous.artifacts[artifact].revision + 1);

  await writeFile(join(root, "unrelated"), "fixture\n");
  git(root, "add", "--", "unrelated");
  const stableKey = await probeScopeIndexKey(root, [...paths].reverse());
  assert.equal(stableKey, key);
  assert.equal(withScopeIndexKey(persisted, stableKey), persisted);
  const stable = computeArtifactMetadata({ repo_manifest: persisted }, refreshed, [artifact]);
  assert.deepEqual(stable.artifacts[artifact], refreshed.artifacts[artifact]);
});

test("fold memo reuses identical inputs but separates newline paths and roots", async (t) => {
  const root = await fixture(t, ["alpha", "beta"]);
  const other = await fixture(t, ["alpha"]);
  const memo = {};
  const separatePaths = ["alpha", "beta"];
  const onePath = ["alpha\nbeta"]; // Literal newline fixture stays in memory on Windows.
  const before = await probeScopeIndexKeyCached(memo, root, separatePaths);
  assert.notEqual(before, null);
  const separatePathsMemoKey = memo.key;

  // Change the index outside the fold to distinguish a memo hit from a fresh probe.
  git(root, "rm", "--cached", "-f", "--", "alpha", "beta");
  const empty = await probeScopeIndexKey(root, separatePaths);
  assert.notEqual(before, empty);
  assert.equal(await probeScopeIndexKeyCached(memo, root, [...separatePaths]), before);
  assert.equal(await probeScopeIndexKeyCached(memo, root, onePath), empty);
  assert.notEqual(memo.key, separatePathsMemoKey);

  assert.equal(await probeScopeIndexKeyCached(memo, root, separatePaths), empty);
  const differentRoot = await probeScopeIndexKey(other, separatePaths);
  assert.notEqual(differentRoot, empty);
  assert.equal(await probeScopeIndexKeyCached(memo, other, separatePaths), differentRoot);
});
