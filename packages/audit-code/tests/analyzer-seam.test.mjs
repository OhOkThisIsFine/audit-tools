import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mergeAnalyzerEdges } = await import(
  "../dist/extractors/analyzers/merge.js"
);
const { runGraphEnrichmentExecutor } = await import(
  "../dist/orchestrator/graphEnrichmentExecutor.js"
);
const { resolveAnalyzerPlan, needsInstallDecision } = await import(
  "../dist/extractors/analyzers/registry.js"
);
const { typescriptAnalyzer } = await import(
  "../dist/extractors/analyzers/typescript.js"
);

function floorGraph(imports = []) {
  return { graphs: { imports, calls: [], references: [], routes: [] } };
}

function tsBundle(extra = {}) {
  return {
    repo_manifest: {
      files: [
        { path: "src/a.ts", size_bytes: 32, language: "typescript", excluded: false },
        { path: "src/b.ts", size_bytes: 32, language: "typescript", excluded: false },
      ],
    },
    file_disposition: { files: [] },
    graph_bundle: floorGraph([
      { from: "src/a.ts", to: "src/b.ts", kind: "esm", confidence: 0.95, direction: "directed" },
    ]),
    ...extra,
  };
}

// A fake analyzer with no dependency (always resolvable) used to exercise the
// seam without touching the TypeScript compiler.
const fakeAnalyzer = {
  id: "fake",
  supports: (file) => file.endsWith(".ts"),
  analyze: () => ({
    edges: [
      { from: "src/a.ts", to: "src/b.ts", kind: "ts-import", confidence: 0.99, direction: "directed" },
    ],
  }),
};

test("mergeAnalyzerEdges: analyzer import edge supersedes the regex floor for the same (from,to)", () => {
  const floor = [
    { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.95 },
    { from: "a.ts", to: "lib", kind: "heuristic-container-edge", confidence: 0.25 },
  ];
  const analyzer = [{ from: "a.ts", to: "b.ts", kind: "ts-import", confidence: 0.99 }];
  const merged = mergeAnalyzerEdges(floor, analyzer);

  const ab = merged.filter((e) => e.from === "a.ts" && e.to === "b.ts");
  assert.equal(ab.length, 1, "import-group edges collapse to one");
  assert.equal(ab[0].kind, "ts-import", "higher-confidence analyzer edge wins");
  assert.ok(
    merged.some((e) => e.kind === "heuristic-container-edge"),
    "ungrouped floor kinds survive the merge",
  );
});

test("mergeAnalyzerEdges: distinct ungrouped kinds between the same nodes both survive", () => {
  const floor = [
    { from: "a", to: "b", kind: "heuristic-auth-session-link", confidence: 0.55 },
    { from: "a", to: "b", kind: "test-source-link", confidence: 0.88 },
  ];
  const merged = mergeAnalyzerEdges(floor, []);
  assert.equal(merged.length, 2);
});

test("runGraphEnrichmentExecutor merges analyzer edges and records provenance", async () => {
  const result = await runGraphEnrichmentExecutor(tsBundle(), {
    root: "/virtual/root",
    registry: [fakeAnalyzer],
  });

  assert.deepEqual(result.updated.graph_bundle.analyzers_used, ["fake"]);
  assert.equal(result.updated.analyzer_capability.status, "applied");
  const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "fake");
  assert.equal(entry.resolution, "repo");
  assert.equal(entry.edges_added, 1);

  const ab = result.updated.graph_bundle.graphs.imports.filter(
    (e) => e.from === "src/a.ts" && e.to === "src/b.ts",
  );
  assert.equal(ab.length, 1);
  assert.equal(ab[0].kind, "ts-import");

  assert.ok(result.artifacts_written.includes("graph_bundle.json"));
  assert.ok(result.artifacts_written.includes("analyzer_capability.json"));
});

test("runGraphEnrichmentExecutor omits and leaves the floor byte-identical when the dep is absent", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "analyzer-cache-"));
  const root = await mkdtemp(join(tmpdir(), "analyzer-root-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");

    const bundle = tsBundle();
    const floorJson = JSON.stringify(bundle.graph_bundle);

    const result = await runGraphEnrichmentExecutor(bundle, {
      root,
      registry: [typescriptAnalyzer],
      cacheRoot,
      analyzers: { typescript: "auto" },
    });

    assert.equal(result.updated.analyzer_capability.status, "omitted");
    assert.equal(result.updated.graph_bundle.analyzers_used, undefined);
    assert.equal(
      JSON.stringify(result.updated.graph_bundle),
      floorJson,
      "regex floor is unchanged when the analyzer is absent",
    );
    assert.deepEqual(result.artifacts_written, ["analyzer_capability.json"]);
    const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "typescript");
    assert.equal(entry.resolution, "absent");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("runGraphEnrichmentExecutor records not_applicable when no in-scope files are supported", async () => {
  const bundle = {
    repo_manifest: {
      files: [{ path: "infra/deploy.yml", size_bytes: 20, language: "yaml", excluded: false }],
    },
    file_disposition: { files: [] },
    graph_bundle: floorGraph(),
  };
  const result = await runGraphEnrichmentExecutor(bundle, {
    root: "/virtual/root",
    registry: [typescriptAnalyzer],
  });
  assert.equal(result.updated.analyzer_capability.status, "omitted");
  const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "typescript");
  assert.equal(entry.resolution, "not_applicable");
});

test("resolveAnalyzerPlan flags an auto+absent analyzer with in-scope files for an install decision", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "analyzer-cache-"));
  const root = await mkdtemp(join(tmpdir(), "analyzer-root-"));
  try {
    const plan = resolveAnalyzerPlan(root, undefined, ["src/a.ts"], { cacheRoot });
    const ts = plan.find((p) => p.id === "typescript");
    assert.equal(ts.setting, "auto");
    assert.equal(ts.resolution, "absent");
    assert.equal(ts.supportedCount, 1);
    assert.equal(needsInstallDecision(ts), true);

    // No supported files → not_applicable → never proposes an install.
    const empty = resolveAnalyzerPlan(root, undefined, ["README.md"], { cacheRoot }).find(
      (p) => p.id === "typescript",
    );
    assert.equal(empty.resolution, "not_applicable");
    assert.equal(needsInstallDecision(empty), false);

    // Explicit skip is decisive (no prompt).
    const skipped = resolveAnalyzerPlan(root, { typescript: "skip" }, ["src/a.ts"], {
      cacheRoot,
    }).find((p) => p.id === "typescript");
    assert.equal(skipped.resolution, "skip");
    assert.equal(needsInstallDecision(skipped), false);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
