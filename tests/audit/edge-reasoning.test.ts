import { test, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBundle, GraphEdge } from "../../src/shared/index.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { applyEdgeReasoning, collectLowConfidenceEdges, buildEdgeReasoningPrompt } =
  await import("../../src/audit/orchestrator/edgeReasoning.js");
const { renderEdgeReasoningDispatchPrompt } = await import(
  "../../src/audit/cli/prompts.js"
);
const { runGraphEnrichmentExecutor } = await import("../../src/audit/orchestrator/graphEnrichmentExecutor.js");
const { hostScratchDir } = await import("../../src/shared/index.js");
const { AUDIT_GATE_SUBMISSION_SCOPE } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { NEXT_STEP_EMISSION_TABLE } = await import(
  "../../src/audit/cli/nextStepCommand.js"
);

function sampleBundle(): GraphBundle {
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

function edgeSignatures(bundle: GraphBundle): string[] {
  const sig = (e: GraphEdge) =>
    JSON.stringify({
      from: e.from,
      to: e.to,
      kind: e.kind ?? "",
      confidence: e.confidence ?? null,
      direction: e.direction ?? null,
    });
  return [
    ...(bundle.graphs.imports ?? []),
    ...(bundle.graphs.calls ?? []),
    ...(bundle.graphs.references ?? []),
  ]
    .map(sig)
    .sort();
}

test("collectLowConfidenceEdges returns only edges below the 0.65 floor", () => {
  const candidates = collectLowConfidenceEdges(sampleBundle());
  expect(candidates.length).toBe(2);
  expect(candidates.every((e) => (e.confidence ?? 0) < 0.65)).toBeTruthy();
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
  expect(bundle.graphs.imports!.find((e) => e.kind === "heuristic-container-edge")!.reason).toBe("a.ts and lib share the lib/ module root.");
  expect(bundle.graphs.references![0].reason).toBe("auth.ts reads the session cookie set by session.ts.");
  // High-confidence import edge reason is untouched.
  expect(bundle.graphs.imports!.find((e) => e.kind === "esm")!.reason).toBe("import");
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

// ── The dispatch prompt carries the scratch-dir note ─────────────────────────
//
// `renderHostScratchNote` / `hostScratchDir` had ZERO callers for over a year —
// definitions plus a `src/shared/index.ts` re-export, which is all knip's
// default mode needs to count as a consumer, so the dead-code gate stayed green
// while the note reached no prompt. Its whole purpose is the one thing the
// untracked scope rule cannot undo: scratch a lane's executor improvises lands
// in the AUDITED tree, where the next run's manifest walk picks it up as
// untracked litter. This pins the wiring on the emission side — the parameter
// is required, so the only way to render the prompt without it is to not
// compile.

test("the edge-reasoning dispatch prompt names the run-scoped scratch dir", () => {
  const scratchDirPath = join("artifacts", "scratch", "edge_reasoning");
  const prompt = renderEdgeReasoningDispatchPrompt({
    promptPath: "artifacts/lanes/edge_reasoning-prompt.md",
    resultsPath: "artifacts/lanes/edge_reasoning-results.json",
    continueCommand: "audit-code next-step",
    contentHash: "deadbeef",
    candidateCount: 2,
    scratchDirPath,
  });
  expect(prompt).toContain(scratchDirPath);
  // The note forbids the repo tree, which is the hazard it exists for.
  expect(prompt).toMatch(/never at the repository root/);
  // …and it sits on the dispatch prompt only, never in the lane prompt body:
  // a lane file is advance-free and worker-facing, and the lane executor is
  // told where it may write by the dispatch, not by its own instructions.
  const lanePrompt = buildEdgeReasoningPrompt(
    collectLowConfidenceEdges(sampleBundle()),
  );
  expect(lanePrompt).not.toContain(scratchDirPath);
});

// ── …and the directory the note names actually EXISTS ────────────────────────
//
// Naming a directory is not the same as providing one. `renderHostScratchNote`
// points the host at a path built by a pure `join`; nothing on the emit path
// created it, so "write your working files there" was an instruction the host
// had to satisfy by running `mkdir` first. A host that skips that step — or
// improvises a batch list with a plain redirect — writes at the repository root,
// which is precisely the untracked litter the note exists to prevent (it enters
// the next audit's intake walk and findings cite the previous run's litter).
//
// So the emission owns the directory, and this drives the REAL emission row
// rather than the note renderer: asserting on the rendered string alone would
// stay green with the `mkdir` deleted, which is the state this test exists to
// make impossible.

test("emitting the edge-reasoning dispatch creates the scratch dir its note names", async () => {
  const root = mkdtempSync(join(tmpdir(), "edge-reasoning-scratch-"));
  try {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const scratchDirPath = hostScratchDir(artifactsDir, AUDIT_GATE_SUBMISSION_SCOPE);
    expect(
      existsSync(scratchDirPath),
      "precondition: nothing has created the scratch dir before the step is emitted",
    ).toBe(false);

    const row = NEXT_STEP_EMISSION_TABLE.edge_reasoning;
    const plan = (await row({
      argv: ["node", "audit-code", "--root", root],
      root,
      artifactsDir,
      analyzerPolicy: null,
      result: {
        kind: "edge_reasoning",
        state: { status: "active", obligations: [] },
        bundle: {},
        candidates: collectLowConfidenceEdges(sampleBundle()),
      },
    } as Parameters<typeof row>[0])) as unknown as {
      params: { prompt: string };
    };

    // The emitted prompt addresses THIS directory — so the directory asserted
    // below is the one the host was actually told to use, not a parallel guess.
    expect(plan.params.prompt).toContain(scratchDirPath);
    expect(
      existsSync(scratchDirPath) && statSync(scratchDirPath).isDirectory(),
      `the dispatch note names ${scratchDirPath}, so emission must create it — ` +
        "a host following the note must not have to mkdir first",
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph-enrichment executor applies edge reasoning when gated on and writes the graph", async () => {
  const floor = sampleBundle();
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "edge-reasoning-fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [],
    },
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
  expect(edgeSignatures(result.updated.graph_bundle!)).toEqual(before);
  expect(result.updated.graph_bundle!.graphs.imports!.find(
      (e) => e.kind === "heuristic-container-edge",
    )!.reason).toBe("clearer container reason");
});

test("graph-enrichment executor leaves the floor byte-identical when reasoning is off", async () => {
  const floor = sampleBundle();
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "edge-reasoning-fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [],
    },
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
