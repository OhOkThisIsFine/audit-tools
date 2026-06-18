import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { writeFixtureRepo } from "./helpers/fixture.mjs";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");

// The Phase 4B candidate we inject into the regex-floor graph. Its endpoints are
// real fixture files; its confidence (0.4) puts it below the 0.65 reasoning floor.
const INJECTED_EDGE = {
  from: "src/api/auth.ts",
  to: "src/lib/session.ts",
  kind: "heuristic-cross-module-link",
  confidence: 0.4,
  direction: "directed",
  reason: "terse machine reason",
};

function edgeIdentity(edge) {
  return JSON.stringify({
    from: edge.from,
    to: edge.to,
    kind: edge.kind ?? "",
    confidence: edge.confidence ?? null,
    direction: edge.direction ?? null,
  });
}

/** Drive the deterministic pipeline in-process through structure, leaving
 * graph_enrichment_current as the next outstanding obligation. Returns the
 * structure-stage bundle so the caller can shape the graph before persisting. */
async function buildStructureReadyBundle(root) {
  // Provider confirmation is the session-level gate; auto-completes headlessly.
  const providerConf = await advanceAudit({}, { root });
  const intake = await advanceAudit(providerConf.updated_bundle, { root });
  const prepared = {
    ...intake.updated_bundle,
    auto_fixes_applied: { executed_tools: [], timestamp: "2026-04-22T00:00:00Z" },
    external_analyzer_results: { tool: "syntax_resolution_executor", results: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  };
  const structure = await advanceAudit(prepared);
  return structure.updated_bundle;
}

function stripLowConfidenceEdges(graphBundle) {
  for (const bucket of ["imports", "calls", "references"]) {
    if (Array.isArray(graphBundle.graphs[bucket])) {
      graphBundle.graphs[bucket] = graphBundle.graphs[bucket].filter(
        (edge) => typeof edge.confidence === "number" && edge.confidence >= 0.65,
      );
    }
  }
}

/** Persist a structure-stage bundle with the injected low-confidence edge, plus a
 * session config. `flag` toggles graph.llm_edge_reasoning; analyzers are skipped
 * so the run never pauses on the optional analyzer-install prompt. */
async function persistEdgeReasoningState(root, artifactsDir, { flag, strip = false } = {}) {
  const bundle = await buildStructureReadyBundle(root);
  if (strip) stripLowConfidenceEdges(bundle.graph_bundle);
  else {
    bundle.graph_bundle.graphs.references = [
      ...(bundle.graph_bundle.graphs.references ?? []),
      { ...INJECTED_EDGE },
    ];
  }
  // Drop the freshness metadata so this hand-shaped graph is treated as a valid
  // first-run state (presence-based staleness). Otherwise the post-metadata graph
  // mutation reads as a stale structure artifact and re-runs structure, which
  // would regenerate the graph and discard the edge we just shaped.
  delete bundle.artifact_metadata;
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, bundle);
  await writeFile(
    join(artifactsDir, "session-config.json"),
    JSON.stringify(
      {
        provider: "local-subprocess",
        analyzers: { typescript: "skip" },
        graph: { llm_edge_reasoning: flag },
      },
      null,
      2,
    ) + "\n",
  );
}

test("next-step emits a single host edge-reasoning step, then rewrites only the reason", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistEdgeReasoningState(root, artifactsDir, { flag: true });

    // No callable subagent facility → a single one-shot host step.
    const paused = JSON.parse(
      (await runWrapper(
        ["next-step", "--no-host-can-dispatch-subagents"],
        { cwd: root },
      )).stdout,
    );
    assert.equal(paused.step_kind, "edge_reasoning");
    assert.equal(paused.status, "ready");
    const resultsPath = paused.artifact_paths.edge_reasoning_results;
    assert.match(resultsPath, /edge-reasoning\.json$/);
    const prompt = await readFile(paused.prompt_path, "utf8");
    assert.match(prompt, /heuristic-cross-module-link/);
    assert.match(prompt, /"rewrites"/);
    assert.match(prompt, /edge-reasoning\.json/);

    // Host supplies the rewrites.
    await writeFile(
      resultsPath,
      JSON.stringify(
        {
          rewrites: [
            {
              from: INJECTED_EDGE.from,
              to: INJECTED_EDGE.to,
              kind: INJECTED_EDGE.kind,
              reason: "auth.ts consumes the session object created by session.ts.",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );

    // Re-run: the orchestrator applies the rewrites inside graph enrichment.
    await runWrapper(
      ["next-step", "--no-host-can-dispatch-subagents"],
      { cwd: root },
    );

    const graphBundle = JSON.parse(
      await readFile(join(artifactsDir, "graph_bundle.json"), "utf8"),
    );
    const edge = graphBundle.graphs.references.find(
      (e) => e.kind === INJECTED_EDGE.kind,
    );
    assert.ok(edge, "the injected edge survives enrichment");
    assert.equal(edge.reason, "auth.ts consumes the session object created by session.ts.");
    // Edge identity is invariant — only `reason` changed.
    assert.equal(edgeIdentity(edge), edgeIdentity(INJECTED_EDGE));

    // The marker that satisfies graph_enrichment_current was written.
    const capability = JSON.parse(
      await readFile(join(artifactsDir, "analyzer_capability.json"), "utf8"),
    );
    assert.ok(capability.status === "applied" || capability.status === "omitted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("next-step emits a dispatch task carrying the edge-reasoning prompt when the host can dispatch", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-dispatch-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistEdgeReasoningState(root, artifactsDir, { flag: true });

    const step = JSON.parse(
      (await runWrapper(
        ["next-step", "--host-can-dispatch-subagents"],
        { cwd: root },
      )).stdout,
    );
    assert.equal(step.step_kind, "edge_reasoning_dispatch");
    assert.equal(step.status, "ready");

    const promptPath = step.artifact_paths.edge_reasoning_prompt;
    assert.match(promptPath, /edge-reasoning-prompt\.md$/);
    assert.match(step.artifact_paths.edge_reasoning_results, /edge-reasoning\.json$/);

    // The dispatch instruction tells the host to fan the prompt out to a subagent.
    const dispatchPrompt = await readFile(step.prompt_path, "utf8");
    assert.match(dispatchPrompt, /subagent/i);
    assert.match(dispatchPrompt, /edge-reasoning-prompt\.md/);

    // The edge-reasoning prompt itself is isolated in its own file.
    const edgePrompt = await readFile(promptPath, "utf8");
    assert.match(edgePrompt, /heuristic-cross-module-link/);
    assert.match(edgePrompt, /"rewrites"/);

    // The results path is pre-declared as writable for the subagent.
    assert.ok(
      (step.access?.write_paths ?? []).some((p) => p.endsWith("edge-reasoning.json")),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("next-step does not pause for edge reasoning when the flag is off (graph unchanged)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-off-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistEdgeReasoningState(root, artifactsDir, { flag: false });

    const step = JSON.parse(
      (await runWrapper(
        ["next-step", "--no-host-can-dispatch-subagents"],
        { cwd: root },
      )).stdout,
    );
    assert.notEqual(step.step_kind, "edge_reasoning");
    assert.notEqual(step.step_kind, "edge_reasoning_dispatch");

    // The low-confidence edge keeps its original reason — graph untouched.
    const graphBundle = JSON.parse(
      await readFile(join(artifactsDir, "graph_bundle.json"), "utf8"),
    );
    const edge = graphBundle.graphs.references.find(
      (e) => e.kind === INJECTED_EDGE.kind,
    );
    assert.ok(edge);
    assert.equal(edge.reason, INJECTED_EDGE.reason);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("next-step does not pause for edge reasoning when there are no low-confidence edges", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-empty-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    // Flag ON, but strip every < 0.65 edge so the candidate set is empty.
    await persistEdgeReasoningState(root, artifactsDir, { flag: true, strip: true });

    const step = JSON.parse(
      (await runWrapper(
        ["next-step", "--no-host-can-dispatch-subagents"],
        { cwd: root },
      )).stdout,
    );
    assert.notEqual(step.step_kind, "edge_reasoning");
    assert.notEqual(step.step_kind, "edge_reasoning_dispatch");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
