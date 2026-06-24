import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
