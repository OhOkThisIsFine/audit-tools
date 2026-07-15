// The real priority chain — imported from source (not dist) so these helpers
// guard un-rebuilt changes and stay in lockstep with the orchestrator.
const { PRIORITY } = await import("../../../src/audit/orchestrator/nextStep.ts");
const { advanceAudit } = await import("../../../src/audit/orchestrator/advance.ts");

/** Position of an obligation in the real PRIORITY chain (-1 if absent). */
function priorityIndex(obligationId) {
  return PRIORITY.indexOf(obligationId);
}

/**
 * Assert that the given obligation ids appear in the PRIORITY chain in the exact
 * order listed, each present and strictly before the next — WITHOUT pinning any
 * absolute index. This is the churn-proof replacement for `expect(PRIORITY[9])
 * .toBe(...)` / `expect(PRIORITY.indexOf(x)).toBe(N)`: inserting an unrelated
 * obligation shifts every literal index but leaves these relative relationships
 * intact, so a new phase is a one-line PRIORITY edit, not a sweep of every test
 * that pinned a now-shifted number.
 *
 * `expect` is injected so this stays a pure helper with no vitest import.
 */
export function expectObligationOrder(expect, obligationIds) {
  for (const id of obligationIds) {
    expect(
      priorityIndex(id),
      `Obligation \`${id}\` is missing from the PRIORITY chain`,
    ).toBeGreaterThanOrEqual(0);
  }
  for (let i = 1; i < obligationIds.length; i += 1) {
    const prev = obligationIds[i - 1];
    const cur = obligationIds[i];
    expect(
      priorityIndex(prev),
      `Obligation \`${prev}\` must come before \`${cur}\` in the PRIORITY chain`,
    ).toBeLessThan(priorityIndex(cur));
  }
}

/**
 * Assert an obligation sits at a semantic ENDPOINT of the chain ("first"/"last").
 * Uses `.at(-1)` for the tail so the count is never hard-coded.
 */
export function expectObligationEndpoint(expect, obligationId, endpoint) {
  const actual = endpoint === "first" ? PRIORITY.at(0) : PRIORITY.at(-1);
  expect(actual, `Expected \`${obligationId}\` to be the ${endpoint} obligation`).toBe(
    obligationId,
  );
}

/**
 * Inject the host-delegated markers the headless fixture skips between intake and
 * structure: the auto-fix, syntax-resolution and external-analyzer-acquisition
 * artifacts (each normally produced by a host-delegation step). Satisfies
 * `auto_fixes_applied`, `syntax_resolved` and `external_analyzers_current` in one
 * deterministic hop, exactly as the previous hand-coded fixture drive did.
 */
function injectPreStructureMarkers(bundle) {
  return {
    ...bundle,
    auto_fixes_applied: {
      executed_tools: [],
      timestamp: "2026-04-22T00:00:00Z",
    },
    external_analyzer_results: [
      { tool: "syntax_resolution_executor", results: [] },
    ],
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
  };
}

/**
 * The deterministic fixture drive, expressed as an ORDERED stage list keyed by
 * the obligation each stage brings the bundle up to (`upTo`). This is the single
 * source of "how to advance a headless fixture bundle through phase N" — adding a
 * new PRIORITY phase is a one-line insert here, not an edit to every test that
 * seeds an advanced bundle. Each `run(bundle, root)` returns the next bundle.
 *
 * Each `advanceAudit` stage FORCES its executor (`preferredExecutor`) so it runs
 * EXACTLY ONE bounded step and lands the bundle at exactly `upTo`. `advanceAudit`
 * now SAFELY DRAINS the deterministic regen frontier by default (a bare call runs
 * the whole runner-backed chain up to the next host-input pause), so a bare
 * `advanceAudit(b)` here would overshoot the target obligation. The forced path is
 * the single-step primitive (drain never triggers on a forced executor).
 */
// Some stages require a real root (intake / provider-confirmation / intent
// checkpoint); the structure + graph-enrichment + later stages deliberately run
// ROOTLESS so the fixture stays offline-hermetic (manifest-only floor graph, no
// analyzer subprocess). `withRoot` mirrors the pre-drain hand-drive exactly.
const forcedStep = (executor, { withRoot = false } = {}) => async (b, root) =>
  (
    await advanceAudit(b, {
      preferredExecutor: executor,
      ...(withRoot ? { root } : {}),
    })
  ).updated_bundle;

const FIXTURE_STAGES = [
  // Session gate: provider confirmation auto-completes headlessly (ignores input).
  { upTo: "provider_confirmation", run: forcedStep("provider_confirmation_executor", { withRoot: true }) },
  // Intake satisfies repo_manifest + file_disposition in one advance.
  { upTo: "file_disposition", run: forcedStep("intake_executor", { withRoot: true }) },
  // Host-delegated markers: auto_fixes_applied + syntax_resolved + external_analyzers_current.
  { upTo: "external_analyzers_current", run: async (b) => injectPreStructureMarkers(b) },
  { upTo: "structure_artifacts", run: forcedStep("structure_executor") },
  // Critical-flow fallback: the small fixture's deterministic flow inference falls
  // below the confidence bar (fallback_required), so this obligation blocks the
  // chain until the host enrichment is provided. Inject an empty host submission
  // (the durable upstream input) and re-run structure so critical_flows records
  // the marker revision — leaving critical_flows fresh + the obligation satisfied,
  // exactly as the real drain does after the host returns. (Harmless no-op merge
  // when the fixture's flows happen to clear the bar.)
  {
    upTo: "critical_flow_fallback_current",
    run: async (b) =>
      (
        await advanceAudit(
          { ...b, critical_flow_fallback: { flows: [] } },
          { preferredExecutor: "structure_executor" },
        )
      ).updated_bundle,
  },
  { upTo: "graph_enrichment_current", run: forcedStep("graph_enrichment_executor") },
  { upTo: "design_assessment_current", run: forcedStep("design_assessment_executor") },
  { upTo: "structure_decomposition_current", run: forcedStep("structure_decomposition_executor") },
  { upTo: "intent_checkpoint_current", run: forcedStep("intent_checkpoint_executor", { withRoot: true }) },
  { upTo: "charter_extraction_current", run: forcedStep("charter_extraction_executor") },
  // Phase C.2 independent delta-miner. host_delegation like charter_extraction: at
  // the default shallow ceiling the extraction pass omits (no deltas_pending), so a
  // forced single step settles the register headlessly.
  { upTo: "charter_delta_current", run: forcedStep("charter_delta_executor") },
  { upTo: "design_review_contract_completed", run: forcedStep("design_review_contract") },
  { upTo: "design_review_conceptual_completed", run: forcedStep("design_review_conceptual") },
  // Phase D charter-clarification triangulation loop + Phase E systemic challenge
  // loop. Both host_delegation (like the design-review passes / charter_extraction):
  // at the default shallow ceiling each runner omits deterministically in one
  // advance, so a forced single step satisfies the obligation headlessly.
  { upTo: "charter_clarification_current", run: forcedStep("charter_clarification_executor") },
  { upTo: "systemic_challenge_current", run: forcedStep("systemic_challenge_executor") },
];

/**
 * Drive the deterministic audit pipeline in-process until `targetObligation` is
 * the next unsatisfied obligation, and return that bundle. Every obligation
 * strictly BEFORE the target is satisfied; the target itself is left for the
 * caller to advance/assert. Keyed by the target id rather than a step count, so
 * a test that wants "a bundle advanced to phase X" never has to track which
 * numeric step that is.
 *
 * `planning_artifacts` and later are reached by running every stage (the stage
 * list stops at the last pre-planning phase); `advanceFixtureToPlanning` layers
 * the planning advance on top.
 */
export async function buildAdvancedBundle(root, targetObligation) {
  const target = priorityIndex(targetObligation);
  if (target < 0) {
    throw new Error(`Unknown target obligation: ${targetObligation}`);
  }
  let bundle = {};
  for (const stage of FIXTURE_STAGES) {
    // Stop before the stage that would satisfy the target (or anything past it),
    // leaving the target as the next unsatisfied obligation.
    if (priorityIndex(stage.upTo) >= target) break;
    bundle = await stage.run(bundle, root);
  }
  return bundle;
}
