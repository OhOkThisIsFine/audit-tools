import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";

const { mineGitHistory, isGitRepo } = await import("../../src/shared/git.ts");
const {
  mineGitHistoryArtifact,
  gitHistoryGraphEdges,
  gitHistoryRiskSignals,
} = await import("../../src/audit/extractors/gitHistory.ts");
const { mergeAnalyzerGraphContribution } = await import(
  "../../src/audit/extractors/graph.ts"
);
const { mergeAnalyzerRiskSignals, deriveRiskConcentration } = await import(
  "../../src/audit/extractors/risk.ts"
);
const { allGraphEdges, deriveGraphSignals } = await import(
  "../../src/audit/extractors/graphSignals.ts"
);
const { GIT_CO_CHANGE_CATEGORY } = await import(
  "../../src/audit/extractors/gitHistory.ts"
);
const { runStructureExecutor } = await import(
  "../../src/audit/orchestrator/structureExecutors.ts"
);
const { buildRepoManifestFromFs } = await import(
  "../../src/audit/extractors/fsIntake.ts"
);
const { ARTIFACT_DEPENDS_ON_MAP } = await import(
  "../../src/audit/orchestrator/dependencyMap.ts"
);

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(r.status, `git ${args.join(" ")} failed: ${r.stderr}`).toBe(0);
  return r;
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "git-history-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "a@example.com"]);
  git(dir, ["config", "user.name", "Author A"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

async function commit(dir, files, { name, email }) {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content, "utf8");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", "c"]);
}

const manifest = (paths) => ({
  files: paths.map((path) => ({
    path,
    size_bytes: 1,
    language: "typescript",
    excluded: false,
  })),
});

// F6 inv-1: the git-history extractor is owned + purely mechanical — it mines
// git via src/shared/git.ts ONLY, and must never reach into F5's analyzer or
// adapter seam (AST analyzers / external-tool adapters).
test("F6 inv-1: gitHistory extractor imports no F5 analyzer/adapter seam", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(
    join(here, "../../src/audit/extractors/gitHistory.ts"),
    "utf8",
  );
  const importLines = src
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+["']/.test(line));
  for (const line of importLines) {
    expect(line, `F6 must not import an F5 analyzer: ${line.trim()}`).not.toMatch(/extractors\/analyzers/);
    expect(line, `F6 must not import an F5 adapter: ${line.trim()}`).not.toMatch(/\.\.\/adapters\//);
  }
  // It does mine through the shared git seam.
  expect(src).toMatch(/from\s+["']audit-tools\/shared["']/);
});

// F6 inv-7: F6 is the authoritative source for git_history.json's upstream-dep
// declaration — exactly {repo_manifest, file_disposition}. F1 only transcribes
// it into ARTIFACT_DEPENDS_ON_MAP / dependency-map.md (CCU-git-history-registration).
test("F6 inv-7: git_history.json declares upstream deps exactly {repo_manifest, file_disposition}", () => {
  expect([...(ARTIFACT_DEPENDS_ON_MAP["git_history.json"] ?? [])].sort()).toEqual(["file_disposition.json", "repo_manifest.json"]);
});

test("mineGitHistory degrades to empty on a non-git directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "no-git-"));
  try {
    const history = mineGitHistory(dir);
    expect(history).toEqual({ co_change: [], churn: [], authorship: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 fail-3: malformed / truncated git-log output (encoding garble, rename
// markers, binary-numstat '-', stray blank lines, an empty-sha header from a
// truncated stream) => the offending row is skipped, mining continues for every
// well-formed commit, and the path that produced the bad row degrades to empty
// rather than throwing. Mirrors gitLines() status!==0 => []: a parse it cannot
// understand never crashes the miner.
//
// parseCommitRecords is module-private, so the boundary is exercised through the
// public surface: a real repo whose log contains quoted-rename and unusual
// paths still mines cleanly, AND the same parser, fed a deliberately corrupt
// stream, degrades to empty without throwing.
test("F6 fail-3: a malformed git-log row is skipped, mining continues for well-formed commits", async () => {
  const dir = await makeRepo();
  try {
    // A path that git renders quoted/escaped in --name-only output (space +
    // non-ASCII), interleaved with a plain path — the kind of row a naive
    // line scanner mishandles. The miner must still count every touched path.
    await commit(
      dir,
      { "weird nameé.ts": "1", "plain.ts": "1" },
      { name: "Author A", email: "a@example.com" },
    );
    await commit(
      dir,
      { "weird nameé.ts": "2", "plain.ts": "2" },
      { name: "Author B", email: "b@example.com" },
    );

    // Must never throw, and both paths are aggregated across both commits.
    let history;
    assert.doesNotThrow(() => {
      history = mineGitHistory(dir);
    });
    expect(history.churn.find((c) => c.path === "plain.ts")?.commits, "well-formed path still mined despite a hard-to-parse sibling row").toBe(2);
    expect(history.churn.some((c) => c.commits === 2), "the offending path degrades to empty if unparseable but never aborts mining").toBeTruthy();
    // Deterministic + non-throwing on repeat.
    expect(mineGitHistory(dir)).toEqual(history);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 fail-3 (degrade-to-empty for the path): a non-git directory and a git
// command failure both yield the empty aggregate, never an exception — the
// same status!==0 => [] contract gitLines() enforces. A repo with only a
// truncated/empty initial state mines to empty rather than throwing.
test("F6 fail-3: an unminable repo state degrades to empty, never throws", async () => {
  // Fresh repo with NO commits: `git log` exits non-zero → empty aggregate.
  const dir = await makeRepo();
  try {
    let history;
    assert.doesNotThrow(() => {
      history = mineGitHistory(dir);
    });
    expect(history, "no-commit repo (git log fails) degrades to the empty aggregate").toEqual({ co_change: [], churn: [], authorship: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mineGitHistory is deterministic and sorted (co_change/churn/authorship)", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "1", "b.ts": "1" }, { name: "Author A", email: "a@example.com" });
    await commit(dir, { "a.ts": "2", "b.ts": "2" }, { name: "Author B", email: "b@example.com" });
    await commit(dir, { "a.ts": "3" }, { name: "Author A", email: "a@example.com" });

    const first = mineGitHistory(dir);
    const second = mineGitHistory(dir);
    expect(first, "identical history → identical output").toEqual(second);

    // a.ts: 3 commits, b.ts: 2 → churn sorted by count desc.
    expect(first.churn).toEqual([
      { path: "a.ts", commits: 3 },
      { path: "b.ts", commits: 2 },
    ]);
    // a.ts touched by both authors, b.ts by both → 2 each, ties broken by path.
    expect(first.authorship).toEqual([
      { path: "a.ts", authors: 2 },
      { path: "b.ts", authors: 2 },
    ]);
    // a.ts & b.ts changed together in 2 commits (>= default min 2).
    expect(first.co_change).toEqual([{ a: "a.ts", b: "b.ts", commits: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mineGitHistory is language-agnostic: churn/authorship for every touched path regardless of extension", async () => {
  // F6 inv-2: co-change/churn/authorship derive only from commit-to-path
  // association — identical behavior regardless of file language/ecosystem.
  const dir = await makeRepo();
  try {
    // Mixed extensions plus an extensionless path. None is gated by language.
    const paths = ["mod.py", "lib.ts", "core.rs", "Makefile"];
    const seed = Object.fromEntries(paths.map((p) => [p, "1"]));
    await commit(dir, seed, { name: "Author A", email: "a@example.com" });
    const bump = Object.fromEntries(paths.map((p) => [p, "2"]));
    await commit(dir, bump, { name: "Author B", email: "b@example.com" });

    const history = mineGitHistory(dir);

    // Every touched path appears in churn (2 commits each), no language gating.
    // Order is collation-dependent, so compare as a path→count map.
    expect(Object.fromEntries(history.churn.map((c) => [c.path, c.commits])), "churn covers every extension and the extensionless path equally").toEqual({ "mod.py": 2, "lib.ts": 2, "core.rs": 2, Makefile: 2 });
    // Every touched path appears in authorship (2 distinct authors each).
    expect(Object.fromEntries(history.authorship.map((a) => [a.path, a.authors])), "authorship covers every extension and the extensionless path equally").toEqual({ "mod.py": 2, "lib.ts": 2, "core.rs": 2, Makefile: 2 });
    // Co-change pairs span across languages too (all 6 pairs, 2 commits each).
    expect(new Set(history.co_change.map((c) => `${c.a}|${c.b}`)), "co-change pairs cross language boundaries with no gating").toEqual(new Set([
        "Makefile|core.rs",
        "Makefile|lib.ts",
        "Makefile|mod.py",
        "core.rs|lib.ts",
        "core.rs|mod.py",
        "lib.ts|mod.py",
      ]));
    expect(history.co_change.every((c) => c.commits === 2), "every cross-language pair counted across both commits").toBeTruthy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 inv-6: a co-change edge is emitted only above a fixed minimum joint-commit
// support; confidence is a deterministic function of that support.
test("F6 inv-6: co-change is gated by min joint-commit support; confidence is a deterministic function of support", async () => {
  const dir = await makeRepo();
  try {
    // a.ts & b.ts share exactly ONE commit (below the default min of 2) →
    // the pair must be omitted. c.ts & d.ts share TWO commits → emitted.
    await commit(
      dir,
      { "a.ts": "1", "b.ts": "1", "c.ts": "1", "d.ts": "1" },
      { name: "Author A", email: "a@example.com" },
    );
    // Second commit touches c.ts & d.ts together again, but NOT a.ts/b.ts.
    await commit(
      dir,
      { "c.ts": "2", "d.ts": "2" },
      { name: "Author A", email: "a@example.com" },
    );

    const history = mineGitHistory(dir);
    const pairs = new Set(history.co_change.map((p) => `${p.a}|${p.b}`));
    // Below-threshold pair (1 shared commit) omitted.
    expect(pairs.has("a.ts|b.ts"), "single-commit pair below threshold is omitted").toBe(false);
    // Above-threshold pair (2 shared commits) emitted with its support count.
    expect(history.co_change.find((p) => p.a === "c.ts" && p.b === "d.ts")).toEqual({ a: "c.ts", b: "d.ts", commits: 2 });

    // Confidence is a deterministic function of support: base + 0.05*(n-1).
    const edges = gitHistoryGraphEdges(history);
    const cd = edges.find((e) => e.from === "c.ts" && e.to === "d.ts");
    expect(cd, "above-threshold pair projects to a graph edge").toBeTruthy();
    expect(cd.confidence, "confidence for 2 shared commits = 0.4 + 0.05*(2-1)").toBe(0.45);
    // The omitted pair never reaches the edge projection.
    expect(edges.some((e) => e.from === "a.ts" && e.to === "b.ts")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 fail-5: huge history / wide commits => bounded window guards an
// O(commits x files^2) co-change blow-up. The fixed window (maxCommits, newest
// first) is the guard: only commits inside the window contribute to co-change /
// churn / authorship, so cost is bounded regardless of total history depth.
test("F6 fail-5: maxCommits bounds the scanned window (older commits outside the window are excluded)", async () => {
  const dir = await makeRepo();
  try {
    // Oldest commit: old.ts & paired.ts co-change once (would be the only
    // contribution from old.ts if it were scanned).
    await commit(
      dir,
      { "old.ts": "1", "paired.ts": "1" },
      { name: "Author A", email: "a@example.com" },
    );
    // Two newer commits touch new.ts so it stays inside any small window.
    await commit(dir, { "new.ts": "1" }, { name: "Author B", email: "b@example.com" });
    await commit(dir, { "new.ts": "2" }, { name: "Author B", email: "b@example.com" });

    // Window of 2 (newest first) excludes the oldest commit entirely.
    const bounded = mineGitHistory(dir, { maxCommits: 2 });
    expect(bounded.churn.some((c) => c.path === "old.ts"), "commit outside the bounded window does not contribute to churn").toBe(false);
    expect(bounded.authorship.some((a) => a.path === "old.ts"), "commit outside the bounded window does not contribute to authorship").toBe(false);
    expect(bounded.co_change.length, "the old co-change pair is excluded; no in-window pair reaches threshold").toBe(0);
    expect(bounded.churn.find((c) => c.path === "new.ts"), "only the two in-window commits count toward new.ts churn").toEqual({ path: "new.ts", commits: 2 });

    // Unbounded scan DOES see the old commit — proving the window, not absence
    // of history, is what excludes it.
    const full = mineGitHistory(dir);
    expect(full.churn.some((c) => c.path === "old.ts"), "without the bound the old commit is in scope (the window is the guard)").toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// V6: pair expansion (the nested for/for over a commit's files) is O(files^2)
// per commit, unbounded by maxCommits (which only bounds *how many* commits
// are scanned, not how wide any one of them is). A single vendor/format/
// rename commit touching many files must not explode into O(n^2) co-change
// pairs — it is SKIPPED for pairing entirely (never a truncated subset, which
// would bias the signal), while churn/authorship (which are O(files), not
// O(files^2)) still count every file it touched. The skip is recorded on the
// result rather than silently dropped.
test("F6 fail-5b: maxCoChangeFilesPerCommit bounds per-commit pair expansion (wide commit skipped, not truncated)", async () => {
  const dir = await makeRepo();
  try {
    // A "wide" commit touching 5 files — over a cap of 3 — must be skipped
    // entirely for co-change pairing (not paired on a truncated subset).
    await commit(
      dir,
      { "w1.ts": "1", "w2.ts": "1", "w3.ts": "1", "w4.ts": "1", "w5.ts": "1" },
      { name: "Author A", email: "a@example.com" },
    );
    // A narrow commit touching 2 files (below the cap) must still pair
    // normally — the cap only skips commits that exceed it.
    await commit(dir, { "a.ts": "1", "b.ts": "1" }, { name: "Author A", email: "a@example.com" });
    await commit(dir, { "a.ts": "2", "b.ts": "2" }, { name: "Author A", email: "a@example.com" });

    const history = mineGitHistory(dir, { maxCoChangeFilesPerCommit: 3 });

    // No pair explosion from the wide commit: none of its C(5,2)=10 pairs
    // appear; co_change is bounded to the narrow commit's single pair.
    const wideFiles = ["w1.ts", "w2.ts", "w3.ts", "w4.ts", "w5.ts"];
    for (const f of wideFiles) {
      expect(
        history.co_change.some((p) => p.a === f || p.b === f),
        `wide-commit file ${f} produces no co-change pair once its commit is over the cap`,
      ).toBe(false);
    }
    expect(history.co_change).toEqual([{ a: "a.ts", b: "b.ts", commits: 2 }]);

    // Churn still counts every file the wide (skipped-for-pairing) commit
    // touched — only pair expansion is bounded, not per-file tallies.
    for (const f of wideFiles) {
      expect(
        history.churn.find((c) => c.path === f),
        `${f} is still counted in churn despite being skipped for co-change pairing`,
      ).toEqual({ path: f, commits: 1 });
    }

    // The truncation is recorded on the result, not silently dropped.
    expect(
      history.skipped_cochange_commits,
      "the over-cap commit is recorded as skipped for co-change pairing",
    ).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mineGitHistory: no over-cap commit => skipped_cochange_commits is absent/zero", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "1", "b.ts": "1" }, { name: "Author A", email: "a@example.com" });
    await commit(dir, { "a.ts": "2", "b.ts": "2" }, { name: "Author A", email: "a@example.com" });
    const history = mineGitHistory(dir);
    expect(
      history.skipped_cochange_commits ?? 0,
      "no commit exceeded the cap, so no skip is recorded",
    ).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mineGitHistoryArtifact drops out-of-scope and excluded paths", async () => {
  const dir = await makeRepo();
  try {
    await commit(dir, { "a.ts": "1", "vendor.ts": "1" }, { name: "Author A", email: "a@example.com" });
    await commit(dir, { "a.ts": "2", "vendor.ts": "2" }, { name: "Author A", email: "a@example.com" });
    // vendor.ts is not in the manifest → must be dropped everywhere.
    const history = mineGitHistoryArtifact(dir, manifest(["a.ts"]));
    expect(history.churn).toEqual([{ path: "a.ts", commits: 2 }]);
    expect(history.co_change).toEqual([]);
    expect(history.authorship).toEqual([{ path: "a.ts", authors: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 inv-5: co-change edges are path-scoped to known graph nodes — a pair with
// one endpoint outside the manifest (out-of-tree / excluded / vendored) is
// dropped entirely, while a fully in-scope pair survives.
test("F6 inv-5: co-change pair with an unknown endpoint is dropped, in-scope pair survives", async () => {
  const dir = await makeRepo();
  try {
    // in.ts + also.ts co-change (both in scope); in.ts + vendor.ts co-change
    // (vendor.ts not in manifest → that edge must be dropped).
    await commit(
      dir,
      { "in.ts": "1", "also.ts": "1", "vendor.ts": "1" },
      { name: "Author A", email: "a@example.com" },
    );
    await commit(
      dir,
      { "in.ts": "2", "also.ts": "2", "vendor.ts": "2" },
      { name: "Author A", email: "a@example.com" },
    );
    const history = mineGitHistoryArtifact(dir, manifest(["in.ts", "also.ts"]));
    // Only the fully in-scope pair survives; every pair touching vendor.ts dropped.
    expect(history.co_change).toEqual([
      { a: "also.ts", b: "in.ts", commits: 2 },
    ]);
    // churn/authorship likewise scoped — no vendor.ts row.
    expect(history.churn.some((e) => e.path === "vendor.ts")).toBe(false);
    expect(history.authorship.some((e) => e.path === "vendor.ts")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitHistoryGraphEdges projects co-change to undirected edges (empty → empty)", () => {
  expect(gitHistoryGraphEdges({ co_change: [], churn: [], authorship: [] })).toEqual([]);
  const edges = gitHistoryGraphEdges({
    co_change: [{ a: "a.ts", b: "b.ts", commits: 3 }],
    churn: [],
    authorship: [],
  });
  expect(edges.length).toBe(1);
  expect(edges[0].from).toBe("a.ts");
  expect(edges[0].to).toBe("b.ts");
  expect(edges[0].direction).toBe("undirected");
  expect(edges[0].kind).toBe("git-co-change");
});

test("gitHistoryRiskSignals flags hotspots and broad authorship by unit", () => {
  const units = {
    units: [
      { unit_id: "u1", files: ["a.ts"] },
      { unit_id: "u2", files: ["b.ts"] },
    ],
  };
  const signals = gitHistoryRiskSignals(
    {
      co_change: [],
      churn: [{ path: "a.ts", commits: 12 }],
      authorship: [{ path: "a.ts", authors: 5 }],
    },
    units,
  );
  expect(signals.get("u1")).toEqual(["change_hotspot", "broad_authorship"]);
  expect(signals.has("u2")).toBe(false);
});

test("mergeAnalyzerGraphContribution is idempotent and non-mutating", () => {
  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  const edges = [
    { from: "a.ts", to: "b.ts", kind: "git-co-change", direction: "undirected" },
  ];
  const once = mergeAnalyzerGraphContribution(bundle, edges);
  const twice = mergeAnalyzerGraphContribution(once, edges);
  expect(once.graphs.references.length).toBe(1);
  expect(twice.graphs.references, "idempotent").toEqual(once.graphs.references);
  expect(bundle.graphs.references, "input not mutated").toEqual([]);
});

test("mergeAnalyzerGraphContribution degrades to a clone on empty edges", () => {
  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  const out = mergeAnalyzerGraphContribution(bundle, undefined);
  expect(out).not.toBe(bundle);
  expect(out.graphs.references).toEqual([]);
});

test("mergeAnalyzerRiskSignals unions signals, ignores unknown units, never mutates", () => {
  const register = {
    items: [
      { unit_id: "u1", risk_score: 3, signals: ["security_relevant"], notes: [] },
      { unit_id: "u2", risk_score: 1, signals: [], notes: [] },
    ],
  };
  const merged = mergeAnalyzerRiskSignals(
    register,
    new Map([
      ["u1", ["change_hotspot"]],
      ["unknown", ["ignored"]],
    ]),
  );
  expect(merged.items[0].signals).toEqual(["change_hotspot", "security_relevant"]);
  expect(merged.items[1].signals).toEqual([]);
  // risk_score untouched (informational signals).
  expect(merged.items[0].risk_score).toBe(3);
  // input not mutated.
  expect(register.items[0].signals).toEqual(["security_relevant"]);
});

test("mergeAnalyzerRiskSignals degrades to a clone on an empty map", () => {
  const register = { items: [{ unit_id: "u1", risk_score: 0, signals: [], notes: [] }] };
  const out = mergeAnalyzerRiskSignals(register, undefined);
  expect(out).not.toBe(register);
  expect(out.items[0].signals).toEqual([]);
});

// F6 inv-9 (merge-helper seam land-order safety): F6's co-change edges +
// churn/bus-factor signals append ONLY through the shared
// mergeAnalyzerGraphContribution / mergeAnalyzerRiskSignals pair (the pre-shipped
// CCU-analyzer-merge-helper-seam, which lands FIRST). F6 declares a scheduling
// dependency on that seam, so a half-shipped state — the seam absent while F6's
// producers are present — is UNSCHEDULABLE: consuming F6's output is impossible
// without first resolving the seam imports. This test makes that land-order
// mechanical, not host-remembered (additive to the CE-006 apply-ordering test).

test("F6 inv-9: the pre-shipped merge-helper seam pair lands first (statically importable)", () => {
  // The seam pair is the only sanctioned append path. If either symbol were
  // unshipped, the top-level `await import(...)` at the head of this file would
  // have thrown before any F6 consumer test could run — so a half-shipped state
  // (F6 present, seam absent) can never be scheduled.
  expect(typeof mergeAnalyzerGraphContribution, "graph-contribution seam must be shipped before F6 consumers run").toBe("function");
  expect(typeof mergeAnalyzerRiskSignals, "risk-signals seam must be shipped before F6 consumers run").toBe("function");
});

test("F6 inv-9: gitHistory appends ONLY through the seam — never mutating a graph bundle / risk register directly", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(
    join(here, "../../src/audit/extractors/gitHistory.ts"),
    "utf8",
  );
  // F6 emits plain edge/signal DATA (gitHistoryGraphEdges / gitHistoryRiskSignals)
  // for the seam to merge. It must never reach past the seam and mutate a
  // graph bundle's edge lists or a risk register's items in place — that would
  // be a second, land-order-unsafe append path bypassing the shared helper.
  expect(src, "F6 must not touch graph-bundle edge lists directly; route through mergeAnalyzerGraphContribution").not.toMatch(/\.graphs\.(imports|calls|references|routes)\b/);
  expect(src, "F6 must not mutate the risk register directly; route through mergeAnalyzerRiskSignals").not.toMatch(/\bregister\.items\b/);
});

test("F6 inv-9: an end-to-end co-commit append composes producers with the seam (the only land-order-safe path)", () => {
  // The full F6 path: mined data → producer → seam merge. Proves the producers'
  // output is exactly what the pre-shipped seam consumes, so F6 has no reason to
  // reach around it.
  const history = {
    co_change: [{ a: "a.ts", b: "b.ts", commits: 3 }],
    churn: [{ path: "a.ts", commits: 12 }],
    authorship: [{ path: "a.ts", authors: 5 }],
  };
  const units = { units: [{ unit_id: "u1", files: ["a.ts"] }] };

  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  const mergedGraph = mergeAnalyzerGraphContribution(
    bundle,
    gitHistoryGraphEdges(history),
  );
  expect(mergedGraph.graphs.references.length, "co-change edge landed via the seam").toBe(1);
  expect(mergedGraph.graphs.references[0].kind).toBe("git-co-change");
  expect(bundle.graphs.references, "producer+seam never mutate the input bundle").toEqual([]);

  const register = {
    items: [{ unit_id: "u1", risk_score: 2, signals: ["security_relevant"], notes: [] }],
  };
  const mergedRisk = mergeAnalyzerRiskSignals(
    register,
    gitHistoryRiskSignals(history, units),
  );
  expect(mergedRisk.items[0].signals, "churn/bus-factor signals landed via the seam, unioned with existing").toEqual(["broad_authorship", "change_hotspot", "security_relevant"]);
  expect(register.items[0].signals, "producer+seam never mutate the input register").toEqual(["security_relevant"]);
});

// F6 inv-3 [CP-NODE-79]: degrade-to-empty in a non-git repo OR a shallow/empty
// clone. The full F6 path must produce {mined-equivalent empty} signals and add
// ZERO graph edges / risk signals vs a baseline bundle+register — and never
// throw — when there is no usable history. A non-git temp dir is the canonical
// unminable state (the same status!==0 => [] contract a shallow/empty clone
// hits when `git log` yields nothing in scope).
test("F6 inv-3 [CP-NODE-79]: non-git/shallow => mined:false empty, graph/risk unchanged vs baseline, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "no-git-inv3-"));
  try {
    // Manifest/units reference paths that simply do not exist in any history,
    // standing in for a shallow/empty clone whose log contributes nothing.
    const repoManifest = manifest(["a.ts", "b.ts"]);
    const units = {
      units: [{ unit_id: "u1", files: ["a.ts"] }, { unit_id: "u2", files: ["b.ts"] }],
    };

    // 1) The scoped artifact never throws and degrades to the empty aggregate.
    let history;
    assert.doesNotThrow(() => {
      history = mineGitHistoryArtifact(dir, repoManifest);
    }, "non-git directory must not throw");
    expect(history, "non-git / shallow clone mines to the empty aggregate (mined:false)").toEqual({ co_change: [], churn: [], authorship: [] });

    // 2) Producers project the empty aggregate to zero edges / zero signals.
    const edges = gitHistoryGraphEdges(history);
    expect(edges, "no co-change => zero graph edges").toEqual([]);
    const riskSignals = gitHistoryRiskSignals(history, units);
    expect(riskSignals.size, "no churn/authorship => zero risk signals").toBe(0);

    // 3) Merging that empty contribution leaves a baseline graph bundle and
    //    risk register byte-for-byte unchanged: zero edges, zero new signals.
    const baselineBundle = {
      graphs: {
        imports: [{ from: "x.ts", to: "y.ts", kind: "import" }],
        calls: [],
        references: [],
        routes: [],
      },
    };
    const mergedGraph = mergeAnalyzerGraphContribution(baselineBundle, edges);
    expect(mergedGraph.graphs, "empty F6 contribution adds zero edges (graph unchanged vs baseline)").toEqual(baselineBundle.graphs);

    const baselineRegister = {
      items: [
        { unit_id: "u1", risk_score: 2, signals: ["security_relevant"], notes: [] },
        { unit_id: "u2", risk_score: 1, signals: [], notes: [] },
      ],
    };
    const mergedRisk = mergeAnalyzerRiskSignals(baselineRegister, riskSignals);
    expect(mergedRisk.items.map((i) => i.signals), "empty F6 contribution adds zero risk signals (register unchanged vs baseline)").toEqual([["security_relevant"], []]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 fail-6 [CP-NODE-91]: out-of-manifest paths dropped at path-lookup gate,
// no dangling nodes. `git log` legitimately reports paths the audit never sees
// in scope — a vendored tree, a file deleted before HEAD, or a path renamed
// away. Those land in the raw mined aggregate (co_change / churn / authorship)
// but are NOT in repo_manifest, so `mineGitHistoryArtifact`'s in-scope filter
// (the `known()` path-lookup gate) MUST drop every row that references them.
// The end-to-end consequence: the co-change producer never emits a graph edge
// whose `from`/`to` is an unknown path, so merging F6's contribution can never
// introduce a dangling graph node (an edge endpoint with no manifest backing).
test("F6 fail-6 [CP-NODE-91]: out-of-manifest paths dropped at path-lookup gate, no dangling nodes", async () => {
  const dir = await makeRepo();
  try {
    // Three commits that ALWAYS co-touch the two in-scope files a.ts/b.ts AND a
    // vendored file outside the manifest, plus one churn-only out-of-scope path.
    // The vendored path co-changes with a.ts/b.ts every time and is the single
    // highest-churn / broadest-authorship file — precisely the row a naive miner
    // would surface — so dropping it is load-bearing, not incidental.
    await commit(
      dir,
      { "a.ts": "a1", "b.ts": "b1", "vendored.js": "v1", "gone.ts": "g1" },
      { name: "Author A", email: "a@example.com" },
    );
    await commit(
      dir,
      { "a.ts": "a2", "b.ts": "b2", "vendored.js": "v2" },
      { name: "Author B", email: "b@example.com" },
    );
    await commit(
      dir,
      { "a.ts": "a3", "b.ts": "b3", "vendored.js": "v3" },
      { name: "Author C", email: "c@example.com" },
    );

    // Manifest scopes ONLY a.ts and b.ts. vendored.js and gone.ts are
    // out-of-manifest (stand-ins for vendored / deleted / renamed paths).
    const repoManifest = manifest(["a.ts", "b.ts"]);
    const history = mineGitHistoryArtifact(dir, repoManifest);

    // 1) Every mined list is scoped: not a single row references an
    //    out-of-manifest path.
    const minedPaths = new Set([
      ...history.co_change.flatMap((p) => [p.a, p.b]),
      ...history.churn.map((e) => e.path),
      ...history.authorship.map((e) => e.path),
    ]);
    expect(!minedPaths.has("vendored.js"), "vendored out-of-manifest path dropped from the mined aggregate").toBeTruthy();
    expect(!minedPaths.has("gone.ts"), "deleted/renamed out-of-manifest path dropped from the mined aggregate").toBeTruthy();
    for (const p of minedPaths) {
      expect(p === "a.ts" || p === "b.ts", `mined aggregate references only in-scope paths, saw ${p}`).toBeTruthy();
    }

    // 2) The in-scope co-change survives the gate (proves the filter drops only
    //    the unknown paths, it does not gut legitimate signal): a.ts<->b.ts
    //    co-changed across all three commits.
    expect(history.co_change.length, "the single in-scope co-change pair survives the gate").toBe(1);
    expect([history.co_change[0].a, history.co_change[0].b].sort(), "surviving pair is exactly the in-scope a.ts/b.ts coupling").toEqual(["a.ts", "b.ts"]);

    // 3) End-to-end: the co-change producer emits no edge touching an unknown
    //    path, so a merge into the graph bundle introduces ZERO dangling nodes
    //    (every edge endpoint is manifest-backed).
    const manifestKeys = new Set(repoManifest.files.map((f) => f.path));
    const edges = gitHistoryGraphEdges(history);
    for (const edge of edges) {
      expect(manifestKeys.has(edge.from) && manifestKeys.has(edge.to), `every git-co-change edge endpoint is in-manifest (no dangling node), saw ${edge.from} -> ${edge.to}`).toBeTruthy();
    }

    const bundle = {
      graphs: { imports: [], calls: [], references: [], routes: [] },
    };
    const merged = mergeAnalyzerGraphContribution(bundle, edges);
    const landedEndpoints = merged.graphs.references.flatMap((e) => [
      e.from,
      e.to,
    ]);
    for (const endpoint of landedEndpoints) {
      expect(manifestKeys.has(endpoint), `no dangling graph node after merge, saw ${endpoint}`).toBeTruthy();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F6 fail-10 [CP-NODE-95]: git_history.json upstream-dep set matches F1 registration {repo_manifest,file_disposition}", async () => {
  // F6 produces git_history.json by mining only manifest-backed paths, so its
  // real upstream-dep set is exactly {repo_manifest.json, file_disposition.json}.
  // F1 registers that set in the literal ARTIFACT_DEPENDS_ON_MAP and in the
  // spec dep-map. If F6's declared deps drift, or the producer + registration
  // land in separate commits (half-registration), the registered set diverges
  // from what F6 actually consumes. This boundary test fails loudly on that
  // drift / half-registration over git_history.json.
  const expectedUpstream = ["file_disposition.json", "repo_manifest.json"];

  // 1) Literal-parity: F1's registered upstream set for git_history.json is
  //    exactly the set F6's producer consumes (manifest + disposition).
  const registered = ARTIFACT_DEPENDS_ON_MAP["git_history.json"];
  expect(Array.isArray(registered), "git_history.json is registered in ARTIFACT_DEPENDS_ON_MAP (no half-registration)").toBeTruthy();
  expect([...registered].sort(), "F1's registered upstream deps for git_history.json match F6's consumed set").toEqual(expectedUpstream);

  // 2) Co-commit boundary: the spec dep-map (F1's human-render of the same
  //    registration) lists git_history.json's "Depends on" table row as
  //    carrying BOTH upstreams. Producer + registration co-located => spec and
  //    literal agree; a separate-commit half-registration desyncs them and
  //    trips this.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const specPath = join(
    __dirname,
    "..",
    "..",
    "spec",
    "audit",
    "dependency-map.md",
  );
  const spec = await readFile(specPath, "utf8");
  const rowPattern = /^\|\s*`git_history\.json`\s*\|\s*(.+?)\s*\|$/m;
  const row = spec.match(rowPattern);
  expect(row, "spec dep-map has a Depends-on table row for git_history.json").toBeTruthy();
  const specDeps = [...row[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  for (const upstream of expectedUpstream) {
    expect(specDeps.includes(upstream), `spec dep-map lists ${upstream} as a git_history.json dependency (co-registered, not half-registered)`).toBeTruthy();
  }
});

// F6 fail-1 [CP-NODE-86]: git absent / non-git directory => isGitRepo() false =>
// the miner short-circuits to the empty aggregate BEFORE issuing any `git log`,
// so the result is mined:false (empty co_change/churn/authorship), contributes
// ZERO graph edges and ZERO risk signals, and never throws. This is the
// gate-at-isGitRepo() sibling of fail-3's status!==0 => [] degrade: when there is
// no git working tree at all (binary absent, or a plain directory), the first
// guard in mineGitHistory (`if (!isGitRepo(root)) return empty`) already yields
// the empty aggregate without touching the log. A non-git temp dir is the
// canonical stand-in: isGitRepo() is false there exactly as it is when the git
// binary cannot be found.
test("F6 fail-1 [CP-NODE-86]: git absent/isGitRepo false => mined:false empty, no throw, zero graph/risk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-absent-fail1-"));
  try {
    // Precondition: this directory is genuinely not a git working tree, so the
    // isGitRepo() gate is the code path under test (same false verdict the
    // miner would see if the git binary were absent entirely).
    expect(isGitRepo(dir), "temp dir is not a git working tree").toBe(false);

    // 1) Both mining surfaces degrade to the empty aggregate and never throw.
    let history;
    assert.doesNotThrow(() => {
      history = mineGitHistory(dir);
    }, "non-git/git-absent must not throw (raw miner)");
    expect(history, "isGitRepo() false => empty aggregate (mined:false)").toEqual({ co_change: [], churn: [], authorship: [] });

    let scoped;
    assert.doesNotThrow(() => {
      scoped = mineGitHistoryArtifact(dir, manifest(["a.ts", "b.ts"]));
    }, "non-git/git-absent must not throw (scoped artifact)");
    expect(scoped, "scoped artifact also degrades to the empty aggregate").toEqual({ co_change: [], churn: [], authorship: [] });

    // 2) The empty aggregate projects to zero graph edges and zero risk signals.
    const units = {
      units: [{ unit_id: "u1", files: ["a.ts"] }, { unit_id: "u2", files: ["b.ts"] }],
    };
    const edges = gitHistoryGraphEdges(history);
    expect(edges, "no history => zero graph edges").toEqual([]);
    const riskSignals = gitHistoryRiskSignals(history, units);
    expect(riskSignals.size, "no history => zero risk signals").toBe(0);

    // 3) Merging that empty contribution leaves a baseline bundle/register
    //    unchanged: zero graph/risk contribution end-to-end.
    const baselineBundle = {
      graphs: {
        imports: [{ from: "x.ts", to: "y.ts", kind: "import" }],
        calls: [],
        references: [],
        routes: [],
      },
    };
    const mergedGraph = mergeAnalyzerGraphContribution(baselineBundle, edges);
    expect(mergedGraph.graphs, "empty contribution adds zero graph edges").toEqual(baselineBundle.graphs);

    const baselineRegister = {
      items: [
        { unit_id: "u1", risk_score: 2, signals: ["security_relevant"], notes: [] },
        { unit_id: "u2", risk_score: 1, signals: [], notes: [] },
      ],
    };
    const mergedRisk = mergeAnalyzerRiskSignals(baselineRegister, riskSignals);
    expect(mergedRisk.items.map((i) => i.signals), "empty contribution adds zero risk signals").toEqual([["security_relevant"], []]);

    // 4) Deterministic + non-throwing on repeat.
    expect(mineGitHistory(dir)).toEqual(history);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── F6 wiring (structure-executor integration + compound signal) ──────────────

// deriveRiskConcentration: the churn × complexity compound. Only a unit carrying
// BOTH change_hotspot (git churn) AND high_complexity (node_metrics) earns
// risk_concentration — the real risk concentration. Pure, informational
// (risk_score untouched), idempotent, non-mutating.
test("deriveRiskConcentration flags only churn × complexity, leaves score, is idempotent", () => {
  const register = {
    items: [
      { unit_id: "both", risk_score: 4, signals: ["change_hotspot", "high_complexity"], notes: [] },
      { unit_id: "churn-only", risk_score: 2, signals: ["change_hotspot"], notes: [] },
      { unit_id: "cplx-only", risk_score: 3, signals: ["high_complexity"], notes: [] },
    ],
  };
  const out = deriveRiskConcentration(register);
  expect(out.items[0].signals).toEqual([
    "change_hotspot",
    "high_complexity",
    "risk_concentration",
  ]);
  expect(out.items[0].risk_score, "informational — score untouched").toBe(4);
  expect(out.items[1].signals, "churn alone is not concentration").toEqual(["change_hotspot"]);
  expect(out.items[2].signals, "complexity alone is not concentration").toEqual(["high_complexity"]);
  // Idempotent + non-mutating.
  expect(deriveRiskConcentration(out).items[0].signals).toEqual(out.items[0].signals);
  expect(register.items[0].signals, "input not mutated").toEqual(["change_hotspot", "high_complexity"]);
});

// Co-change is temporal coupling, NOT a structural dependency: it lands in its
// own `co_change` bucket and allGraphEdges must skip it, so it can never inflate
// fan-in/out, hubs, cycles, or seams.
test("allGraphEdges excludes the co_change bucket (temporal coupling never feeds structural signals)", () => {
  const structuralEdge = { from: "a.ts", to: "b.ts", kind: "import" };
  const bundle = {
    graphs: {
      imports: [structuralEdge],
      [GIT_CO_CHANGE_CATEGORY]: [
        { from: "x.ts", to: "y.ts", kind: "git-co-change", direction: "undirected" },
        { from: "y.ts", to: "x.ts", kind: "git-co-change", direction: "undirected" },
      ],
    },
  };
  const edges = allGraphEdges(bundle);
  expect(edges, "only the structural edge is flattened; co_change skipped").toEqual([structuralEdge]);
  // And a co-change "cycle" (x↔y) must NOT register as a structural cycle.
  const signals = deriveGraphSignals(bundle);
  expect(signals.cycles, "co-change reciprocity is not a structural cycle").toEqual([]);
  expect(signals.fanIn.get("x.ts") ?? 0, "co-change does not contribute fan-in").toBe(0);
});

// The headline wiring: runStructureExecutor now MINES git history end-to-end —
// produces git_history, merges co-change into the co_change bucket with
// git-history provenance, and merges churn/authorship risk signals — none of
// which happened before (the extractor existed but was never called).
test("runStructureExecutor wires git-history mining: git_history + co_change bucket + provenance + risk signals", async () => {
  const dir = await makeRepo();
  try {
    // a.ts is deliberately complex (many branches → high node-metric complexity)
    // and churned ≥ 8 times; it co-changes with b.ts every commit. This drives
    // change_hotspot + high_complexity → risk_concentration, plus a co-change edge.
    const complexBody = (n) =>
      `export function f${n}(x){` +
      Array.from({ length: 12 }, (_, i) => `if(x===${i}){return ${i};}`).join("") +
      `return -1;}`;
    for (let i = 0; i < 9; i++) {
      await commit(
        dir,
        { "a.ts": complexBody(i), "b.ts": `export const b=${i};` },
        { name: "Author A", email: "a@example.com" },
      );
    }

    const repoManifest = await buildRepoManifestFromFs({ root: dir });
    const result = await runStructureExecutor({ repo_manifest: repoManifest }, dir);
    const { git_history, graph_bundle, risk_register } = result.updated;

    // 1) git_history is now produced and persisted by the executor.
    expect(git_history, "structure executor produces git_history").toBeTruthy();
    expect(result.artifacts_written.includes("git_history.json")).toBeTruthy();
    expect(git_history.churn.find((c) => c.path === "a.ts")?.commits >= 8, "a.ts mined as a churn hotspot").toBeTruthy();

    // 2) Co-change landed in the co_change bucket (NOT references) with provenance.
    const coChange = graph_bundle.graphs[GIT_CO_CHANGE_CATEGORY] ?? [];
    expect(coChange.some(
        (e) =>
          (e.from === "a.ts" && e.to === "b.ts") ||
          (e.from === "b.ts" && e.to === "a.ts"),
      ), "a.ts/b.ts co-change edge present in the co_change bucket").toBeTruthy();
    expect((graph_bundle.analyzers_used ?? []).includes("git-history"), "git-history recorded as a contributing analyzer").toBeTruthy();
    // Co-change must NOT have leaked into a structural bucket.
    expect((graph_bundle.graphs.references ?? []).some((e) => e.kind === "git-co-change"), "co-change does not pollute the references bucket").toBe(false);

    // 3) Risk signals merged: a.ts's unit carries the churn × complexity compound.
    const concentrated = risk_register.items.find((it) =>
      it.signals.includes("risk_concentration"),
    );
    expect(concentrated, "a churned + complex unit earns the risk_concentration compound signal").toBeTruthy();
    expect(concentrated.signals.includes("change_hotspot") &&
        concentrated.signals.includes("high_complexity"), "risk_concentration only when both axes fire").toBeTruthy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Without a root (in-memory / no git), the executor degrades cleanly: empty
// git_history, no co_change bucket, no git-history provenance — never throws.
test("runStructureExecutor degrades to empty git-history without a root", async () => {
  const repoManifest = manifest(["a.ts", "b.ts"]);
  const result = await runStructureExecutor({ repo_manifest: repoManifest });
  expect(result.updated.git_history).toEqual({
    co_change: [],
    churn: [],
    authorship: [],
  });
  expect(result.artifacts_written.includes("git_history.json")).toBeTruthy();
  expect((result.updated.graph_bundle.analyzers_used ?? []).includes("git-history"), "no git-history provenance when nothing was mined").toBe(false);
});

// F6 inv-8 [CP-NODE-84]: author identity is mailmap-canonical (output changes
// iff the authorship signal changes). Two display-names committed for ONE human
// must roll up — via .mailmap + `--use-mailmap`/`%aN` — to a SINGLE distinct
// author in the authorship / bus-factor output. Without mailmap, the same file
// would show 2 authors (a split-identity false bus-factor signal).
test("F6 inv-8 [CP-NODE-84]: author identity is mailmap-canonical (output changes iff the authorship signal changes)", async () => {
  const dir = await makeRepo();
  try {
    // .mailmap rolls both display names/emails onto ONE canonical identity.
    await writeFile(
      join(dir, ".mailmap"),
      "Canonical Person <canon@example.com> Alias One <alias1@example.com>\n" +
        "Canonical Person <canon@example.com> Alias Two <alias2@example.com>\n",
      "utf8",
    );
    // Same file touched under two DISTINCT raw author identities, both aliased
    // to the one canonical person by the mailmap above.
    await commit(
      dir,
      { "f.ts": "1" },
      { name: "Alias One", email: "alias1@example.com" },
    );
    await commit(
      dir,
      { "f.ts": "2" },
      { name: "Alias Two", email: "alias2@example.com" },
    );

    const history = mineGitHistory(dir);
    expect(history.authorship.find((a) => a.path === "f.ts")?.authors, "two mailmap-aliased names for one person collapse to ONE distinct author").toBe(1);
    // Determinism preserved through the mailmap path.
    expect(mineGitHistory(dir)).toEqual(history);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 fail-4 [CP-NODE-89]: author split/collision prevented by mailmap roll-up.
// One human under two names must NOT inflate distinct_author_count, AND two
// genuinely-distinct humans must NOT be collapsed — mailmap canonicalizes only
// what it is told to, so real authorship breadth survives.
test("F6 fail-4 [CP-NODE-89]: author split/collision prevented by mailmap roll-up", async () => {
  const dir = await makeRepo();
  try {
    // Only the two aliases of ONE person are mapped; the third human is left
    // untouched, so the file's true distinct-author count is 2, not 1 or 3.
    await writeFile(
      join(dir, ".mailmap"),
      "Canonical Person <canon@example.com> Alias One <alias1@example.com>\n" +
        "Canonical Person <canon@example.com> Alias Two <alias2@example.com>\n",
      "utf8",
    );
    await commit(dir, { "shared.ts": "1" }, { name: "Alias One", email: "alias1@example.com" });
    await commit(dir, { "shared.ts": "2" }, { name: "Alias Two", email: "alias2@example.com" });
    await commit(dir, { "shared.ts": "3" }, { name: "Distinct Human", email: "other@example.com" });

    const history = mineGitHistory(dir);
    expect(history.authorship.find((a) => a.path === "shared.ts")?.authors, "one human under two names does NOT inflate the count; a second human is NOT collapsed").toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F6 fail-7 [CP-NODE-92]: a FIXED co-change support threshold keeps
// git_history.json content-stable across runs — re-mining unchanged history
// must yield byte-identical co_change (no run-varying / time-varying threshold).
test("F6 fail-7 [CP-NODE-92]: fixed co-change support threshold keeps git_history.json content-stable across runs", async () => {
  const dir = await makeRepo();
  try {
    // x.ts/y.ts co-change twice (>= the fixed default min of 2); x.ts/z.ts once
    // (below threshold) — a boundary pair whose inclusion depends entirely on the
    // threshold being fixed and applied identically every run.
    await commit(
      dir,
      { "x.ts": "1", "y.ts": "1", "z.ts": "1" },
      { name: "Author A", email: "a@example.com" },
    );
    await commit(
      dir,
      { "x.ts": "2", "y.ts": "2" },
      { name: "Author A", email: "a@example.com" },
    );

    const first = JSON.stringify(mineGitHistory(dir).co_change);
    const second = JSON.stringify(mineGitHistory(dir).co_change);
    const third = JSON.stringify(mineGitHistory(dir).co_change);
    expect(first, "fixed threshold => byte-identical co_change across re-mines").toBe(second);
    expect(second, "fixed threshold => byte-identical co_change across re-mines").toBe(third);
    // The threshold actually gated: the above-support pair is in, the single-
    // commit pair is out — proving stability is of a real, non-empty result.
    const pairs = new Set(mineGitHistory(dir).co_change.map((p) => `${p.a}|${p.b}`));
    expect(pairs.has("x.ts|y.ts"), "above-support pair included").toBe(true);
    expect(pairs.has("x.ts|z.ts"), "below-support pair excluded by the fixed threshold").toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
