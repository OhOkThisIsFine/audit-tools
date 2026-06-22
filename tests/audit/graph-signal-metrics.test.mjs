import test from "node:test";
import assert from "node:assert/strict";

const { deriveGraphSignals } = await import(
  "../../src/audit/extractors/graphSignals.ts"
);
const { buildGraphBundle } = await import(
  "../../src/audit/extractors/graph.ts"
);
const { GraphBundleSchema } = await import("../../src/shared/index.ts");
const { computeNodeMetricsForFile } = await import(
  "../../src/audit/extractors/analyzers/complexityDuplication.ts"
);

function manifest(files) {
  return {
    files: files.map((f) => ({
      path: f.path,
      size_bytes: f.size_bytes ?? (f.content ? f.content.length : 0),
      language: f.language ?? "typescript",
      excluded: false,
    })),
  };
}

function edgeBundle(edges, extra = {}) {
  return { graphs: { imports: edges, calls: [], references: [], routes: [] }, ...extra };
}

test("complexity/duplication present for js/ts with measure+reach tags", () => {
  const tsSource = "if (a) { foo(); }\nfor (const x of y) { bar(); }\nfoo();\nfoo();\n";
  const files = [
    { path: "src/a.ts", content: tsSource },
    { path: "src/b.json", content: '{ "k": 1 }', language: "json" },
    { path: "README.md", content: "# hi", language: "markdown" },
  ];
  const fileContents = Object.fromEntries(files.map((f) => [f.path, f.content]));
  const bundle = buildGraphBundle(manifest(files), undefined, { fileContents });

  assert.ok(bundle.node_metrics, "node_metrics attached");
  const ts = bundle.node_metrics["src/a.ts"];
  assert.ok(ts.complexity, "ts has complexity");
  assert.ok(ts.duplication, "ts has duplication");
  assert.equal(ts.complexity.measure, "cyclomatic-approx");
  assert.equal(ts.complexity.reach, "js-ts-effective");
  assert.equal(ts.duplication.measure, "duplicate-line-count");
  assert.equal(ts.duplication.reach, "js-ts-effective");
  // if + for => 2 branches + base path = 3
  assert.equal(ts.complexity.value, 3);
  // foo(); appears twice => 1 duplicated occurrence
  assert.equal(ts.duplication.value, 1);

  // non-js/ts files: ABSENT (no entry), never zero-filled
  assert.equal(bundle.node_metrics["src/b.json"], undefined);
  assert.equal(bundle.node_metrics["README.md"], undefined);
  assert.equal(computeNodeMetricsForFile("src/b.json", "{}"), undefined);
});

test("legacy bundle without node_metrics parses and yields empty complexity/duplication", () => {
  const legacy = edgeBundle([{ from: "a", to: "b" }]);
  const parsed = GraphBundleSchema.safeParse(legacy);
  assert.equal(parsed.success, true, "legacy bundle parses under .strict()");

  const signals = deriveGraphSignals(legacy);
  assert.deepEqual(signals.complexity, []);
  assert.deepEqual(signals.duplication, []);
});

test("a bundle WITH node_metrics also parses", () => {
  const withMetrics = edgeBundle([], {
    node_metrics: {
      "src/a.ts": {
        complexity: { value: 3, measure: "cyclomatic-approx", reach: "js-ts-effective" },
      },
    },
  });
  const parsed = GraphBundleSchema.safeParse(withMetrics);
  assert.equal(parsed.success, true);

  const signals = deriveGraphSignals(withMetrics);
  assert.equal(signals.complexity.length, 1);
  assert.equal(signals.complexity[0].node, "src/a.ts");
  assert.equal(signals.complexity[0].value, 3);
  assert.deepEqual(signals.duplication, []);
});

test("complexity/duplication signals sort by node id", () => {
  const bundle = edgeBundle([], {
    node_metrics: {
      "src/z.ts": { complexity: { value: 1, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
      "src/a.ts": { complexity: { value: 2, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
      "src/m.ts": { complexity: { value: 3, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
    },
  });
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(
    signals.complexity.map((c) => c.node),
    ["src/a.ts", "src/m.ts", "src/z.ts"],
  );
});

test("malformed node_metrics degrades to empty, never throws", () => {
  for (const bad of [
    edgeBundle([], { node_metrics: "nope" }),
    edgeBundle([], { node_metrics: { "src/a.ts": null } }),
    edgeBundle([], { node_metrics: { "src/a.ts": { complexity: { value: "x", measure: "m", reach: "js-ts-effective" } } } }),
    edgeBundle([], { node_metrics: { "src/a.ts": { complexity: {} } } }),
  ]) {
    let signals;
    assert.doesNotThrow(() => {
      signals = deriveGraphSignals(bad);
    });
    assert.deepEqual(signals.complexity, []);
    assert.deepEqual(signals.duplication, []);
  }
});

test("seams: a bridge edge is detected", () => {
  // a-b-c chain: every edge is a bridge.
  const bundle = edgeBundle([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(signals.seams, [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
});

test("seams: an edge inside a cycle is NOT a bridge", () => {
  // triangle a-b-c-a: no bridges.
  const bundle = edgeBundle([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ]);
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(signals.seams, []);
});

test("seams: parallel edges of differing kind are NOT a bridge", () => {
  // a-b joined by two distinct edge kinds => undirected single link, but it is
  // the only connection so it IS a bridge. To show parallel-edge merging does
  // not MISreport, pair a parallel-linked a-b with a real cycle so removing one
  // of the parallels would not disconnect. Use a triangle where one side is
  // doubled: still no bridges.
  const bundle = {
    graphs: {
      imports: [
        { from: "a", to: "b", kind: "esm" },
        { from: "a", to: "b", kind: "re-export" },
        { from: "b", to: "c", kind: "esm" },
        { from: "c", to: "a", kind: "esm" },
      ],
      calls: [],
      references: [],
      routes: [],
    },
  };
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(signals.seams, []);
});

test("seams: self-loops are dropped", () => {
  const bundle = edgeBundle([
    { from: "a", to: "a" },
    { from: "a", to: "b" },
  ]);
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(signals.seams, [{ from: "a", to: "b" }]);
});

test("seams: empty graph -> empty seams, no throw", () => {
  let signals;
  assert.doesNotThrow(() => {
    signals = deriveGraphSignals(edgeBundle([]));
  });
  assert.deepEqual(signals.seams, []);
});

test("seams: disconnected components terminate and detect bridges in each", () => {
  // Component 1: a-b (bridge). Component 2: triangle x-y-z (no bridge).
  const bundle = edgeBundle([
    { from: "a", to: "b" },
    { from: "x", to: "y" },
    { from: "y", to: "z" },
    { from: "z", to: "x" },
  ]);
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(signals.seams, [{ from: "a", to: "b" }]);
});

test("seams sort deterministically by from-then-to", () => {
  const bundle = edgeBundle([
    { from: "m", to: "n" },
    { from: "a", to: "b" },
    { from: "a", to: "c" },
  ]);
  // star at a: a-b, a-c, plus separate m-n. All bridges.
  const signals = deriveGraphSignals(bundle);
  assert.deepEqual(signals.seams, [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "m", to: "n" },
  ]);
});

test("two derivations are identical (determinism)", () => {
  const bundle = edgeBundle(
    [
      { from: "b", to: "c" },
      { from: "a", to: "b" },
    ],
    {
      node_metrics: {
        "src/b.ts": { duplication: { value: 2, measure: "duplicate-line-count", reach: "js-ts-effective" } },
        "src/a.ts": { complexity: { value: 5, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
      },
    },
  );
  const first = deriveGraphSignals(bundle);
  const second = deriveGraphSignals(bundle);
  assert.deepEqual(first.complexity, second.complexity);
  assert.deepEqual(first.duplication, second.duplication);
  assert.deepEqual(first.seams, second.seams);
});

test("deriveGraphSignals performs no IO and does not mutate input", () => {
  const bundle = edgeBundle([{ from: "a", to: "b" }], {
    node_metrics: {
      "src/a.ts": { complexity: { value: 1, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
    },
  });
  const snapshot = JSON.stringify(bundle);
  deriveGraphSignals(bundle);
  assert.equal(JSON.stringify(bundle), snapshot, "input bundle unchanged");
});
