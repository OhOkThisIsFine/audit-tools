import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { buildKnipGraphIndex, classifyKnipLead } = await import(
  "../../src/audit/orchestrator/knipGraphCrosscheck.ts"
);

// A graph_bundle whose `imports` bucket carries a Windows-backslash, mixed-case
// node id that must still match a POSIX-normalized knip lead path.
function bundleWithEdge(from, to, analyzersUsed = ["typescript"]) {
  return {
    graphs: { imports: [{ from, to, kind: "import" }] },
    analyzers_used: analyzersUsed,
  };
}

test("CE-001/INV-K6 — backslash/mixed-case graph node id matches a POSIX knip lead → HAS-IMPORTERS", () => {
  // Edge target is Windows-backslash + mixed case; the lead is POSIX + mixed
  // case. Both normalize to the same key, so in-degree is 1 → HAS-IMPORTERS,
  // NOT a false LIKELY-DEAD.
  const index = buildKnipGraphIndex({
    graphBundle: bundleWithEdge("src\\Bar.ts", "src\\Foo.ts"),
    surfaceManifest: { surfaces: [] },
    criticalFlows: { flows: [] },
  });
  expect(classifyKnipLead("src/Foo.ts", index)).toBe("HAS-IMPORTERS");
});

test("CE-003/INV-K2 — analyzers_used=[typescript] + non-TS lead → UNVERIFIED", () => {
  // The Python lead's own analyzer (python) never ran, so a zero in-degree is
  // not trustworthy → UNVERIFIED, not LIKELY-DEAD.
  const index = buildKnipGraphIndex({
    graphBundle: { graphs: {}, analyzers_used: ["typescript"] },
    surfaceManifest: { surfaces: [] },
    criticalFlows: { flows: [] },
  });
  expect(classifyKnipLead("src/thing.py", index)).toBe("UNVERIFIED");
});

test("CE-003/INV-K2 — empty analyzers_used → UNVERIFIED even for a TS lead", () => {
  const index = buildKnipGraphIndex({
    graphBundle: { graphs: {}, analyzers_used: [] },
    surfaceManifest: { surfaces: [] },
    criticalFlows: { flows: [] },
  });
  expect(classifyKnipLead("src/orphan.ts", index)).toBe("UNVERIFIED");
});

test("INV-K3 — a fanIn-0 file that IS a surface entrypoint → ENTRYPOINT, not LIKELY-DEAD", () => {
  const index = buildKnipGraphIndex({
    graphBundle: { graphs: {}, analyzers_used: ["typescript"] },
    surfaceManifest: {
      surfaces: [{ id: "cli", kind: "interface", entrypoint: "src/main.ts" }],
    },
    criticalFlows: { flows: [] },
  });
  expect(classifyKnipLead("src/main.ts", index)).toBe("ENTRYPOINT");
});

test("INV-K3 — a fanIn-0 file that is a critical-flow entrypoint → ENTRYPOINT", () => {
  const index = buildKnipGraphIndex({
    graphBundle: { graphs: {}, analyzers_used: ["typescript"] },
    surfaceManifest: { surfaces: [] },
    criticalFlows: {
      flows: [
        {
          id: "f1",
          name: "boot",
          entrypoints: ["src/boot.ts"],
          paths: [],
          concerns: [],
        },
      ],
    },
  });
  expect(classifyKnipLead("src/boot.ts", index)).toBe("ENTRYPOINT");
});

test("LIKELY-DEAD happy path — in-degree 0, non-entrypoint, own analyzer ran", () => {
  const index = buildKnipGraphIndex({
    graphBundle: { graphs: {}, analyzers_used: ["typescript"] },
    surfaceManifest: { surfaces: [] },
    criticalFlows: { flows: [] },
  });
  expect(classifyKnipLead("src/dead.ts", index)).toBe("LIKELY-DEAD");
});

test("HAS-IMPORTERS wins over entrypoint status when in-degree > 0", () => {
  const index = buildKnipGraphIndex({
    graphBundle: bundleWithEdge("src/a.ts", "src/main.ts"),
    surfaceManifest: {
      surfaces: [{ id: "cli", kind: "interface", entrypoint: "src/main.ts" }],
    },
    criticalFlows: { flows: [] },
  });
  expect(classifyKnipLead("src/main.ts", index)).toBe("HAS-IMPORTERS");
});

test("degrade-to-empty — all artifacts missing → UNVERIFIED, never throws", () => {
  const index = buildKnipGraphIndex({});
  assert.doesNotThrow(() => classifyKnipLead("src/anything.ts", index));
  expect(classifyKnipLead("src/anything.ts", index)).toBe("UNVERIFIED");
});

test("degrade-to-empty — malformed graphs object does not throw", () => {
  assert.doesNotThrow(() =>
    buildKnipGraphIndex({ graphBundle: { graphs: { imports: "not-an-array" } } }),
  );
});
