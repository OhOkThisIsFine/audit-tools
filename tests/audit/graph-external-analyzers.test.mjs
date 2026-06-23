import test from "node:test";
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
  assert.deepEqual(
    out.map((e) => [e.from, e.to]),
    [["a.ts", "b.ts"]],
  );
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
  assert.deepEqual(a, b, "input order does not affect output");
  assert.deepEqual(a.map((e) => [e.from, e.to, e.kind ?? null]), [
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
  assert.equal(out[0].confidence, 1);
  assert.equal(out[1].confidence, 0);
  assert.equal(out[2].confidence, undefined);
});

// ---- graph ingestion at extraction ----

test("external graph_edges enrich the language-neutral edge set, resolved + deterministic", () => {
  const bundle = buildGraphBundle(manifest(["src/a.ts", "src/b.ts"]), undefined, {
    externalAnalyzerResults: {
      tool: "codeql",
      graph_edges: [
        { from: "src/a.ts", to: "src/b.ts", confidence: 0.9 },
        { from: "src/a.ts", to: "src/b.ts", confidence: 0.9 }, // dup collapses
      ],
      results: [],
    },
  });
  const edges = analyzerEdgesFor(bundle);
  assert.equal(edges.length, 1);
  assert.deepEqual([edges[0].from, edges[0].to], ["src/a.ts", "src/b.ts"]);
  assert.equal(edges[0].confidence, 0.9);
  assert.equal(edges[0].direction, "directed");
  // schema-valid
  assert.doesNotThrow(() => GraphBundleSchema.parse(bundle));
});

test("external graph_edges with unresolvable / self endpoints are dropped", () => {
  const bundle = buildGraphBundle(manifest(["src/a.ts"]), undefined, {
    externalAnalyzerResults: {
      tool: "ast-grep",
      graph_edges: [
        { from: "src/a.ts", to: "vendor/out-of-tree.ts" }, // to unresolvable
        { from: "missing.ts", to: "src/a.ts" }, // from unresolvable
        { from: "src/a.ts", to: "src/a.ts" }, // self
      ],
      results: [],
    },
  });
  assert.equal(analyzerEdgesFor(bundle).length, 0);
});

test("malformed graph_edges degrade to empty; build + deriveGraphSignals never throw", () => {
  let bundle;
  assert.doesNotThrow(() => {
    bundle = buildGraphBundle(manifest(["src/a.ts"]), undefined, {
      externalAnalyzerResults: {
        tool: "broken",
        graph_edges: "not-an-array",
        results: [],
      },
    });
  });
  assert.equal(analyzerEdgesFor(bundle).length, 0);
  assert.doesNotThrow(() => deriveGraphSignals(bundle));
});

test("deriveGraphSignals stays a pure reader and counts ingested analyzer edges in fan-in/out", () => {
  const bundle = buildGraphBundle(manifest(["src/a.ts", "src/b.ts"]), undefined, {
    externalAnalyzerResults: {
      tool: "codeql",
      graph_edges: [{ from: "src/a.ts", to: "src/b.ts" }],
      results: [],
    },
  });
  const before = JSON.stringify(bundle);
  const signals = deriveGraphSignals(bundle);
  assert.equal(JSON.stringify(bundle), before, "deriveGraphSignals must not mutate the bundle");
  assert.equal(signals.fanIn.get("src/b.ts"), 1);
  assert.equal(signals.fanOut.get("src/a.ts"), 1);
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
  assert.equal(out.tool, "semgrep-dataflow");
  assert.deepEqual(
    out.graph_edges.map((e) => [e.from, e.to]),
    [["src/source.ts", "src/sink.ts"]],
  );
});

test("normalizeSemgrepDataflowJson degrades to empty on malformed input", () => {
  assert.doesNotThrow(() => normalizeSemgrepDataflowJson({}));
  assert.deepEqual(normalizeSemgrepDataflowJson({}).graph_edges, []);
  assert.deepEqual(
    normalizeSemgrepDataflowJson({ results: [{}, null] }).graph_edges,
    [],
  );
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
  assert.equal(out.tool, "ast-grep");
  assert.deepEqual(
    out.graph_edges.map((e) => [e.from, e.to]),
    [["src/a.ts", "src/b.ts"]],
  );
});

test("normalizeAstGrepJson degrades to empty on malformed input", () => {
  assert.doesNotThrow(() => normalizeAstGrepJson(undefined));
  assert.deepEqual(normalizeAstGrepJson(undefined).graph_edges, []);
  assert.deepEqual(normalizeAstGrepJson([null, 1, {}]).graph_edges, []);
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
  assert.equal(out.tool, "codeql");
  assert.deepEqual(
    out.graph_edges.map((e) => [e.from, e.to]),
    [["src/source.ts", "src/sink.ts"]],
  );
});

test("normalizeCodeqlSarif degrades to empty on malformed SARIF", () => {
  assert.doesNotThrow(() => normalizeCodeqlSarif({}));
  assert.deepEqual(normalizeCodeqlSarif({}).graph_edges, []);
  assert.deepEqual(
    normalizeCodeqlSarif({ runs: [{ results: [{ codeFlows: [{}] }] }] })
      .graph_edges,
    [],
  );
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
    externalAnalyzerResults: analyzer,
  });
  assert.deepEqual(
    analyzerEdgesFor(bundle).map((e) => [e.from, e.to]),
    [["src/a.ts", "src/b.ts"]],
  );
});
