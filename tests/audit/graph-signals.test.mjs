import { test, expect } from "vitest";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { deriveGraphSignals, allGraphEdges, structuralImportEdges } =
  await importSourceModule("src/extractors/graphSignals.ts");

function bundle(imports, extra = {}) {
  return { graphs: { imports, ...extra } };
}

test("allGraphEdges flattens every edge bucket but skips routes and malformed edges", () => {
  const edges = allGraphEdges({
    graphs: {
      imports: [{ from: "a", to: "b" }],
      calls: [{ from: "b", to: "c" }],
      routes: [{ path: "/x", handler: "h" }],
      junk: [{ from: "d" }, null, { to: "e" }, "nope"],
    },
  });
  expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b", "b->c"]);
});

test("deriveGraphSignals detects a directed cycle and marks its members", () => {
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ]),
  );
  expect(signals.cycles.length).toBe(1);
  expect([...signals.nodesInCycles].sort()).toEqual(["a", "b", "c"]);
});

test("deriveGraphSignals returns no cycles for a DAG", () => {
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]),
  );
  expect(signals.cycles.length).toBe(0);
  expect(signals.nodesInCycles.size).toBe(0);
});

test("deriveGraphSignals dedups the same directed cycle found from different roots", () => {
  // A two-node cycle a<->b is reachable as a root from both a and b; canonical
  // rotation must collapse the duplicates into one.
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]),
  );
  expect(signals.cycles.length).toBe(1);
});

test("deriveGraphSignals flags hubs at the fan-in/fan-out threshold", () => {
  const imports = [];
  for (let i = 0; i < 8; i++) {
    imports.push({ from: `dep-${i}`, to: "hub" });
    imports.push({ from: "hub", to: `tgt-${i}` });
  }
  const signals = deriveGraphSignals(bundle(imports));
  expect(signals.hubs.has("hub"), "hub with 8 in + 8 out should be flagged").toBeTruthy();
  expect(signals.fanIn.get("hub")).toBe(8);
  expect(signals.fanOut.get("hub")).toBe(8);
});

test("deriveGraphSignals does not flag a node below the hub threshold", () => {
  const imports = [];
  for (let i = 0; i < 7; i++) {
    imports.push({ from: `dep-${i}`, to: "hub" });
    imports.push({ from: "hub", to: `tgt-${i}` });
  }
  const signals = deriveGraphSignals(bundle(imports));
  expect(signals.hubs.has("hub")).toBe(false);
});

test("deletion candidates are low-in-degree leaves (fanIn 0, fanOut > 0), not pure orphans", () => {
  // `entry` imports `lib` but nothing imports `entry` → deletion candidate.
  // `lib` is imported (fanIn 1) → not a candidate.
  // A pure orphan (no edges at all) never appears in the connected set, so it is
  // not a deletion candidate either (it is the separate zero-edge orphan signal).
  const signals = deriveGraphSignals(
    bundle([{ from: "entry", to: "lib" }]),
  );
  expect([...signals.deletionCandidates]).toEqual(["entry"]);
  expect(signals.deletionCandidates.has("lib")).toBe(false);
  expect([...signals.connected].sort()).toEqual(["entry", "lib"]);
});

test("a node inside a cycle is never a deletion candidate (every cycle member has fanIn > 0)", () => {
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]),
  );
  expect(signals.deletionCandidates.size).toBe(0);
});

// ── load-order-only cycle detection (CP-NODE-4) ───────────────────────────────
// Cycle detection and hub derivation must consume ONLY structural load-order
// edges (the imports + calls buckets). A references edge (prose/path mention)
// or a heuristic edge closing a would-be cycle must never fabricate a cycle.

test("structuralImportEdges returns only the imports and calls buckets, dropping malformed edges", () => {
  const edges = structuralImportEdges({
    graphs: {
      imports: [{ from: "a", to: "b" }, { from: "x" }, null],
      calls: [{ from: "b", to: "c" }],
      references: [{ from: "c", to: "a" }],
      heuristics: [{ from: "d", to: "e", confidence: 0.3 }],
      routes: [{ path: "/x", handler: "h" }],
      junk: "not-an-array",
    },
  });
  expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b", "b->c"]);
});

test("a references edge closing a would-be cycle does not fabricate a cycle", () => {
  const signals = deriveGraphSignals({
    graphs: {
      imports: [{ from: "a", to: "b" }],
      references: [{ from: "b", to: "a", kind: "path-reference" }],
    },
  });
  expect(signals.cycles.length).toBe(0);
  expect(signals.nodesInCycles.size).toBe(0);
});

test("a heuristic edge closing a would-be cycle does not fabricate a cycle", () => {
  const signals = deriveGraphSignals({
    graphs: {
      imports: [{ from: "a", to: "b" }],
      heuristics: [
        { from: "b", to: "a", kind: "heuristic-auth-session-link", confidence: 0.3 },
      ],
    },
  });
  expect(signals.cycles.length).toBe(0);
  expect(signals.nodesInCycles.size).toBe(0);
});

test("a genuine cycle spanning the imports and calls buckets is still detected", () => {
  const signals = deriveGraphSignals({
    graphs: {
      imports: [{ from: "a", to: "b" }],
      calls: [{ from: "b", to: "a" }],
    },
  });
  expect(signals.cycles.length).toBe(1);
  expect([...signals.nodesInCycles].sort()).toEqual(["a", "b"]);
});

test("hub derivation counts only load-order (imports/calls) degrees", () => {
  // 8 in + 8 out via references alone must NOT make a hub…
  const references = [];
  for (let i = 0; i < 8; i++) {
    references.push({ from: `dep-${i}`, to: "hub" });
    references.push({ from: "hub", to: `tgt-${i}` });
  }
  const refOnly = deriveGraphSignals({ graphs: { references } });
  expect(refOnly.hubs.size).toBe(0);

  // …while the same degrees via imports still do (structural floor intact).
  const imports = references.map((e) => ({ ...e }));
  const structural = deriveGraphSignals({ graphs: { imports } });
  expect(structural.hubs.has("hub")).toBe(true);
});
