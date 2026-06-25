import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const { mineGitHistory } = await import("../../src/shared/git.ts");
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
