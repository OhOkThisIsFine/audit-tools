import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  computeAuditScope,
  applyScopeToCoverage,
  resolveAuditScope,
  fullAuditScope,
} = await import("../src/orchestrator/scope.ts");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// Build a graph_bundle whose import edges all share one confidence so hop-decay
// is easy to reason about. Edges are bidirectional during scope expansion.
function bundleWithEdges(edges) {
  return {
    graphs: {
      imports: edges.map((e) => ({
        from: e.from,
        to: e.to,
        kind: "ts-import",
        direction: "directed",
        confidence: e.confidence,
      })),
      calls: [],
      references: [],
      routes: [],
    },
  };
}

function coverage(paths, { status = "pending", lenses = ["correctness"] } = {}) {
  return {
    files: paths.map((path) => ({
      path,
      unit_ids: ["u"],
      classification_status: "classified",
      audit_status: status,
      required_lenses: [...lenses],
      completed_lenses: status === "complete" ? [...lenses] : [],
    })),
  };
}

test("computeAuditScope: deterministic — same inputs (any changed order) → identical scope", () => {
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"];
  const graphBundle = bundleWithEdges([
    { from: "src/a.ts", to: "src/b.ts", confidence: 0.6 },
    { from: "src/a.ts", to: "src/e.ts", confidence: 0.6 },
    { from: "src/b.ts", to: "src/c.ts", confidence: 0.6 },
  ]);
  const first = computeAuditScope({
    since: "HEAD~1",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle,
  });
  const second = computeAuditScope({
    since: "HEAD~1",
    changed: ["src/a.ts"],
    includedFiles: [...included].reverse(),
    graphBundle,
  });
  assert.deepEqual(first, second);
  assert.equal(first.mode, "delta");
  assert.equal(first.since, "HEAD~1");
});

test("computeAuditScope: one changed file pulls in only its direct neighbours", () => {
  // 0.6 edges: one hop (0.6) clears the 0.5 frontier floor, two hops (0.36) do not.
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges([
      { from: "src/a.ts", to: "src/b.ts", confidence: 0.6 },
      { from: "src/a.ts", to: "src/e.ts", confidence: 0.6 },
      { from: "src/b.ts", to: "src/c.ts", confidence: 0.6 },
    ]),
  });
  assert.deepEqual(scope.seed_files, ["src/a.ts"]);
  assert.deepEqual(scope.expanded_files, ["src/b.ts", "src/e.ts"]);
  // src/c.ts is two hops away and must stay out of scope.
  assert.ok(!scope.expanded_files.includes("src/c.ts"));
});

test("applyScopeToCoverage: in-scope files re-queue, the rest inherit prior complete", () => {
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges([
      { from: "src/a.ts", to: "src/b.ts", confidence: 0.6 },
      { from: "src/a.ts", to: "src/e.ts", confidence: 0.6 },
      { from: "src/b.ts", to: "src/c.ts", confidence: 0.6 },
    ]),
  });
  const fresh = coverage(included, { status: "pending" });
  const prior = coverage(included, { status: "complete" });
  const result = applyScopeToCoverage(fresh, scope, prior);
  const byPath = new Map(result.files.map((f) => [f.path, f]));

  // Seed + direct neighbours re-queue (pending, nothing completed yet).
  for (const inScope of ["src/a.ts", "src/b.ts", "src/e.ts"]) {
    assert.equal(byPath.get(inScope).audit_status, "pending");
    assert.deepEqual(byPath.get(inScope).completed_lenses, []);
  }
  // Out-of-scope file with a prior complete record inherits that completion.
  assert.equal(byPath.get("src/c.ts").audit_status, "complete");
  assert.deepEqual(byPath.get("src/c.ts").completed_lenses, ["correctness"]);
});

test("applyScopeToCoverage: out-of-scope file with no prior is excluded this run", () => {
  const scope = {
    mode: "delta",
    since: "main",
    seed_files: ["src/a.ts"],
    expanded_files: [],
    budget: { max_files: 200 },
  };
  const fresh = coverage(["src/a.ts", "src/z.ts"], { status: "pending" });
  const result = applyScopeToCoverage(fresh, scope /* no prior */);
  const z = result.files.find((f) => f.path === "src/z.ts");
  assert.equal(z.audit_status, "excluded");
  assert.equal(z.classification_status, "out_of_scope_delta");
  assert.deepEqual(z.required_lenses, []);
});

test("applyScopeToCoverage: full scope is a no-op", () => {
  const fresh = coverage(["src/a.ts", "src/b.ts"], { status: "pending" });
  const result = applyScopeToCoverage(fresh, fullAuditScope());
  assert.equal(result.files.every((f) => f.audit_status === "pending"), true);
});

test("applyScopeToCoverage: deterministic exclusions are left untouched", () => {
  const scope = {
    mode: "delta",
    since: "main",
    seed_files: ["src/a.ts"],
    expanded_files: [],
    budget: { max_files: 200 },
  };
  const fresh = coverage(["src/a.ts", "vendor/lib.js"], { status: "pending" });
  fresh.files.find((f) => f.path === "vendor/lib.js").audit_status = "excluded";
  const result = applyScopeToCoverage(fresh, scope);
  const vendor = result.files.find((f) => f.path === "vendor/lib.js");
  assert.equal(vendor.audit_status, "excluded");
  // Not re-tagged as out_of_scope_delta — it was already a deterministic exclusion.
  assert.notEqual(vendor.classification_status, "out_of_scope_delta");
});

test("computeAuditScope: high fan-in/out hubs are skipped to prevent scope blow-up", () => {
  // seed -> hub, hub -> f0..f14 (15 fan-out > HIGH_FAN_DEGREE_THRESHOLD of 12).
  const fanFiles = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`);
  const edges = [{ from: "src/seed.ts", to: "src/hub.ts", confidence: 0.9 }];
  for (const f of fanFiles) {
    edges.push({ from: "src/hub.ts", to: f, confidence: 0.9 });
  }
  const included = ["src/seed.ts", "src/hub.ts", ...fanFiles];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/seed.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges(edges),
  });
  // The hub is never traversed into, so neither it nor its 15 dependents enter scope.
  assert.deepEqual(scope.seed_files, ["src/seed.ts"]);
  assert.deepEqual(scope.expanded_files, []);
});

test("computeAuditScope: expansion stops at the file budget and records a note", () => {
  // A long 0.9-edge chain that would expand far if unbounded.
  const chain = Array.from({ length: 10 }, (_, i) => `src/n${i}.ts`);
  const edges = [];
  for (let i = 0; i < chain.length - 1; i++) {
    edges.push({ from: chain[i], to: chain[i + 1], confidence: 0.9 });
  }
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/n0.ts"],
    includedFiles: chain,
    graphBundle: bundleWithEdges(edges),
    budget: { max_files: 3 },
  });
  assert.equal(scope.seed_files.length + scope.expanded_files.length <= 3, true);
  assert.match(scope.dropped_note ?? "", /budget/);
});

test("computeAuditScope: changed files outside the auditable set drop out", () => {
  const scope = computeAuditScope({
    since: "main",
    changed: ["README.md", "docs/guide.md"],
    includedFiles: ["src/a.ts"],
    graphBundle: bundleWithEdges([]),
  });
  assert.deepEqual(scope.seed_files, []);
  assert.deepEqual(scope.expanded_files, []);
  assert.match(scope.dropped_note ?? "", /No auditable files changed/);
});

test("computeAuditScope: two-hop expansion succeeds when accumulated confidence stays above the floor", () => {
  // 0.8 edges: one hop (0.8) > 0.5, two hops (0.64) > 0.5, three hops (0.512) > 0.5,
  // four hops (0.41) < 0.5 — so src/e.ts (four hops) must be excluded.
  const included = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
  const scope = computeAuditScope({
    since: "main",
    changed: ["src/a.ts"],
    includedFiles: included,
    graphBundle: bundleWithEdges([
      { from: "src/a.ts", to: "src/b.ts", confidence: 0.8 },
      { from: "src/b.ts", to: "src/c.ts", confidence: 0.8 },
      { from: "src/c.ts", to: "src/d.ts", confidence: 0.8 },
      { from: "src/d.ts", to: "src/e.ts", confidence: 0.8 },
    ]),
  });
  assert.equal(scope.mode, "delta");
  assert.deepEqual(scope.seed_files, ["src/a.ts"]);
  // One hop (0.8) clears 0.5 floor.
  assert.ok(scope.expanded_files.includes("src/b.ts"), "src/b.ts should be in expanded_files (1 hop, 0.8)");
  // Two hops (0.64) still clears 0.5 floor — the key assertion.
  assert.ok(scope.expanded_files.includes("src/c.ts"), "src/c.ts should be in expanded_files (2 hops, 0.64)");
  // Three hops (0.512) clears 0.5 floor.
  assert.ok(scope.expanded_files.includes("src/d.ts"), "src/d.ts should be in expanded_files (3 hops, 0.512)");
  // Four hops (0.41) drops below 0.5 floor — BFS stops here.
  assert.ok(!scope.expanded_files.includes("src/e.ts"), "src/e.ts should NOT be in expanded_files (4 hops, 0.41 < 0.5)");
});

test("resolveAuditScope: no --since → full audit", () => {
  const scope = resolveAuditScope({ root: ".", bundle: {} });
  assert.equal(scope.mode, "full");
  assert.equal(scope.since, null);
  assert.equal(scope.dropped_note, undefined);
});

test("resolveAuditScope: --since with no root falls back to full with a note", () => {
  const scope = resolveAuditScope({ since: "HEAD~1", bundle: {} });
  assert.equal(scope.mode, "full");
  assert.match(scope.dropped_note ?? "", /full audit/);
});

test("resolveAuditScope: real git repo — changed file + graph neighbour, mistyped ref → full", async (t) => {
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), "audit-scope-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
  } catch {
    t.skip("git is not available");
    return;
  }
  try {
    await writeFile(join(root, "a.ts"), "import './b';\nexport const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n");
    await writeFile(join(root, "c.ts"), "export const c = 3;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    // Modify one file in the working tree (uncommitted).
    await writeFile(join(root, "a.ts"), "import './b';\nexport const a = 99;\n");

    const bundle = {
      repo_manifest: {
        files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      },
      file_disposition: {
        files: [
          { path: "a.ts", status: "source" },
          { path: "b.ts", status: "source" },
          { path: "c.ts", status: "source" },
        ],
      },
      graph_bundle: {
        graphs: {
          imports: [
            {
              from: "a.ts",
              to: "b.ts",
              kind: "ts-import",
              direction: "directed",
              confidence: 0.9,
            },
          ],
          calls: [],
          references: [],
          routes: [],
        },
      },
    };

    const scope = resolveAuditScope({ root, since: "HEAD", bundle });
    assert.equal(scope.mode, "delta");
    assert.deepEqual(scope.seed_files, ["a.ts"]);
    assert.deepEqual(scope.expanded_files, ["b.ts"]);

    // A mistyped ref must not silently audit nothing — fall back to full.
    const fallback = resolveAuditScope({
      root,
      since: "definitely-not-a-ref",
      bundle,
    });
    assert.equal(fallback.mode, "full");
    assert.match(fallback.dropped_note ?? "", /could not be resolved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
