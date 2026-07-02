import { test, expect } from "vitest";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { deriveGraphSignals, allGraphEdges } = await importSourceModule(
  "src/extractors/graphSignals.ts",
);

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
