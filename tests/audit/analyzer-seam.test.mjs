import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mergeAnalyzerEdges } = await import("../../src/audit/extractors/analyzers/merge.ts");
const { runGraphEnrichmentExecutor } = await import("../../src/audit/orchestrator/graphEnrichmentExecutor.ts");
const { resolveAnalyzerPlan, needsInstallDecision } = await import("../../src/audit/extractors/analyzers/registry.ts");
const { typescriptAnalyzer } = await import("../../src/audit/extractors/analyzers/typescript.ts");

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
  expect(ab.length, "import-group edges collapse to one").toBe(1);
  expect(ab[0].kind, "higher-confidence analyzer edge wins").toBe("ts-import");
  expect(merged.some((e) => e.kind === "heuristic-container-edge"), "ungrouped floor kinds survive the merge").toBeTruthy();
});

test("mergeAnalyzerEdges: distinct ungrouped kinds between the same nodes both survive", () => {
  const floor = [
    { from: "a", to: "b", kind: "heuristic-auth-session-link", confidence: 0.55 },
    { from: "a", to: "b", kind: "test-source-link", confidence: 0.88 },
  ];
  const merged = mergeAnalyzerEdges(floor, []);
  expect(merged.length).toBe(2);
});

test("runGraphEnrichmentExecutor merges analyzer edges and records provenance", async () => {
  const result = await runGraphEnrichmentExecutor(tsBundle(), {
    root: "/virtual/root",
    registry: [fakeAnalyzer],
  });

  expect(result.updated.graph_bundle.analyzers_used).toEqual(["fake"]);
  expect(result.updated.analyzer_capability.status).toBe("applied");
  const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "fake");
  expect(entry.resolution).toBe("repo");
  expect(entry.edges_added).toBe(1);

  const ab = result.updated.graph_bundle.graphs.imports.filter(
    (e) => e.from === "src/a.ts" && e.to === "src/b.ts",
  );
  expect(ab.length).toBe(1);
  expect(ab[0].kind).toBe("ts-import");

  expect(result.artifacts_written.includes("graph_bundle.json")).toBeTruthy();
  expect(result.artifacts_written.includes("analyzer_capability.json")).toBeTruthy();
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

    expect(result.updated.analyzer_capability.status).toBe("omitted");
    expect(result.updated.graph_bundle.analyzers_used).toBe(undefined);
    expect(JSON.stringify(result.updated.graph_bundle), "regex floor is unchanged when the analyzer is absent").toBe(floorJson);
    expect(result.artifacts_written).toEqual(["analyzer_capability.json"]);
    const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "typescript");
    expect(entry.resolution).toBe("absent");
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
  expect(result.updated.analyzer_capability.status).toBe("omitted");
  const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "typescript");
  expect(entry.resolution).toBe("not_applicable");
});

// Tests for the extracted runSingleAnalyzer / buildEnrichedGraph helpers —
// exercised through the public runGraphEnrichmentExecutor API.

test("runSingleAnalyzer (via executor): returns ok:false with note when dependency is absent", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "absent-cache-"));
  const root = await mkdtemp(join(tmpdir(), "absent-root-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");

    const result = await runGraphEnrichmentExecutor(tsBundle(), {
      root,
      registry: [typescriptAnalyzer],
      cacheRoot,
      analyzers: { typescript: "auto" },
    });

    const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "typescript");
    expect(entry.resolution, "absent dep → ok:false with resolution absent").toBe("absent");
    expect(entry.edges_added, "no edges added for absent dep").toBe(0);
    // analyze() should not have contributed any edge
    expect(result.updated.analyzer_capability.status).toBe("omitted");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("runSingleAnalyzer (via executor): returns ok:false with structured note when analyze() throws", async () => {
  const throwingAnalyzer = {
    id: "throwing",
    supports: (file) => file.endsWith(".ts"),
    analyze: () => { throw new TypeError("Deliberate test failure"); },
  };

  const result = await runGraphEnrichmentExecutor(tsBundle(), {
    root: "/virtual/root",
    registry: [throwingAnalyzer],
  });

  const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "throwing");
  expect(entry.note, "note should be populated on analyzer error").toBeTruthy();
  expect(entry.note.includes("TypeError"), "note should include error name").toBeTruthy();
  expect(entry.note.includes("Deliberate test failure"), "note should include error message").toBeTruthy();
  expect(entry.edges_added).toBe(0);
});

test("buildEnrichedGraph (via executor): merges edges into correct buckets and deduplicates routes", async () => {
  const routeAnalyzer = {
    id: "route-emit",
    supports: () => true,
    analyze: () => ({
      edges: [
        { from: "src/a.ts", to: "src/b.ts", kind: "ts-import", confidence: 0.99, direction: "directed" },
        { from: "src/a.ts", to: "src/b.ts", kind: "ts-call", confidence: 0.95, direction: "directed" },
      ],
      routes: [
        { method: "GET", path: "/foo", handler: "src/a.ts" },
        { method: "GET", path: "/foo", handler: "src/a.ts" }, // duplicate — should deduplicate
      ],
    }),
  };

  const result = await runGraphEnrichmentExecutor(tsBundle(), {
    root: "/virtual/root",
    registry: [routeAnalyzer],
  });

  const gb = result.updated.graph_bundle;
  expect(gb.graphs.imports.some((e) => e.kind === "ts-import"), "ts-import edges in imports bucket").toBeTruthy();
  expect(gb.graphs.calls.some((e) => e.kind === "ts-call"), "ts-call edges in calls bucket").toBeTruthy();
  const routes = gb.graphs.routes;
  expect(Array.isArray(routes), "routes should be an array").toBeTruthy();
  const fooRoutes = routes.filter((r) => r.path === "/foo" && r.method === "GET");
  expect(fooRoutes.length, "duplicate routes are deduplicated").toBe(1);
  expect(gb.analyzers_used).toEqual(["route-emit"]);
});

test("runGraphEnrichmentExecutor loop: not_applicable analyzers record capability entry and skip analyze()", async () => {
  let analyzeCalled = false;
  const neverSupportedAnalyzer = {
    id: "never-supported",
    supports: () => false,
    analyze: () => { analyzeCalled = true; return { edges: [] }; },
  };

  const bundle = {
    repo_manifest: {
      files: [{ path: "src/a.ts", size_bytes: 10, language: "typescript", excluded: false }],
    },
    file_disposition: { files: [] },
    graph_bundle: floorGraph(),
  };
  const floorJson = JSON.stringify(bundle.graph_bundle);

  const result = await runGraphEnrichmentExecutor(bundle, {
    root: "/virtual/root",
    registry: [neverSupportedAnalyzer],
  });

  const entry = result.updated.analyzer_capability.analyzers.find((a) => a.id === "never-supported");
  expect(entry.resolution).toBe("not_applicable");
  expect(analyzeCalled, "analyze() must not be called for not_applicable analyzers").toBe(false);
  // Graph bundle must be byte-identical to the floor
  expect(JSON.stringify(result.updated.graph_bundle)).toBe(floorJson);
});

test("resolveAnalyzerPlan flags an auto+absent analyzer with in-scope files for an install decision", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "analyzer-cache-"));
  const root = await mkdtemp(join(tmpdir(), "analyzer-root-"));
  try {
    const plan = resolveAnalyzerPlan(root, undefined, ["src/a.ts"], { cacheRoot });
    const ts = plan.find((p) => p.id === "typescript");
    expect(ts.setting).toBe("auto");
    expect(ts.resolution).toBe("absent");
    expect(ts.supportedCount).toBe(1);
    expect(needsInstallDecision(ts)).toBe(true);

    // No supported files → not_applicable → never proposes an install.
    const empty = resolveAnalyzerPlan(root, undefined, ["README.md"], { cacheRoot }).find(
      (p) => p.id === "typescript",
    );
    expect(empty.resolution).toBe("not_applicable");
    expect(needsInstallDecision(empty)).toBe(false);

    // Explicit skip is decisive (no prompt).
    const skipped = resolveAnalyzerPlan(root, { typescript: "skip" }, ["src/a.ts"], {
      cacheRoot,
    }).find((p) => p.id === "typescript");
    expect(skipped.resolution).toBe("skip");
    expect(needsInstallDecision(skipped)).toBe(false);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
