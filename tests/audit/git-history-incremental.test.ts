/**
 * T5 #12 — incremental structure phase: the git-history mine is REUSED across
 * structure re-derives when neither HEAD nor the in-scope file set moved, and
 * re-mined (fail-safe) on any drift. Reuse is proven with a sentinel prior
 * git_history that a real mine could never produce — if it survives, the reuse
 * branch fired; if it's replaced, the executor re-mined.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import type { RepoManifest } from "../../src/audit/types.js";

const { headCommit } = await import("../../src/shared/git.js");
const { runStructureExecutor } = await import(
  "../../src/audit/orchestrator/structureExecutors.js"
);
const { buildRepoManifestFromFs } = await import(
  "../../src/audit/extractors/fsIntake.js"
);
const {
  canReuseGitHistory,
  deriveGitHistoryScopeKey,
  readGitHistoryBaseline: readGitHistoryBaselineSource,
  withGitHistoryBaseline,
} = await import("../../src/audit/orchestrator/gitHistoryBaseline.js");

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(r.status, `git ${args.join(" ")} failed: ${r.stderr}`).toBe(0);
  return r;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-incr-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "a@example.com"]);
  git(dir, ["config", "user.name", "Author A"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function commit(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
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

function repoManifestFor(...paths: string[]): RepoManifest {
  return {
    repository: { name: "fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: paths.map((path) => ({
      path,
      language: "TypeScript",
      size_bytes: 1,
    })),
  };
}

function requireHead(root: string): string {
  const head = headCommit(root);
  if (head === null) {
    throw new Error(`fixture repository at ${root} has no HEAD`);
  }
  return head;
}

function readGitHistoryBaseline(
  metadata: Parameters<typeof readGitHistoryBaselineSource>[0],
): NonNullable<ReturnType<typeof readGitHistoryBaselineSource>> {
  const baseline = readGitHistoryBaselineSource(metadata);
  if (baseline === undefined) {
    throw new Error("git-history baseline was not recorded");
  }
  return baseline;
}

// ── Unit: pure helpers ────────────────────────────────────────────────────────

test("canReuseGitHistory: reuse iff head + scope both match AND a prior artifact exists", () => {
  const base = { head: "abc", scope_key: "K" };
  const ok = (
    o: Partial<Parameters<typeof canReuseGitHistory>[0]> = {},
  ) =>
    canReuseGitHistory({
      head: "abc",
      scopeKey: "K",
      priorBaseline: base,
      hasPriorArtifact: true,
      ...o,
    });
  expect(ok()).toBe(true);
  expect(ok({ head: "def" }), "moved HEAD ⇒ re-mine").toBe(false);
  expect(ok({ scopeKey: "K2" }), "moved scope ⇒ re-mine").toBe(false);
  expect(ok({ head: null }), "no HEAD (git unavailable) ⇒ re-mine").toBe(false);
  expect(ok({ priorBaseline: undefined }), "no baseline ⇒ re-mine").toBe(false);
  expect(ok({ hasPriorArtifact: false }), "no prior artifact ⇒ re-mine").toBe(false);
});

test("deriveGitHistoryScopeKey: ordering-invariant, moves on file-set change", () => {
  const a = deriveGitHistoryScopeKey(repoManifestFor("a.ts", "b.ts"));
  const reordered = deriveGitHistoryScopeKey(repoManifestFor("b.ts", "a.ts"));
  const changed = deriveGitHistoryScopeKey(repoManifestFor("a.ts", "c.ts"));
  expect(a, "manifest ordering is non-load-bearing").toBe(reordered);
  expect(a, "a changed in-scope set moves the key").not.toBe(changed);
});

test("withGitHistoryBaseline: stamps F1 version, preserves sibling baselines", () => {
  const out = withGitHistoryBaseline(
    { metadata_schema_version: 1, artifacts: {}, coverage_element_baselines: { "x.ts": "k" } },
    { head: "abc", scope_key: "K" },
  );
  expect(out.git_history_baseline).toEqual({ head: "abc", scope_key: "K" });
  expect(out.coverage_element_baselines, "siblings untouched").toEqual({ "x.ts": "k" });
  expect(out.metadata_schema_version).toBe(1);
});

// ── Integration: executor reuse / re-mine ─────────────────────────────────────

test("structure executor records a git-history baseline (head + scope_key)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const result = await runStructureExecutor({ repo_manifest: repoManifest }, dir);
    const baseline = readGitHistoryBaseline(result.updated.artifact_metadata);
    expect(baseline, "baseline recorded").toBeTruthy();
    expect(baseline.head).toBe(headCommit(dir));
    expect(baseline.scope_key).toBe(deriveGitHistoryScopeKey(repoManifest));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structure executor REUSES the prior mine when HEAD + scope are unchanged", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const head = requireHead(dir);
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
    expect(result.updated.git_history, "unchanged HEAD + scope ⇒ prior mine reused verbatim (no re-mine)").toEqual(SENTINEL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structure executor RE-MINES when HEAD moved (new commit)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const staleHead = requireHead(dir);
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
    expect(result.updated.git_history, "moved HEAD ⇒ re-mined, sentinel discarded").not.toEqual(SENTINEL);
    // And the refreshed baseline tracks the new HEAD.
    expect(readGitHistoryBaseline(result.updated.artifact_metadata).head).toBe(headCommit(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structure executor RE-MINES when the in-scope file set changed (same HEAD)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "export const a=1;", "b.ts": "export const b=1;" });
    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const head = requireHead(dir);
    const bundle = {
      repo_manifest: repoManifest,
      git_history: SENTINEL,
      artifact_metadata: withGitHistoryBaseline(
        { metadata_schema_version: 1, artifacts: {} },
        // Baseline scope key from a DIFFERENT file set ⇒ scope drift.
        { head, scope_key: deriveGitHistoryScopeKey(repoManifestFor("only.ts")) },
      ),
    };
    const result = await runStructureExecutor(bundle, dir);
    expect(result.updated.git_history, "scope drift ⇒ re-mined even though HEAD is unchanged").not.toEqual(SENTINEL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
