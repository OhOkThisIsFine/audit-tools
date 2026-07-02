import { test, expect } from "vitest";

const { applyEdgeReasoning, collectLowConfidenceEdges, buildEdgeReasoningPrompt } =
  await import("../../src/audit/orchestrator/edgeReasoning.ts");
const { runGraphEnrichmentExecutor } = await import("../../src/audit/orchestrator/graphEnrichmentExecutor.ts");

function sampleBundle() {
  return {
    graphs: {
      imports: [
        // high-confidence — never a candidate
        { from: "a.ts", to: "b.ts", kind: "esm", confidence: 0.95, direction: "directed", reason: "import" },
        // low-confidence heuristic — candidate
        { from: "a.ts", to: "lib", kind: "heuristic-container-edge", confidence: 0.25, direction: "undirected", reason: "Path hierarchy suggests shared module ownership." },
      ],
      calls: [],
      references: [
        { from: "auth.ts", to: "session.ts", kind: "heuristic-auth-session-link", confidence: 0.55, direction: "directed", reason: "naming convention" },
      ],
      routes: [],
    },
  };
}

function edgeSignatures(bundle) {
  const sig = (e) =>
    JSON.stringify({
      from: e.from,
      to: e.to,
      kind: e.kind ?? "",
      confidence: e.confidence ?? null,
      direction: e.direction ?? null,
    });
  return [
    ...bundle.graphs.imports,
    ...bundle.graphs.calls,
    ...bundle.graphs.references,
  ]
    .map(sig)
    .sort();
}

test("collectLowConfidenceEdges returns only edges below the 0.65 floor", () => {
  const candidates = collectLowConfidenceEdges(sampleBundle());
  expect(candidates.length).toBe(2);
  expect(candidates.every((e) => e.confidence < 0.65)).toBeTruthy();
});

test("applyEdgeReasoning rewrites only `reason`; the edge set is invariant", () => {
  const bundle = sampleBundle();
  const before = edgeSignatures(bundle);

  const summary = applyEdgeReasoning(bundle, {
    rewrites: [
      { from: "a.ts", to: "lib", kind: "heuristic-container-edge", reason: "a.ts and lib share the lib/ module root." },
      { from: "auth.ts", to: "session.ts", reason: "auth.ts reads the session cookie set by session.ts." },
      // targets a high-confidence edge — must be ignored
      { from: "a.ts", to: "b.ts", kind: "esm", reason: "should NOT apply" },
      // targets a nonexistent edge — must be ignored
      { from: "x.ts", to: "y.ts", kind: "esm", reason: "should NOT apply" },
    ],
  });

  expect(summary.rewritten).toBe(2);
  expect(summary.candidates).toBe(2);

  // Golden edge-set equality: identity fields unchanged.
  expect(edgeSignatures(bundle)).toEqual(before);

  // Reasons updated on the two low-confidence edges only.
  expect(bundle.graphs.imports.find((e) => e.kind === "heuristic-container-edge").reason).toBe("a.ts and lib share the lib/ module root.");
  expect(bundle.graphs.references[0].reason).toBe("auth.ts reads the session cookie set by session.ts.");
  // High-confidence import edge reason is untouched.
  expect(bundle.graphs.imports.find((e) => e.kind === "esm").reason).toBe("import");
});

test("applyEdgeReasoning is a no-op without rewrites", () => {
  const bundle = sampleBundle();
  const before = JSON.stringify(bundle);
  const summary = applyEdgeReasoning(bundle, undefined);
  expect(summary.rewritten).toBe(0);
  expect(JSON.stringify(bundle)).toBe(before);
});

test("applyEdgeReasoning ignores blank reasons", () => {
  const bundle = sampleBundle();
  const summary = applyEdgeReasoning(bundle, {
    rewrites: [{ from: "a.ts", to: "lib", kind: "heuristic-container-edge", reason: "   " }],
  });
  expect(summary.rewritten).toBe(0);
});

test("buildEdgeReasoningPrompt lists each candidate edge", () => {
  const prompt = buildEdgeReasoningPrompt(collectLowConfidenceEdges(sampleBundle()));
  expect(prompt).toMatch(/heuristic-container-edge/);
  expect(prompt).toMatch(/heuristic-auth-session-link/);
  expect(prompt).toMatch(/"rewrites"/);
});

test("graph-enrichment executor applies edge reasoning when gated on and writes the graph", async () => {
  const floor = sampleBundle();
  const bundle = {
    repo_manifest: { files: [] },
    file_disposition: { files: [] },
    graph_bundle: floor,
  };
  const before = edgeSignatures(floor);

  const result = await runGraphEnrichmentExecutor(bundle, {
    root: "/virtual/root",
    registry: [], // no analyzers → "omitted" path
    llmEdgeReasoning: true,
    edgeReasoning: {
      rewrites: [
        { from: "a.ts", to: "lib", kind: "heuristic-container-edge", reason: "clearer container reason" },
      ],
    },
  });

  expect(result.artifacts_written.includes("graph_bundle.json"), "graph_bundle.json is written when reasoning rewrote a reason").toBeTruthy();
  expect(edgeSignatures(result.updated.graph_bundle)).toEqual(before);
  expect(result.updated.graph_bundle.graphs.imports.find(
      (e) => e.kind === "heuristic-container-edge",
    ).reason).toBe("clearer container reason");
});

test("graph-enrichment executor leaves the floor byte-identical when reasoning is off", async () => {
  const floor = sampleBundle();
  const bundle = {
    repo_manifest: { files: [] },
    file_disposition: { files: [] },
    graph_bundle: floor,
  };
  const floorJson = JSON.stringify(floor);

  const result = await runGraphEnrichmentExecutor(bundle, {
    root: "/virtual/root",
    registry: [],
    // llmEdgeReasoning omitted (off) but rewrites supplied — must be ignored.
    edgeReasoning: {
      rewrites: [
        { from: "a.ts", to: "lib", kind: "heuristic-container-edge", reason: "should NOT apply" },
      ],
    },
  });

  expect(result.artifacts_written).toEqual(["analyzer_capability.json"]);
  expect(JSON.stringify(floor), "floor unchanged when reasoning off").toBe(floorJson);
});
