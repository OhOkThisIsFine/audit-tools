import { test, expect } from "vitest";
import assert from "node:assert/strict";
import type { GraphSignals } from "../../src/audit/extractors/graphSignals.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest, edgeBundle } from "./test-helpers.js";

const { deriveGraphSignals } = await import(
  "../../src/audit/extractors/graphSignals.js"
);
const { buildGraphBundle, buildGraphBundleFromFs } = await import(
  "../../src/audit/extractors/graph.js"
);
const { GraphBundleSchema } = await import("../../src/shared/index.js");
const { computeNodeMetricsForFile, loadFunctionComplexityParsers } = await import(
  "../../src/audit/extractors/analyzers/complexityDuplication.js"
);


test("complexity/duplication present for js/ts with measure+reach tags", () => {
  const tsSource = "if (a) { foo(); }\nfor (const x of y) { bar(); }\nfoo();\nfoo();\n";
  const files = [
    { path: "src/a.ts", content: tsSource },
    { path: "src/b.json", content: '{ "k": 1 }', language: "json" },
    { path: "README.md", content: "# hi", language: "markdown" },
  ];
  const fileContents = Object.fromEntries(files.map((f) => [f.path, f.content]));
  const bundle = buildGraphBundle(manifest(files), undefined, { fileContents });

  expect(bundle.node_metrics, "node_metrics attached").toBeTruthy();
  const ts = bundle.node_metrics!["src/a.ts"];
  expect(ts.complexity, "ts has complexity").toBeTruthy();
  expect(ts.duplication, "ts has duplication").toBeTruthy();
  // No parser handed to the synchronous build: the lexical file-level proxy.
  expect(ts.complexity!.measure).toBe("cyclomatic-approx-file");
  expect(ts.complexity!.reach).toBe("js-ts-effective");
  expect(ts.duplication!.measure).toBe("duplicate-block-lines");
  expect(ts.duplication!.reach).toBe("js-ts-effective");
  // if + for => 2 branches + base path = 3
  expect(ts.complexity!.value).toBe(3);
  // `foo();` repeats as a single LINE, never as a block: no duplicated code.
  expect(ts.duplication!.value).toBe(0);

  // non-js/ts files: ABSENT (no entry), never zero-filled
  expect(bundle.node_metrics!["src/b.json"]).toBe(undefined);
  expect(bundle.node_metrics!["README.md"]).toBe(undefined);
  expect(computeNodeMetricsForFile("src/b.json", "{}")).toBe(undefined);
});

// Dogfood (2026-11-04): the per-line measure flagged 1147 of 1285 js/ts files,
// because every file repeats a closing `});`, a `/**`, a `try {`. A repeated
// LINE is not duplicated code; a repeated BLOCK is.
test("duplication counts repeated blocks, never repeated boilerplate lines", () => {
  const boilerplate = [
    "describe('x', () => {",
    "  it('a', () => {",
    "    try {",
    "      run(1);",
    "    } finally {",
    "      cleanup();",
    "    }",
    "  });",
    "  it('b', () => {",
    "    try {",
    "      other(2);",
    "    } finally {",
    "      cleanup();",
    "    }",
    "  });",
    "});",
  ].join("\n");
  expect(computeNodeMetricsForFile("t.test.ts", boilerplate)!.duplication!.value).toBe(0);

  const block = [
    "const a = load(path);",
    "if (!a) throw new Error('missing');",
    "const b = parse(a);",
    "validate(b, schema);",
    "return normalize(b);",
  ];
  const cloned = ["function f() {", ...block, "}", "function g() {", ...block, "}"].join("\n");
  // The second copy of the five-line block is duplicated; the first is the original.
  expect(computeNodeMetricsForFile("c.ts", cloned)!.duplication!.value).toBe(block.length);

  // A shorter repeated run is below the block size and is not a clone.
  const short = ["function f() {", ...block.slice(0, 4), "}", "function g() {", ...block.slice(0, 4), "}"].join("\n");
  expect(computeNodeMetricsForFile("s.ts", short)!.duplication!.value).toBe(0);
});

// Dogfood (2026-11-04): the hotspot threshold (10, McCabe's per-function limit)
// was compared against a branch count summed over the WHOLE file, so any file
// with a handful of small functions became a hotspot (752 of 1285 files).
test("complexity is the highest per-function cyclomatic number when function boundaries are parsed", async () => {
  const parsers = await loadFunctionComplexityParsers();
  try {
    expect(parsers.typescript, "the tree-sitter typescript grammar ships as a runtime dependency").toBeDefined();
    const sixBranches = (name: string) =>
      `function ${name}(a?: number) {\n` +
      "  if (a) {} else if (b) {}\n" +
      "  for (const x of y) {}\n" +
      "  while (c && d) {}\n" +
      "  return e ? 1 : 2;\n" +
      "}\n";
    const source =
      sixBranches("f") +
      sixBranches("g") +
      // The nested arrow's branches are its own, never its parent's.
      "function outer() { const inner = () => { if (p) {} if (q) {} if (r) {} }; return inner; }\n" +
      // Branch words inside strings and comments are not branches.
      "const s = 'if (x) for (y) while (z) && ||'; // if if if\n";
    const metric = computeNodeMetricsForFile("src/a.ts", source, parsers)!.complexity!;
    expect(metric.measure).toBe("cyclomatic-max-function");
    // f and g each: if, else-if, for, while, &&, ternary = 6 decisions + 1.
    expect(metric.value).toBe(7);
    // The lexical proxy sums the whole file, string, comment and `?:` included.
    const proxy = computeNodeMetricsForFile("src/a.ts", source)!.complexity!;
    expect(proxy.measure).toBe("cyclomatic-approx-file");
    expect(proxy.value).toBeGreaterThan(14);

    // .js and .tsx files parse with their own grammars.
    expect(computeNodeMetricsForFile("src/b.js", sixBranches("h").replace("a?: number", "a"), parsers)!.complexity!.value).toBe(7);
    expect(computeNodeMetricsForFile("src/c.tsx", sixBranches("k"), parsers)!.complexity!.measure).toBe("cyclomatic-max-function");
  } finally {
    for (const parser of Object.values(parsers)) parser?.delete();
  }
});

test("the filesystem graph build measures complexity per function", async () => {
  const root = mkdtempSync(join(tmpdir(), "audit-fn-complexity-"));
  try {
    writeFileSync(join(root, "a.ts"), "function f() { if (a) {} }\nfunction g() { if (b) {} }\n");
    const bundle = await buildGraphBundleFromFs(manifest([{ path: "a.ts", content: "" }]), root);
    expect(bundle.node_metrics!["a.ts"].complexity).toEqual({
      value: 2,
      measure: "cyclomatic-max-function",
      reach: "js-ts-effective",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy bundle without node_metrics parses and yields empty complexity/duplication", () => {
  const legacy = edgeBundle([{ from: "a", to: "b" }]);
  const parsed = GraphBundleSchema.safeParse(legacy);
  expect(parsed.success, "legacy bundle parses under .strict()").toBe(true);

  const signals = deriveGraphSignals(legacy);
  expect(signals.complexity).toEqual([]);
  expect(signals.duplication).toEqual([]);
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
  expect(parsed.success).toBe(true);

  const signals = deriveGraphSignals(withMetrics);
  expect(signals.complexity.length).toBe(1);
  expect(signals.complexity[0].node).toBe("src/a.ts");
  expect(signals.complexity[0].value).toBe(3);
  expect(signals.duplication).toEqual([]);
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
  expect(signals.complexity.map((c) => c.node)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
});

test("malformed node_metrics degrades to empty, never throws", () => {
  for (const bad of [
    // @ts-expect-error deliberate contract violation: node_metrics must be a record, not a string — exercises the runtime degrade-to-empty guard.
    edgeBundle([], { node_metrics: "nope" }),
    // @ts-expect-error deliberate contract violation: a per-file entry must be an object, not null — exercises the runtime degrade-to-empty guard.
    edgeBundle([], { node_metrics: { "src/a.ts": null } }),
    // @ts-expect-error deliberate contract violation: NodeMetric.value must be a number, not a string — exercises the runtime degrade-to-empty guard.
    edgeBundle([], { node_metrics: { "src/a.ts": { complexity: { value: "x", measure: "m", reach: "js-ts-effective" } } } }),
    // @ts-expect-error deliberate contract violation: an empty complexity object is missing required NodeMetric fields — exercises the runtime degrade-to-empty guard.
    edgeBundle([], { node_metrics: { "src/a.ts": { complexity: {} } } }),
  ]) {
    let signals!: GraphSignals;
    assert.doesNotThrow(() => {
      signals = deriveGraphSignals(bad);
    });
    expect(signals.complexity).toEqual([]);
    expect(signals.duplication).toEqual([]);
  }
});

test("seams: a bridge edge is detected", () => {
  // a-b-c chain: every edge is a bridge.
  const bundle = edgeBundle([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
  const signals = deriveGraphSignals(bundle);
  expect(signals.seams).toEqual([
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
  expect(signals.seams).toEqual([]);
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
  expect(signals.seams).toEqual([]);
});

test("seams: self-loops are dropped", () => {
  const bundle = edgeBundle([
    { from: "a", to: "a" },
    { from: "a", to: "b" },
  ]);
  const signals = deriveGraphSignals(bundle);
  expect(signals.seams).toEqual([{ from: "a", to: "b" }]);
});

test("seams: empty graph -> empty seams, no throw", () => {
  let signals!: GraphSignals;
  assert.doesNotThrow(() => {
    signals = deriveGraphSignals(edgeBundle([]));
  });
  expect(signals.seams).toEqual([]);
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
  expect(signals.seams).toEqual([{ from: "a", to: "b" }]);
});

test("seams sort deterministically by from-then-to", () => {
  const bundle = edgeBundle([
    { from: "m", to: "n" },
    { from: "a", to: "b" },
    { from: "a", to: "c" },
  ]);
  // star at a: a-b, a-c, plus separate m-n. All bridges.
  const signals = deriveGraphSignals(bundle);
  expect(signals.seams).toEqual([
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
        "src/b.ts": { duplication: { value: 2, measure: "duplicate-block-lines", reach: "js-ts-effective" } },
        "src/a.ts": { complexity: { value: 5, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
      },
    },
  );
  const first = deriveGraphSignals(bundle);
  const second = deriveGraphSignals(bundle);
  expect(first.complexity).toEqual(second.complexity);
  expect(first.duplication).toEqual(second.duplication);
  expect(first.seams).toEqual(second.seams);
});

test("deriveGraphSignals performs no IO and does not mutate input", () => {
  const bundle = edgeBundle([{ from: "a", to: "b" }], {
    node_metrics: {
      "src/a.ts": { complexity: { value: 1, measure: "cyclomatic-approx", reach: "js-ts-effective" } },
    },
  });
  const snapshot = JSON.stringify(bundle);
  deriveGraphSignals(bundle);
  expect(JSON.stringify(bundle), "input bundle unchanged").toBe(snapshot);
});

test("a complexity hotspot is a ROUTINE above the McCabe limit; the file-level proxy makes no hotspot claim", async () => {
  const { isComplexityHotspot, hasDuplicatedBlock } = await import(
    "../../src/audit/extractors/analyzers/complexityDuplication.js"
  );
  // NIST SP 500-235: a module EXCEEDING 10 needs justification; 10 is within it.
  expect(isComplexityHotspot({ measure: "cyclomatic-max-function", value: 10 })).toBe(false);
  expect(isComplexityHotspot({ measure: "cyclomatic-max-function", value: 11 })).toBe(true);
  // A whole-file branch count is not a per-routine number, however large.
  expect(isComplexityHotspot({ measure: "cyclomatic-approx-file", value: 500 })).toBe(false);
  expect(hasDuplicatedBlock({ value: 0 })).toBe(false);
  expect(hasDuplicatedBlock({ value: 5 })).toBe(true);
});
