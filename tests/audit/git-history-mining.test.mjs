import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const { mineGitHistory, isGitRepo } = await import("../../src/shared/git.ts");
const {
  mineGitHistoryArtifact,
  gitHistoryGraphEdges,
  gitHistoryRiskSignals,
} = await import("../../src/audit/extractors/gitHistory.ts");
const { mergeAnalyzerGraphContribution } = await import(
  "../../src/audit/extractors/graph.ts"
);
const { mergeAnalyzerRiskSignals } = await import(
  "../../src/audit/extractors/risk.ts"
);
const { ARTIFACT_DEPENDS_ON_MAP } = await import(
  "../../src/audit/orchestrator/dependencyMap.ts"
);

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
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
    assert.doesNotMatch(
      line,
      /extractors\/analyzers/,
      `F6 must not import an F5 analyzer: ${line.trim()}`,
    );
    assert.doesNotMatch(
      line,
      /\.\.\/adapters\//,
      `F6 must not import an F5 adapter: ${line.trim()}`,
    );
  }
  // It does mine through the shared git seam.
  assert.match(src, /from\s+["']audit-tools\/shared["']/);
});

// F6 inv-7: F6 is the authoritative source for git_history.json's upstream-dep
// declaration — exactly {repo_manifest, file_disposition}. F1 only transcribes
// it into ARTIFACT_DEPENDS_ON_MAP / dependency-map.md (CCU-git-history-registration).
test("F6 inv-7: git_history.json declares upstream deps exactly {repo_manifest, file_disposition}", () => {
  assert.deepEqual(
    [...(ARTIFACT_DEPENDS_ON_MAP["git_history.json"] ?? [])].sort(),
    ["file_disposition.json", "repo_manifest.json"],
  );
});

test("mineGitHistory degrades to empty on a non-git directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "no-git-"));
  try {
    const history = mineGitHistory(dir);
    assert.deepEqual(history, { co_change: [], churn: [], authorship: [] });
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
    assert.equal(
      history.churn.find((c) => c.path === "plain.ts")?.commits,
      2,
      "well-formed path still mined despite a hard-to-parse sibling row",
    );
    assert.ok(
      history.churn.some((c) => c.commits === 2),
      "the offending path degrades to empty if unparseable but never aborts mining",
    );
    // Deterministic + non-throwing on repeat.
    assert.deepEqual(mineGitHistory(dir), history);
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
    assert.deepEqual(
      history,
      { co_change: [], churn: [], authorship: [] },
      "no-commit repo (git log fails) degrades to the empty aggregate",
    );
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
    assert.deepEqual(first, second, "identical history → identical output");

    // a.ts: 3 commits, b.ts: 2 → churn sorted by count desc.
    assert.deepEqual(first.churn, [
      { path: "a.ts", commits: 3 },
      { path: "b.ts", commits: 2 },
    ]);
    // a.ts touched by both authors, b.ts by both → 2 each, ties broken by path.
    assert.deepEqual(first.authorship, [
      { path: "a.ts", authors: 2 },
      { path: "b.ts", authors: 2 },
    ]);
    // a.ts & b.ts changed together in 2 commits (>= default min 2).
    assert.deepEqual(first.co_change, [{ a: "a.ts", b: "b.ts", commits: 2 }]);
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
    assert.deepEqual(
      Object.fromEntries(history.churn.map((c) => [c.path, c.commits])),
      { "mod.py": 2, "lib.ts": 2, "core.rs": 2, Makefile: 2 },
      "churn covers every extension and the extensionless path equally",
    );
    // Every touched path appears in authorship (2 distinct authors each).
    assert.deepEqual(
      Object.fromEntries(history.authorship.map((a) => [a.path, a.authors])),
      { "mod.py": 2, "lib.ts": 2, "core.rs": 2, Makefile: 2 },
      "authorship covers every extension and the extensionless path equally",
    );
    // Co-change pairs span across languages too (all 6 pairs, 2 commits each).
    assert.deepEqual(
      new Set(history.co_change.map((c) => `${c.a}|${c.b}`)),
      new Set([
        "Makefile|core.rs",
        "Makefile|lib.ts",
        "Makefile|mod.py",
        "core.rs|lib.ts",
        "core.rs|mod.py",
        "lib.ts|mod.py",
      ]),
      "co-change pairs cross language boundaries with no gating",
    );
    assert.ok(
      history.co_change.every((c) => c.commits === 2),
      "every cross-language pair counted across both commits",
    );
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
    assert.equal(pairs.has("a.ts|b.ts"), false, "single-commit pair below threshold is omitted");
    // Above-threshold pair (2 shared commits) emitted with its support count.
    assert.deepEqual(
      history.co_change.find((p) => p.a === "c.ts" && p.b === "d.ts"),
      { a: "c.ts", b: "d.ts", commits: 2 },
    );

    // Confidence is a deterministic function of support: base + 0.05*(n-1).
    const edges = gitHistoryGraphEdges(history);
    const cd = edges.find((e) => e.from === "c.ts" && e.to === "d.ts");
    assert.ok(cd, "above-threshold pair projects to a graph edge");
    assert.equal(cd.confidence, 0.45, "confidence for 2 shared commits = 0.4 + 0.05*(2-1)");
    // The omitted pair never reaches the edge projection.
    assert.equal(edges.some((e) => e.from === "a.ts" && e.to === "b.ts"), false);
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
    assert.equal(
      bounded.churn.some((c) => c.path === "old.ts"),
      false,
      "commit outside the bounded window does not contribute to churn",
    );
    assert.equal(
      bounded.authorship.some((a) => a.path === "old.ts"),
      false,
      "commit outside the bounded window does not contribute to authorship",
    );
    assert.equal(
      bounded.co_change.length,
      0,
      "the old co-change pair is excluded; no in-window pair reaches threshold",
    );
    assert.deepEqual(
      bounded.churn.find((c) => c.path === "new.ts"),
      { path: "new.ts", commits: 2 },
      "only the two in-window commits count toward new.ts churn",
    );

    // Unbounded scan DOES see the old commit — proving the window, not absence
    // of history, is what excludes it.
    const full = mineGitHistory(dir);
    assert.equal(
      full.churn.some((c) => c.path === "old.ts"),
      true,
      "without the bound the old commit is in scope (the window is the guard)",
    );
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
    assert.deepEqual(history.churn, [{ path: "a.ts", commits: 2 }]);
    assert.deepEqual(history.co_change, []);
    assert.deepEqual(history.authorship, [{ path: "a.ts", authors: 1 }]);
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
    assert.deepEqual(history.co_change, [
      { a: "also.ts", b: "in.ts", commits: 2 },
    ]);
    // churn/authorship likewise scoped — no vendor.ts row.
    assert.equal(history.churn.some((e) => e.path === "vendor.ts"), false);
    assert.equal(
      history.authorship.some((e) => e.path === "vendor.ts"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitHistoryGraphEdges projects co-change to undirected edges (empty → empty)", () => {
  assert.deepEqual(gitHistoryGraphEdges({ co_change: [], churn: [], authorship: [] }), []);
  const edges = gitHistoryGraphEdges({
    co_change: [{ a: "a.ts", b: "b.ts", commits: 3 }],
    churn: [],
    authorship: [],
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, "a.ts");
  assert.equal(edges[0].to, "b.ts");
  assert.equal(edges[0].direction, "undirected");
  assert.equal(edges[0].kind, "git-co-change");
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
  assert.deepEqual(signals.get("u1"), ["change_hotspot", "broad_authorship"]);
  assert.equal(signals.has("u2"), false);
});

test("mergeAnalyzerGraphContribution is idempotent and non-mutating", () => {
  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  const edges = [
    { from: "a.ts", to: "b.ts", kind: "git-co-change", direction: "undirected" },
  ];
  const once = mergeAnalyzerGraphContribution(bundle, edges);
  const twice = mergeAnalyzerGraphContribution(once, edges);
  assert.equal(once.graphs.references.length, 1);
  assert.deepEqual(twice.graphs.references, once.graphs.references, "idempotent");
  assert.deepEqual(bundle.graphs.references, [], "input not mutated");
});

test("mergeAnalyzerGraphContribution degrades to a clone on empty edges", () => {
  const bundle = { graphs: { imports: [], calls: [], references: [], routes: [] } };
  const out = mergeAnalyzerGraphContribution(bundle, undefined);
  assert.notEqual(out, bundle);
  assert.deepEqual(out.graphs.references, []);
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
  assert.deepEqual(merged.items[0].signals, ["change_hotspot", "security_relevant"]);
  assert.deepEqual(merged.items[1].signals, []);
  // risk_score untouched (informational signals).
  assert.equal(merged.items[0].risk_score, 3);
  // input not mutated.
  assert.deepEqual(register.items[0].signals, ["security_relevant"]);
});

test("mergeAnalyzerRiskSignals degrades to a clone on an empty map", () => {
  const register = { items: [{ unit_id: "u1", risk_score: 0, signals: [], notes: [] }] };
  const out = mergeAnalyzerRiskSignals(register, undefined);
  assert.notEqual(out, register);
  assert.deepEqual(out.items[0].signals, []);
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
  assert.equal(
    typeof mergeAnalyzerGraphContribution,
    "function",
    "graph-contribution seam must be shipped before F6 consumers run",
  );
  assert.equal(
    typeof mergeAnalyzerRiskSignals,
    "function",
    "risk-signals seam must be shipped before F6 consumers run",
  );
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
  assert.doesNotMatch(
    src,
    /\.graphs\.(imports|calls|references|routes)\b/,
    "F6 must not touch graph-bundle edge lists directly; route through mergeAnalyzerGraphContribution",
  );
  assert.doesNotMatch(
    src,
    /\bregister\.items\b/,
    "F6 must not mutate the risk register directly; route through mergeAnalyzerRiskSignals",
  );
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
  assert.equal(mergedGraph.graphs.references.length, 1, "co-change edge landed via the seam");
  assert.equal(mergedGraph.graphs.references[0].kind, "git-co-change");
  assert.deepEqual(bundle.graphs.references, [], "producer+seam never mutate the input bundle");

  const register = {
    items: [{ unit_id: "u1", risk_score: 2, signals: ["security_relevant"], notes: [] }],
  };
  const mergedRisk = mergeAnalyzerRiskSignals(
    register,
    gitHistoryRiskSignals(history, units),
  );
  assert.deepEqual(
    mergedRisk.items[0].signals,
    ["broad_authorship", "change_hotspot", "security_relevant"],
    "churn/bus-factor signals landed via the seam, unioned with existing",
  );
  assert.deepEqual(
    register.items[0].signals,
    ["security_relevant"],
    "producer+seam never mutate the input register",
  );
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
    assert.deepEqual(
      history,
      { co_change: [], churn: [], authorship: [] },
      "non-git / shallow clone mines to the empty aggregate (mined:false)",
    );

    // 2) Producers project the empty aggregate to zero edges / zero signals.
    const edges = gitHistoryGraphEdges(history);
    assert.deepEqual(edges, [], "no co-change => zero graph edges");
    const riskSignals = gitHistoryRiskSignals(history, units);
    assert.equal(riskSignals.size, 0, "no churn/authorship => zero risk signals");

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
    assert.deepEqual(
      mergedGraph.graphs,
      baselineBundle.graphs,
      "empty F6 contribution adds zero edges (graph unchanged vs baseline)",
    );

    const baselineRegister = {
      items: [
        { unit_id: "u1", risk_score: 2, signals: ["security_relevant"], notes: [] },
        { unit_id: "u2", risk_score: 1, signals: [], notes: [] },
      ],
    };
    const mergedRisk = mergeAnalyzerRiskSignals(baselineRegister, riskSignals);
    assert.deepEqual(
      mergedRisk.items.map((i) => i.signals),
      [["security_relevant"], []],
      "empty F6 contribution adds zero risk signals (register unchanged vs baseline)",
    );
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
    assert.ok(
      !minedPaths.has("vendored.js"),
      "vendored out-of-manifest path dropped from the mined aggregate",
    );
    assert.ok(
      !minedPaths.has("gone.ts"),
      "deleted/renamed out-of-manifest path dropped from the mined aggregate",
    );
    for (const p of minedPaths) {
      assert.ok(
        p === "a.ts" || p === "b.ts",
        `mined aggregate references only in-scope paths, saw ${p}`,
      );
    }

    // 2) The in-scope co-change survives the gate (proves the filter drops only
    //    the unknown paths, it does not gut legitimate signal): a.ts<->b.ts
    //    co-changed across all three commits.
    assert.equal(
      history.co_change.length,
      1,
      "the single in-scope co-change pair survives the gate",
    );
    assert.deepEqual(
      [history.co_change[0].a, history.co_change[0].b].sort(),
      ["a.ts", "b.ts"],
      "surviving pair is exactly the in-scope a.ts/b.ts coupling",
    );

    // 3) End-to-end: the co-change producer emits no edge touching an unknown
    //    path, so a merge into the graph bundle introduces ZERO dangling nodes
    //    (every edge endpoint is manifest-backed).
    const manifestKeys = new Set(repoManifest.files.map((f) => f.path));
    const edges = gitHistoryGraphEdges(history);
    for (const edge of edges) {
      assert.ok(
        manifestKeys.has(edge.from) && manifestKeys.has(edge.to),
        `every git-co-change edge endpoint is in-manifest (no dangling node), saw ${edge.from} -> ${edge.to}`,
      );
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
      assert.ok(
        manifestKeys.has(endpoint),
        `no dangling graph node after merge, saw ${endpoint}`,
      );
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
  assert.ok(
    Array.isArray(registered),
    "git_history.json is registered in ARTIFACT_DEPENDS_ON_MAP (no half-registration)",
  );
  assert.deepEqual(
    [...registered].sort(),
    expectedUpstream,
    "F1's registered upstream deps for git_history.json match F6's consumed set",
  );

  // 2) Co-commit boundary: the spec dep-map (F1's human-render of the same
  //    registration) lists git_history.json as downstream of BOTH upstreams.
  //    Producer + registration co-located => spec and literal agree; a
  //    separate-commit half-registration desyncs them and trips this.
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
  const sections = spec.split(/^### /m);
  for (const upstream of expectedUpstream) {
    const section = sections.find((s) => s.startsWith(`\`${upstream}\``));
    assert.ok(
      section,
      `spec dep-map has a section for upstream ${upstream}`,
    );
    assert.ok(
      section.includes("`git_history.json`"),
      `spec dep-map lists git_history.json as downstream of ${upstream} (co-registered, not half-registered)`,
    );
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
    assert.equal(isGitRepo(dir), false, "temp dir is not a git working tree");

    // 1) Both mining surfaces degrade to the empty aggregate and never throw.
    let history;
    assert.doesNotThrow(() => {
      history = mineGitHistory(dir);
    }, "non-git/git-absent must not throw (raw miner)");
    assert.deepEqual(
      history,
      { co_change: [], churn: [], authorship: [] },
      "isGitRepo() false => empty aggregate (mined:false)",
    );

    let scoped;
    assert.doesNotThrow(() => {
      scoped = mineGitHistoryArtifact(dir, manifest(["a.ts", "b.ts"]));
    }, "non-git/git-absent must not throw (scoped artifact)");
    assert.deepEqual(
      scoped,
      { co_change: [], churn: [], authorship: [] },
      "scoped artifact also degrades to the empty aggregate",
    );

    // 2) The empty aggregate projects to zero graph edges and zero risk signals.
    const units = {
      units: [{ unit_id: "u1", files: ["a.ts"] }, { unit_id: "u2", files: ["b.ts"] }],
    };
    const edges = gitHistoryGraphEdges(history);
    assert.deepEqual(edges, [], "no history => zero graph edges");
    const riskSignals = gitHistoryRiskSignals(history, units);
    assert.equal(riskSignals.size, 0, "no history => zero risk signals");

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
    assert.deepEqual(
      mergedGraph.graphs,
      baselineBundle.graphs,
      "empty contribution adds zero graph edges",
    );

    const baselineRegister = {
      items: [
        { unit_id: "u1", risk_score: 2, signals: ["security_relevant"], notes: [] },
        { unit_id: "u2", risk_score: 1, signals: [], notes: [] },
      ],
    };
    const mergedRisk = mergeAnalyzerRiskSignals(baselineRegister, riskSignals);
    assert.deepEqual(
      mergedRisk.items.map((i) => i.signals),
      [["security_relevant"], []],
      "empty contribution adds zero risk signals",
    );

    // 4) Deterministic + non-throwing on repeat.
    assert.deepEqual(mineGitHistory(dir), history);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    assert.equal(
      history.authorship.find((a) => a.path === "f.ts")?.authors,
      1,
      "two mailmap-aliased names for one person collapse to ONE distinct author",
    );
    // Determinism preserved through the mailmap path.
    assert.deepEqual(mineGitHistory(dir), history);
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
    assert.equal(
      history.authorship.find((a) => a.path === "shared.ts")?.authors,
      2,
      "one human under two names does NOT inflate the count; a second human is NOT collapsed",
    );
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
    assert.equal(first, second, "fixed threshold => byte-identical co_change across re-mines");
    assert.equal(second, third, "fixed threshold => byte-identical co_change across re-mines");
    // The threshold actually gated: the above-support pair is in, the single-
    // commit pair is out — proving stability is of a real, non-empty result.
    const pairs = new Set(mineGitHistory(dir).co_change.map((p) => `${p.a}|${p.b}`));
    assert.equal(pairs.has("x.ts|y.ts"), true, "above-support pair included");
    assert.equal(pairs.has("x.ts|z.ts"), false, "below-support pair excluded by the fixed threshold");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
