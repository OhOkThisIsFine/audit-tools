import { test, expect } from "vitest";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";

// CP-NODE-7 regen-drain pins: the SINGLE fold-aware stop predicate is consumed by
// BOTH the advanceAudit drain loop AND the next-step fold. These tests lock the two
// FOLD-LEVEL pauses a registry-only `isHostDelegationExecutor` gate is blind to —
// the analyzer-install consent fold and the low-confidence edge-reasoning fold —
// plus the registry-level host-delegation stop, so the default drain can never
// silently skip an operator-interactive step.
const {
  nextStepPausesForHostInput,
  nextStepIsDrainableRegen,
  graphEnrichmentLowConfidenceEdges,
  graphEnrichmentUnresolvedAnalyzers,
} = await import("../../src/audit/orchestrator/hostInputPause.ts");
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");

const SKIP_ANALYZERS = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

const alwaysHasRunner = () => true;

// A low-confidence (< 0.65 floor) edge whose endpoints are real fixture files.
const LOW_CONF_EDGE = {
  from: "src/api/auth.ts",
  to: "src/lib/session.ts",
  kind: "heuristic-cross-module-link",
  confidence: 0.4,
  direction: "directed",
  reason: "terse machine reason",
};

/** A graph_enrichment_current-stage bundle carrying an injected low-confidence
 * edge. `artifact_metadata` is dropped so the hand-shaped graph reads as a valid
 * first-run state (presence-based staleness) — otherwise the post-metadata graph
 * mutation would re-stale structure and re-select structure_executor. */
async function graphEnrichmentBundleWithLowConfEdge(root) {
  const bundle = await buildAdvancedBundle(root, "graph_enrichment_current");
  bundle.graph_bundle.graphs.references = [
    ...(bundle.graph_bundle.graphs.references ?? []),
    { ...LOW_CONF_EDGE },
  ];
  delete bundle.artifact_metadata;
  return bundle;
}

test("the drain STOPS at the low-confidence edge-reasoning fold (flag on)", async () => {
  await withTempDir("drain-edge-fold-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await graphEnrichmentBundleWithLowConfEdge(root);
    const inputs = { root, analyzers: SKIP_ANALYZERS, graphLlmEdgeReasoning: true };

    // The fold-aware predicate sees the edge-reasoning fold even though
    // graph_enrichment_executor is a deterministic (runner-backed) executor.
    expect(nextStepPausesForHostInput(bundle, inputs)).toBe(true);
    // So the drain refuses to resolve it in-process and hands back to the host.
    expect(nextStepIsDrainableRegen(bundle, alwaysHasRunner, inputs)).toBe(false);
  });
});

test("the drain PROCEEDS through graph enrichment when the edge-reasoning flag is off", async () => {
  await withTempDir("drain-edge-fold-off-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await graphEnrichmentBundleWithLowConfEdge(root);
    const inputs = { root, analyzers: SKIP_ANALYZERS, graphLlmEdgeReasoning: false };

    // Flag off ⇒ no edge-reasoning turn is owed, and skip-all analyzers owe no
    // install consent, so graph enrichment is a drainable deterministic step.
    expect(nextStepPausesForHostInput(bundle, inputs)).toBe(false);
    expect(nextStepIsDrainableRegen(bundle, alwaysHasRunner, inputs)).toBe(true);
  });
});

test("the drain STOPS at a registry-level host-delegation boundary (intent checkpoint)", async () => {
  await withTempDir("drain-host-deleg-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await buildAdvancedBundle(root, "intent_checkpoint_current");
    const inputs = { root, analyzers: SKIP_ANALYZERS };

    expect(nextStepPausesForHostInput(bundle, inputs)).toBe(true);
    expect(nextStepIsDrainableRegen(bundle, alwaysHasRunner, inputs)).toBe(false);
  });
});

test("nextStepIsDrainableRegen requires a runner regardless of the pause predicate", async () => {
  await withTempDir("drain-no-runner-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await graphEnrichmentBundleWithLowConfEdge(root);
    const inputs = { root, analyzers: SKIP_ANALYZERS, graphLlmEdgeReasoning: false };

    // Drainable when a runner exists (flag off ⇒ no pause), but a no-runner
    // handoff is never drainable even though it does not pause for host input.
    expect(nextStepIsDrainableRegen(bundle, () => true, inputs)).toBe(true);
    expect(nextStepIsDrainableRegen(bundle, () => false, inputs)).toBe(false);
  });
});

test("graphEnrichmentLowConfidenceEdges is the single source of the edge-reasoning fold", async () => {
  await withTempDir("drain-edge-pure-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await graphEnrichmentBundleWithLowConfEdge(root);

    // Flag on surfaces the injected low-confidence candidate…
    const on = graphEnrichmentLowConfidenceEdges(bundle, {
      graphLlmEdgeReasoning: true,
    });
    expect(on.some((edge) => edge.kind === LOW_CONF_EDGE.kind)).toBe(true);
    // …flag off surfaces nothing (the Phase 4B gate is closed).
    expect(
      graphEnrichmentLowConfidenceEdges(bundle, { graphLlmEdgeReasoning: false }),
    ).toEqual([]);
  });
});

test("graphEnrichmentUnresolvedAnalyzers owes no consent without a root or with skip-all analyzers", async () => {
  await withTempDir("drain-consent-pure-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await buildAdvancedBundle(root, "graph_enrichment_current");

    // No root ⇒ nothing to resolve ⇒ no consent owed.
    expect(graphEnrichmentUnresolvedAnalyzers(bundle, {})).toEqual([]);
    // Skip-all policy resolves every analyzer to `skip` (not `absent`+`auto`), so
    // no install decision is owed — the drain does not falsely pause.
    expect(
      graphEnrichmentUnresolvedAnalyzers(bundle, { root, analyzers: SKIP_ANALYZERS }),
    ).toEqual([]);
  });
});
