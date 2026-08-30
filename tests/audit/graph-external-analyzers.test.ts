import { test, expect } from "vitest";
import assert from "node:assert/strict";
import type { RepoManifest } from "../../src/audit/types.js";
import type { GraphBundle, GraphEdge } from "../../src/shared/index.js";

const { buildGraphBundle } = await import(
  "../../src/audit/extractors/graph.js"
);
const { deriveGraphSignals } = await import(
  "../../src/audit/extractors/graphSignals.js"
);
const { GraphBundleSchema } = await import("../../src/shared/index.js");
const { normalizeGenericExternalEdges } = await import(
  "../../src/shared/analyzers/normalizeExternal.js"
);

function manifest(paths: string[]): RepoManifest {
  return {
    repository: { name: "graph-external-analyzers", root: "/repo" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: paths.map((p) => ({
      path: p,
      size_bytes: 10,
      language: "typescript",
      excluded: false,
    })),
  };
}

function analyzerEdgesFor(bundle: GraphBundle): GraphEdge[] {
  return (bundle.graphs.references ?? []).filter(
    (e) => e.kind === "analyzer-dataflow-edge",
  );
}

// ---- normalizeGenericExternalEdges: degrade-to-empty + deterministic ----

test("normalizeGenericExternalEdges drops malformed entries and never throws", () => {
  const out = normalizeGenericExternalEdges([
    { from: "a.ts", to: "b.ts" },
    { from: "a.ts" }, // missing to
    { to: "b.ts" }, // missing from
    { from: "x", to: "x" }, // self-edge
    // @ts-expect-error — deliberate malformed entry exercises runtime degradation.
    null,
    // @ts-expect-error — deliberate malformed entry exercises runtime degradation.
    undefined,
    // @ts-expect-error — deliberate malformed entry exercises runtime degradation.
    42,
    { from: 1, to: 2 }, // non-string
  ]);
  expect(out.map((e) => [e.from, e.to])).toEqual([["a.ts", "b.ts"]]);
});

test("normalizeGenericExternalEdges dedupes and sorts deterministically", () => {
  const a = normalizeGenericExternalEdges([
    { from: "z.ts", to: "y.ts", kind: "k" },
    { from: "a.ts", to: "b.ts", kind: "k" },
    { from: "a.ts", to: "b.ts", kind: "k" }, // dup
    { from: "a.ts", to: "b.ts" }, // distinct kind (undefined)
  ]);
  const b = normalizeGenericExternalEdges([
    { from: "a.ts", to: "b.ts" },
    { from: "a.ts", to: "b.ts", kind: "k" },
    { from: "z.ts", to: "y.ts", kind: "k" },
  ]);
  expect(a, "input order does not affect output").toEqual(b);
  expect(a.map((e) => [e.from, e.to, e.kind ?? null])).toEqual([
    ["a.ts", "b.ts", null],
    ["a.ts", "b.ts", "k"],
    ["z.ts", "y.ts", "k"],
  ]);
});

test("normalizeGenericExternalEdges clamps confidence to [0,1]", () => {
  const out = normalizeGenericExternalEdges([
    { from: "a.ts", to: "b.ts", confidence: 5 },
    { from: "c.ts", to: "d.ts", confidence: -2 },
    { from: "e.ts", to: "f.ts", confidence: "nope" },
  ]);
  expect(out[0].confidence).toBe(1);
  expect(out[1].confidence).toBe(0);
  expect(out[2].confidence).toBe(undefined);
});

// ---- graph ingestion at extraction ----

test("external graph_edges enrich the language-neutral edge set, resolved + deterministic", () => {
  const bundle = buildGraphBundle(manifest(["src/a.ts", "src/b.ts"]), undefined, {
    externalAnalyzerResults: [{
      tool: "codeql",
      graph_edges: [
        { from: "src/a.ts", to: "src/b.ts", confidence: 0.9 },
        { from: "src/a.ts", to: "src/b.ts", confidence: 0.9 }, // dup collapses
      ],
      results: [],
    }],
  });
  const edges = analyzerEdgesFor(bundle);
  expect(edges.length).toBe(1);
  expect([edges[0].from, edges[0].to]).toEqual(["src/a.ts", "src/b.ts"]);
  expect(edges[0].confidence).toBe(0.9);
  expect(edges[0].direction).toBe("directed");
  // schema-valid
  assert.doesNotThrow(() => GraphBundleSchema.parse(bundle));
});

test("external graph_edges with unresolvable / self endpoints are dropped", () => {
  const bundle = buildGraphBundle(manifest(["src/a.ts"]), undefined, {
    externalAnalyzerResults: [{
      tool: "ast-grep",
      graph_edges: [
        { from: "src/a.ts", to: "vendor/out-of-tree.ts" }, // to unresolvable
        { from: "missing.ts", to: "src/a.ts" }, // from unresolvable
        { from: "src/a.ts", to: "src/a.ts" }, // self
      ],
      results: [],
    }],
  });
  expect(analyzerEdgesFor(bundle).length).toBe(0);
});

test("malformed graph_edges degrade to empty; build + deriveGraphSignals never throw", () => {
  let builtBundle: GraphBundle | undefined;
  assert.doesNotThrow(() => {
    builtBundle = buildGraphBundle(manifest(["src/a.ts"]), undefined, {
      externalAnalyzerResults: [{
        tool: "broken",
        // @ts-expect-error — deliberate wrong-typed payload exercises runtime degradation.
        graph_edges: "not-an-array",
        results: [],
      }],
    });
  });
  if (!builtBundle) throw new Error("graph bundle was not built");
  const bundle = builtBundle;
  expect(analyzerEdgesFor(bundle).length).toBe(0);
  assert.doesNotThrow(() => deriveGraphSignals(bundle));
});

test("deriveGraphSignals stays a pure reader and counts ingested analyzer edges in fan-in/out", () => {
  const bundle = buildGraphBundle(manifest(["src/a.ts", "src/b.ts"]), undefined, {
    externalAnalyzerResults: [{
      tool: "codeql",
      graph_edges: [{ from: "src/a.ts", to: "src/b.ts" }],
      results: [],
    }],
  });
  const before = JSON.stringify(bundle);
  const signals = deriveGraphSignals(bundle);
  expect(JSON.stringify(bundle), "deriveGraphSignals must not mutate the bundle").toBe(before);
  expect(signals.fanIn.get("src/b.ts")).toBe(1);
  expect(signals.fanOut.get("src/a.ts")).toBe(1);
});
