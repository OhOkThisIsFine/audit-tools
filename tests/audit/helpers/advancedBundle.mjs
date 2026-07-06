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
 */
const FIXTURE_STAGES = [
  // Session gate: provider confirmation auto-completes headlessly (ignores input).
  { upTo: "provider_confirmation", run: async (_b, root) => (await advanceAudit({}, { root })).updated_bundle },
  // Intake satisfies repo_manifest + file_disposition in one advance.
  { upTo: "file_disposition", run: async (b, root) => (await advanceAudit(b, { root })).updated_bundle },
  // Host-delegated markers: auto_fixes_applied + syntax_resolved + external_analyzers_current.
  { upTo: "external_analyzers_current", run: async (b) => injectPreStructureMarkers(b) },
  { upTo: "structure_artifacts", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "graph_enrichment_current", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "design_assessment_current", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "structure_decomposition_current", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "intent_checkpoint_current", run: async (b, root) => (await advanceAudit(b, { root })).updated_bundle },
  { upTo: "charter_extraction_current", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "design_review_contract_completed", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "design_review_conceptual_completed", run: async (b) => (await advanceAudit(b)).updated_bundle },
  // Phase D charter-clarification triangulation loop + Phase E systemic challenge
  // loop. Both host_delegation (like the design-review passes / charter_extraction):
  // at the default shallow ceiling each runner omits deterministically in one
  // advance, so a plain advanceAudit satisfies the obligation headlessly.
  { upTo: "charter_clarification_current", run: async (b) => (await advanceAudit(b)).updated_bundle },
  { upTo: "systemic_challenge_current", run: async (b) => (await advanceAudit(b)).updated_bundle },
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
