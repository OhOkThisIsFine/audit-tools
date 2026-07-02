import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { buildGraphBundle } = await import(
  "../../src/audit/extractors/graph.ts"
);
const { deriveGraphSignals } = await import(
  "../../src/audit/extractors/graphSignals.ts"
);
const { GraphBundleSchema } = await import("../../src/shared/index.ts");
const { normalizeGenericExternalEdges } = await import(
  "../../src/audit/adapters/normalizeExternal.ts"
);
const { normalizeSemgrepDataflowJson } = await import(
  "../../src/audit/adapters/semgrep.ts"
);
const { normalizeAstGrepJson } = await import(
  "../../src/audit/adapters/astGrep.ts"
);
const { normalizeCodeqlSarif } = await import(
  "../../src/audit/adapters/codeql.ts"
);

function manifest(paths) {
  return {
    files: paths.map((p) => ({
      path: p,
      size_bytes: 10,
      language: "typescript",
      excluded: false,
    })),
  };
}

function analyzerEdgesFor(bundle) {
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
    null,
    undefined,
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
  let bundle;
  assert.doesNotThrow(() => {
    bundle = buildGraphBundle(manifest(["src/a.ts"]), undefined, {
      externalAnalyzerResults: [{
        tool: "broken",
        graph_edges: "not-an-array",
        results: [],
      }],
    });
  });
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

// ---- adapter wrappers normalize native fixture output ----

test("normalizeSemgrepDataflowJson maps source→sink trace to an edge", () => {
  const out = normalizeSemgrepDataflowJson({
    results: [
      {
        check_id: "taint.rule",
        extra: {
          dataflow_trace: {
            taint_source: { location: { path: "src/source.ts" } },
            taint_sink: { location: { path: "src/sink.ts" } },
          },
        },
      },
      { extra: {} }, // no trace → dropped
    ],
  });
  expect(out.tool).toBe("semgrep-dataflow");
  expect(out.graph_edges.map((e) => [e.from, e.to])).toEqual([["src/source.ts", "src/sink.ts"]]);
});

test("normalizeSemgrepDataflowJson degrades to empty on malformed input", () => {
  assert.doesNotThrow(() => normalizeSemgrepDataflowJson({}));
  expect(normalizeSemgrepDataflowJson({}).graph_edges).toEqual([]);
  expect(normalizeSemgrepDataflowJson({ results: [{}, null] }).graph_edges).toEqual([]);
});

test("normalizeAstGrepJson maps file→captured target", () => {
  const out = normalizeAstGrepJson([
    {
      file: "src/a.ts",
      ruleId: "links",
      metaVariables: { single: { TARGET: { text: "src/b.ts" } } },
    },
    { file: "src/a.ts" }, // no target capture → dropped
  ]);
  expect(out.tool).toBe("ast-grep");
  expect(out.graph_edges.map((e) => [e.from, e.to])).toEqual([["src/a.ts", "src/b.ts"]]);
});

test("normalizeAstGrepJson degrades to empty on malformed input", () => {
  assert.doesNotThrow(() => normalizeAstGrepJson(undefined));
  expect(normalizeAstGrepJson(undefined).graph_edges).toEqual([]);
  expect(normalizeAstGrepJson([null, 1, {}]).graph_edges).toEqual([]);
});

test("normalizeCodeqlSarif maps first→last threadFlow location", () => {
  const out = normalizeCodeqlSarif({
    runs: [
      {
        results: [
          {
            ruleId: "js/sql-injection",
            codeFlows: [
              {
                threadFlows: [
                  {
                    locations: [
                      {
                        location: {
                          physicalLocation: {
                            artifactLocation: { uri: "src/source.ts" },
                          },
                        },
                      },
                      {
                        location: {
                          physicalLocation: {
                            artifactLocation: { uri: "src/mid.ts" },
                          },
                        },
                      },
                      {
                        location: {
                          physicalLocation: {
                            artifactLocation: { uri: "src/sink.ts" },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(out.tool).toBe("codeql");
  expect(out.graph_edges.map((e) => [e.from, e.to])).toEqual([["src/source.ts", "src/sink.ts"]]);
});

test("normalizeCodeqlSarif degrades to empty on malformed SARIF", () => {
  assert.doesNotThrow(() => normalizeCodeqlSarif({}));
  expect(normalizeCodeqlSarif({}).graph_edges).toEqual([]);
  expect(normalizeCodeqlSarif({ runs: [{ results: [{ codeFlows: [{}] }] }] })
      .graph_edges).toEqual([]);
});

// ---- end-to-end: adapter output feeds the graph extractor ----

test("codeql adapter output drives graph extraction end-to-end", () => {
  const analyzer = normalizeCodeqlSarif({
    runs: [
      {
        results: [
          {
            ruleId: "js/sqli",
            codeFlows: [
              {
                threadFlows: [
                  {
                    locations: [
                      {
                        location: {
                          physicalLocation: {
                            artifactLocation: { uri: "src/a.ts" },
                          },
                        },
                      },
                      {
                        location: {
                          physicalLocation: {
                            artifactLocation: { uri: "src/b.ts" },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const bundle = buildGraphBundle(manifest(["src/a.ts", "src/b.ts"]), undefined, {
    externalAnalyzerResults: [analyzer],
  });
  expect(analyzerEdgesFor(bundle).map((e) => [e.from, e.to])).toEqual([["src/a.ts", "src/b.ts"]]);
});
