import { test, expect } from "vitest";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";
import type { AnalyzerSetting, GraphEdge } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

// CP-NODE-7 regen-drain pins, migrated onto CX-02's ONE registry: pause policy
// is now the per-obligation CLASSIFICATION in `obligationPolicy.ts`, consumed by
// BOTH the plan draw (`advanceAudit` unforced) and the full `next-step` fold's
// bespoke bodies. These tests lock the two FOLD-LEVEL pauses a registry-only
// `isHostDelegationExecutor` gate is blind to — the analyzer-install consent
// fold and the low-confidence edge-reasoning fold — plus the registry-level
// host-delegation stop, so neither draw can silently run past an
// operator-interactive boundary.
const {
  graphEnrichmentLowConfidenceEdges,
  graphEnrichmentUnresolvedAnalyzers,
} = await import("../../src/audit/orchestrator/hostInputPause.js");
const { classifyObligationBranch } = await import(
  "../../src/audit/orchestrator/obligationPolicy.js"
);
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");

const SKIP_ANALYZERS: Record<string, AnalyzerSetting> = {
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
} satisfies GraphEdge;

/** A graph_enrichment_current-stage bundle carrying an injected low-confidence
 * edge. `artifact_metadata` is dropped so the hand-shaped graph reads as a valid
 * first-run state (presence-based staleness) — otherwise the post-metadata graph
 * mutation would re-stale structure and re-select structure_executor. */
async function graphEnrichmentBundleWithLowConfEdge(root: string): Promise<ArtifactBundle> {
  const bundle: ArtifactBundle = await buildAdvancedBundle(root, "graph_enrichment_current");
  bundle.graph_bundle!.graphs.references = [
    ...(bundle.graph_bundle!.graphs.references ?? []),
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

    // The classifier sees the edge-reasoning fold even though
    // graph_enrichment_executor is a deterministic (runner-backed) executor,
    // so a draw halts instead of resolving it in-process.
    const branch = await classifyObligationBranch(
      "graph_enrichment_current",
      bundle,
      inputs,
      alwaysHasRunner,
    );
    expect(branch.branch).toBe("host_boundary");
  });
});

test("the drain PROCEEDS through graph enrichment when the edge-reasoning flag is off", async () => {
  await withTempDir("drain-edge-fold-off-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await graphEnrichmentBundleWithLowConfEdge(root);
    const inputs = { root, analyzers: SKIP_ANALYZERS, graphLlmEdgeReasoning: false };

    // Flag off ⇒ no edge-reasoning turn is owed, and skip-all analyzers owe no
    // install consent, so graph enrichment is a drainable deterministic step.
    const branch = await classifyObligationBranch(
      "graph_enrichment_current",
      bundle,
      inputs,
      alwaysHasRunner,
    );
    expect(branch.branch).toBe("deterministic");
  });
});

test("the drain STOPS at a registry-level host-delegation boundary (intent checkpoint)", async () => {
  await withTempDir("drain-host-deleg-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await buildAdvancedBundle(root, "intent_checkpoint_current");
    const inputs = { root, analyzers: SKIP_ANALYZERS };

    const branch = await classifyObligationBranch(
      "intent_checkpoint_current",
      bundle,
      inputs,
      alwaysHasRunner,
    );
    expect(branch.branch).toBe("host_boundary");
  });
});

test("an unclassified obligation with no deterministic runner is a host boundary", async () => {
  await withTempDir("drain-no-runner-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await buildAdvancedBundle(root, "graph_enrichment_current");
    const inputs = { root, analyzers: SKIP_ANALYZERS };

    // A plain deterministic id is drainable while its executor has a runner…
    expect(
      (await classifyObligationBranch("synthesis_current", bundle, inputs, () => true))
        .branch,
    ).toBe("deterministic");
    // …and a no-runner handoff is never drainable even though no fold-level
    // pause is owed.
    expect(
      (await classifyObligationBranch("synthesis_current", bundle, inputs, () => false))
        .branch,
    ).toBe("host_boundary");
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
