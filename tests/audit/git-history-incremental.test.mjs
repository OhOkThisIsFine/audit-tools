/**
 * T5 #12 — incremental structure phase: the git-history mine is REUSED across
 * structure re-derives when neither HEAD nor the in-scope file set moved, and
 * re-mined (fail-safe) on any drift. Reuse is proven with a sentinel prior
 * git_history that a real mine could never produce — if it survives, the reuse
 * branch fired; if it's replaced, the executor re-mined.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const { headCommit } = await import("../../src/shared/git.ts");
const { runStructureExecutor } = await import(
  "../../src/audit/orchestrator/structureExecutors.ts"
);
const { buildRepoManifestFromFs } = await import(
  "../../src/audit/extractors/fsIntake.ts"
);
const {
  canReuseGitHistory,
  deriveGitHistoryScopeKey,
  readGitHistoryBaseline,
  withGitHistoryBaseline,
} = await import("../../src/audit/orchestrator/gitHistoryBaseline.ts");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "git-incr-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "a@example.com"]);
  git(dir, ["config", "user.name", "Author A"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function commit(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content, "utf8");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "c"]);
}

// A sentinel git_history a real mine could never produce (the repo has no such
// pair), so its survival proves the reuse branch fired.
const SENTINEL = {
  co_change: [{ a: "sentinel-a.ts", b: "sentinel-b.ts", commits: 99 }],
  churn: [{ path: "sentinel-a.ts", commits: 99 }],
  authorship: [{ path: "sentinel-a.ts", authors: 9 }],
};

// ── Unit: pure helpers ────────────────────────────────────────────────────────

test("canReuseGitHistory: reuse iff head + scope both match AND a prior artifact exists", () => {
  const base = { head: "abc", scope_key: "K" };
  const ok = (o) =>
    canReuseGitHistory({
      head: "abc",
      scopeKey: "K",
      priorBaseline: base,
      hasPriorArtifact: true,
      ...o,
    });
  assert.equal(ok(), true);
  assert.equal(ok({ head: "def" }), false, "moved HEAD ⇒ re-mine");
  assert.equal(ok({ scopeKey: "K2" }), false, "moved scope ⇒ re-mine");
  assert.equal(ok({ head: null }), false, "no HEAD (git unavailable) ⇒ re-mine");
  assert.equal(ok({ priorBaseline: undefined }), false, "no baseline ⇒ re-mine");
  assert.equal(ok({ hasPriorArtifact: false }), false, "no prior artifact ⇒ re-mine");
});

test("deriveGitHistoryScopeKey: ordering-invariant, moves on file-set change", () => {
  const a = deriveGitHistoryScopeKey({ files: [{ path: "a.ts" }, { path: "b.ts" }] });
  const reordered = deriveGitHistoryScopeKey({ files: [{ path: "b.ts" }, { path: "a.ts" }] });
  const changed = deriveGitHistoryScopeKey({ files: [{ path: "a.ts" }, { path: "c.ts" }] });
  assert.equal(a, reordered, "manifest ordering is non-load-bearing");
  assert.notEqual(a, changed, "a changed in-scope set moves the key");
});

test("withGitHistoryBaseline: stamps F1 version, preserves sibling baselines", () => {
  const out = withGitHistoryBaseline(
    { metadata_schema_version: 1, artifacts: {}, coverage_element_baselines: { "x.ts": "k" } },
    { head: "abc", scope_key: "K" },
  );
  assert.deepEqual(out.git_history_baseline, { head: "abc", scope_key: "K" });
  assert.deepEqual(out.coverage_element_baselines, { "x.ts": "k" }, "siblings untouched");
  assert.equal(out.metadata_schema_version, 1);
});

// ── Integration: executor reuse / re-mine ─────────────────────────────────────

test("structure executor records a git-history baseline (head + scope_key)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const result = await runStructureExecutor({ repo_manifest: repoManifest }, dir);
    const baseline = readGitHistoryBaseline(result.updated.artifact_metadata);
    assert.ok(baseline, "baseline recorded");
    assert.equal(baseline.head, headCommit(dir));
    assert.equal(baseline.scope_key, deriveGitHistoryScopeKey(repoManifest));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structure executor REUSES the prior mine when HEAD + scope are unchanged", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const head = headCommit(dir);
    // Bundle carries a sentinel prior git_history + a baseline matching live state.
    const bundle = {
      repo_manifest: repoManifest,
      git_history: SENTINEL,
      artifact_metadata: withGitHistoryBaseline(
        { metadata_schema_version: 1, artifacts: {} },
        { head, scope_key: deriveGitHistoryScopeKey(repoManifest) },
      ),
    };
    const result = await runStructureExecutor(bundle, dir);
    assert.deepEqual(
      result.updated.git_history,
      SENTINEL,
      "unchanged HEAD + scope ⇒ prior mine reused verbatim (no re-mine)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structure executor RE-MINES when HEAD moved (new commit)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const staleHead = headCommit(dir);
    // A second commit moves HEAD, so the carried baseline is stale.
    await commit(dir, { "a.ts": "export const a=2;", "b.ts": "export const b=2;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const bundle = {
      repo_manifest: repoManifest,
      git_history: SENTINEL,
      artifact_metadata: withGitHistoryBaseline(
        { metadata_schema_version: 1, artifacts: {} },
        { head: staleHead, scope_key: deriveGitHistoryScopeKey(repoManifest) },
      ),
    };
    const result = await runStructureExecutor(bundle, dir);
    assert.notDeepEqual(
      result.updated.git_history,
      SENTINEL,
      "moved HEAD ⇒ re-mined, sentinel discarded",
    );
    // And the refreshed baseline tracks the new HEAD.
    assert.equal(
      readGitHistoryBaseline(result.updated.artifact_metadata).head,
      headCommit(dir),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structure executor RE-MINES when the in-scope file set changed (same HEAD)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const head = headCommit(dir);
    const bundle = {
      repo_manifest: repoManifest,
      git_history: SENTINEL,
      artifact_metadata: withGitHistoryBaseline(
        { metadata_schema_version: 1, artifacts: {} },
        // Baseline scope key from a DIFFERENT file set ⇒ scope drift.
        { head, scope_key: deriveGitHistoryScopeKey({ files: [{ path: "only.ts" }] }) },
      ),
    };
    const result = await runStructureExecutor(bundle, dir);
    assert.notDeepEqual(
      result.updated.git_history,
      SENTINEL,
      "scope drift ⇒ re-mined even though HEAD is unchanged",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
