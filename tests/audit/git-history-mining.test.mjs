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
