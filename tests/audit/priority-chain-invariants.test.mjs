import { test, expect } from "vitest";
// Importing from source (not dist) ensures the test guards un-rebuilt changes.
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.ts";
import {
  expectObligationOrder,
  expectObligationEndpoint,
} from "./helpers/advancedBundle.mjs";

// Shape invariants for the obligation `PRIORITY` array — the single source of the
// audit obligation ordering. CLAUDE.md points at this array (see
// `src/audit/orchestrator/nextStep.ts`) rather than restating it, so there is no
// doc copy to keep in lockstep; these assertions guard the array's OWN semantic
// contract (the endpoints and the relative ordering), independent of any prose.

test("PRIORITY holds its endpoint + relative-ordering invariants", () => {
  // Endpoints are semantic invariants: provider_confirmation MUST be the session
  // gate (first), friction_capture_current MUST be the terminal close-out (last).
  // Asserted by endpoint, not literal index, so they don't churn when a phase is
  // inserted between them.
  expectObligationEndpoint(expect, "provider_confirmation", "first");
  expectObligationEndpoint(expect, "friction_capture_current", "last");

  expect(!PRIORITY.includes("design_review_completed"), "design_review_completed should no longer be in PRIORITY").toBeTruthy();

  // The full RELATIVE ordering of the chain's key obligations — the actual
  // sequencing invariant. Keyed by `PRIORITY.indexOf` relationships, never literal
  // integers: inserting a new obligation shifts every absolute index but leaves
  // these before/after relationships intact, so a new phase is a one-line PRIORITY
  // edit rather than a sweep of every pinned number here (the recurring friction
  // this test was the worst offender for — it re-broke on the Phase-B insert).
  expectObligationOrder(expect, [
    "provider_confirmation",
    "repo_manifest",
    "file_disposition",
    "syntax_resolved",
    "external_analyzers_current",
    "structure_artifacts",
    "graph_enrichment_current",
    "design_assessment_current",
    "structure_decomposition_current",
    "intent_checkpoint_current",
    "charter_extraction_current",
    "design_review_contract_completed",
    "design_review_conceptual_completed",
    "charter_clarification_current",
    "systemic_challenge_current",
    "planning_artifacts",
    "synthesis_narrative_current",
    "friction_capture_current",
  ]);
});
