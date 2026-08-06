import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");

// The Phase 4B candidate we inject into the regex-floor graph. Its endpoints are
// real fixture files; its confidence (0.4) puts it below the 0.65 reasoning floor.
const INJECTED_EDGE = {
  from: "src/api/auth.ts",
  to: "src/lib/session.ts",
  kind: "heuristic-cross-module-link",
  confidence: 0.4,
  direction: "directed",
  reason: "terse machine reason",
} satisfies GraphEdge;

interface NextStepOutput {
  step_kind: string;
  status: string;
  artifact_paths: Record<string, string>;
  prompt_path: string;
  access?: { write_paths?: string[] };
}

function edgeIdentity(edge: GraphEdge): string {
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
 * structure-stage bundle so the caller can shape the graph before persisting.
 *
 * Uses the single-source, target-keyed `buildAdvancedBundle` (forced single steps)
 * rather than a hand-rolled advanceAudit chain: `advanceAudit` now SAFELY DRAINS
 * the deterministic frontier by default, so a bare chain would overshoot past
 * graph_enrichment_current to the intent_checkpoint host boundary. */
async function buildStructureReadyBundle(root: string): Promise<ArtifactBundle> {
  return buildAdvancedBundle(root, "graph_enrichment_current");
}

function stripLowConfidenceEdges(graphBundle: GraphBundle): void {
  for (const bucket of ["imports", "calls", "references"] as const) {
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
async function persistEdgeReasoningState(
  root: string,
  artifactsDir: string,
  { flag, strip = false }: { flag: boolean; strip?: boolean },
): Promise<void> {
  const bundle = await buildStructureReadyBundle(root);
  if (strip) stripLowConfidenceEdges(bundle.graph_bundle!);
  else {
    bundle.graph_bundle!.graphs.references = [
      ...(bundle.graph_bundle!.graphs.references ?? []),
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
        analyzers: { typescript: "skip" },
        graph: { llm_edge_reasoning: flag },
      },
      null,
      2,
    ) + "\n",
  );
}

test.concurrent("next-step emits the materialized edge-reasoning step for a no-dispatch host, then rewrites only the reason", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistEdgeReasoningState(root, artifactsDir, { flag: true });

    // Always-materialized (design resolution 2): a no-dispatch host receives
    // the SAME edge_reasoning_dispatch step — the lane prompt lives in a file
    // and the capability-neutral step prompt covers sequential self-execution.
    const paused: NextStepOutput = JSON.parse(
      (await runWrapper(
        ["next-step", "--auditor", '{"self":{"provider":"worker-command","can_dispatch_subagents":false}}'],
        { cwd: root },
      )).stdout,
    );
    expect(paused.step_kind).toBe("edge_reasoning_dispatch");
    expect(paused.status).toBe("ready");
    const resultsPath = paused.artifact_paths.edge_reasoning_results;
    expect(resultsPath).toMatch(/edge-reasoning\.json$/);
    const lanePrompt = await readFile(paused.artifact_paths.edge_reasoning_prompt, "utf8");
    expect(lanePrompt).toMatch(/heuristic-cross-module-link/);
    expect(lanePrompt).toMatch(/"rewrites"/);
    const stepPrompt = await readFile(paused.prompt_path, "utf8");
    expect(stepPrompt).toMatch(/else read and follow it yourself/);

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
      ["next-step", "--auditor", '{"self":{"provider":"worker-command","can_dispatch_subagents":false}}'],
      { cwd: root },
    );

    const graphBundle: GraphBundle = JSON.parse(
      await readFile(join(artifactsDir, "graph_bundle.json"), "utf8"),
    );
    const edge = graphBundle.graphs.references!.find(
      (e) => e.kind === INJECTED_EDGE.kind,
    )!;
    expect(edge, "the injected edge survives enrichment").toBeTruthy();
    expect(edge.reason).toBe("auth.ts consumes the session object created by session.ts.");
    // Edge identity is invariant — only `reason` changed.
    expect(edgeIdentity(edge)).toBe(edgeIdentity(INJECTED_EDGE));

    // The marker that satisfies graph_enrichment_current was written.
    const capability = JSON.parse(
      await readFile(join(artifactsDir, "analyzer_capability.json"), "utf8"),
    );
    expect(capability.status === "applied" || capability.status === "omitted").toBeTruthy();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("next-step emits a dispatch task carrying the edge-reasoning prompt when the host can dispatch", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-dispatch-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistEdgeReasoningState(root, artifactsDir, { flag: true });

    const step: NextStepOutput = JSON.parse(
      (await runWrapper(
        ["next-step", "--auditor", '{"self":{"provider":"worker-command","can_dispatch_subagents":true}}'],
        { cwd: root },
      )).stdout,
    );
    expect(step.step_kind).toBe("edge_reasoning_dispatch");
    expect(step.status).toBe("ready");

    const promptPath = step.artifact_paths.edge_reasoning_prompt;
    expect(promptPath).toMatch(/edge-reasoning-prompt\.md$/);
    expect(step.artifact_paths.edge_reasoning_results).toMatch(/edge-reasoning\.json$/);

    // The dispatch instruction tells the host to fan the prompt out to a subagent.
    const dispatchPrompt = await readFile(step.prompt_path, "utf8");
    expect(dispatchPrompt).toMatch(/subagent/i);
    expect(dispatchPrompt).toMatch(/edge-reasoning-prompt\.md/);

    // The edge-reasoning prompt itself is isolated in its own file.
    const edgePrompt = await readFile(promptPath, "utf8");
    expect(edgePrompt).toMatch(/heuristic-cross-module-link/);
    expect(edgePrompt).toMatch(/"rewrites"/);

    // The results path is pre-declared as writable for the subagent.
    expect((step.access?.write_paths ?? []).some((p) => p.endsWith("edge-reasoning.json"))).toBeTruthy();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("next-step does not pause for edge reasoning when the flag is off (graph unchanged)", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-off-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistEdgeReasoningState(root, artifactsDir, { flag: false });

    const step: NextStepOutput = JSON.parse(
      (await runWrapper(
        ["next-step", "--auditor", '{"self":{"provider":"worker-command","can_dispatch_subagents":false}}'],
        { cwd: root },
      )).stdout,
    );
    expect(step.step_kind).not.toBe("edge_reasoning_dispatch");

    // The low-confidence edge keeps its original reason — graph untouched.
    const graphBundle: GraphBundle = JSON.parse(
      await readFile(join(artifactsDir, "graph_bundle.json"), "utf8"),
    );
    const edge = graphBundle.graphs.references!.find(
      (e) => e.kind === INJECTED_EDGE.kind,
    )!;
    expect(edge).toBeTruthy();
    expect(edge.reason).toBe(INJECTED_EDGE.reason);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("next-step does not pause for edge reasoning when there are no low-confidence edges", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-edge-reasoning-empty-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    // Flag ON, but strip every < 0.65 edge so the candidate set is empty.
    await persistEdgeReasoningState(root, artifactsDir, { flag: true, strip: true });

    const step: NextStepOutput = JSON.parse(
      (await runWrapper(
        ["next-step", "--auditor", '{"self":{"provider":"worker-command","can_dispatch_subagents":false}}'],
        { cwd: root },
      )).stdout,
    );
    expect(step.step_kind).not.toBe("edge_reasoning_dispatch");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
