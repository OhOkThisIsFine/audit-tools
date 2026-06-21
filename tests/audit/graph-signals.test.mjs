import test from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual(
    edges.map((e) => `${e.from}->${e.to}`),
    ["a->b", "b->c"],
  );
});

test("deriveGraphSignals detects a directed cycle and marks its members", () => {
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ]),
  );
  assert.equal(signals.cycles.length, 1);
  assert.deepEqual([...signals.nodesInCycles].sort(), ["a", "b", "c"]);
});

test("deriveGraphSignals returns no cycles for a DAG", () => {
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]),
  );
  assert.equal(signals.cycles.length, 0);
  assert.equal(signals.nodesInCycles.size, 0);
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
  assert.equal(signals.cycles.length, 1);
});

test("deriveGraphSignals flags hubs at the fan-in/fan-out threshold", () => {
  const imports = [];
  for (let i = 0; i < 8; i++) {
    imports.push({ from: `dep-${i}`, to: "hub" });
    imports.push({ from: "hub", to: `tgt-${i}` });
  }
  const signals = deriveGraphSignals(bundle(imports));
  assert.ok(signals.hubs.has("hub"), "hub with 8 in + 8 out should be flagged");
  assert.equal(signals.fanIn.get("hub"), 8);
  assert.equal(signals.fanOut.get("hub"), 8);
});

test("deriveGraphSignals does not flag a node below the hub threshold", () => {
  const imports = [];
  for (let i = 0; i < 7; i++) {
    imports.push({ from: `dep-${i}`, to: "hub" });
    imports.push({ from: "hub", to: `tgt-${i}` });
  }
  const signals = deriveGraphSignals(bundle(imports));
  assert.equal(signals.hubs.has("hub"), false);
});

test("deletion candidates are low-in-degree leaves (fanIn 0, fanOut > 0), not pure orphans", () => {
  // `entry` imports `lib` but nothing imports `entry` → deletion candidate.
  // `lib` is imported (fanIn 1) → not a candidate.
  // A pure orphan (no edges at all) never appears in the connected set, so it is
  // not a deletion candidate either (it is the separate zero-edge orphan signal).
  const signals = deriveGraphSignals(
    bundle([{ from: "entry", to: "lib" }]),
  );
  assert.deepEqual([...signals.deletionCandidates], ["entry"]);
  assert.equal(signals.deletionCandidates.has("lib"), false);
  assert.deepEqual([...signals.connected].sort(), ["entry", "lib"]);
});

test("a node inside a cycle is never a deletion candidate (every cycle member has fanIn > 0)", () => {
  const signals = deriveGraphSignals(
    bundle([
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]),
  );
  assert.equal(signals.deletionCandidates.size, 0);
});
