import { findFirstActionableObligation } from "audit-tools/shared";
import {
  decideFrictionTriage,
  type FrictionTriageDecision,
} from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditObligation, AuditState } from "../types/auditState.js";
import { EXECUTOR_REGISTRY } from "./executors.js";
import { deriveAuditState } from "./state.js";

export interface NextStepDecision {
  state: AuditState;
  selected_obligation: string | null;
  selected_executor: string | null;
  reason: string;
}

/**
 * Obligation id for the terminal friction-capture close-out (audit side). Last in
 * PRIORITY — it fires only after every audit obligation is satisfied and the run
 * would otherwise present as complete.
 */
export const FRICTION_CAPTURE_OBLIGATION_ID = "friction_capture_current";

export const PRIORITY: string[] = [
  "provider_confirmation",
  "repo_manifest",
  "file_disposition",
  "auto_fixes_applied",
  "syntax_resolved",
  "structure_artifacts",
  "graph_enrichment_current",
  "design_assessment_current",
  "intent_checkpoint_current",
  "design_review_contract_completed",
  "design_review_conceptual_completed",
  "planning_artifacts",
  "audit_tasks_completed",
  "audit_results_ingested",
  "runtime_validation_current",
  "synthesis_current",
  "synthesis_narrative_current",
  // Terminal close-out: AFTER synthesis, before the run is presented as complete,
  // the tool emits a friction-capture step. Parity with remediate-code (same shared
  // shape + persist helper). Resolved deterministically off the on-disk friction
  // artifact (not bundle state), so it lives at the completion boundary in
  // `decideAuditFrictionCloseout` rather than in the bundle-derived obligation scan.
  FRICTION_CAPTURE_OBLIGATION_ID,
];

// audit-code binds its PRIORITY ordering to the shared scan; the selection
// mechanism is single-sourced in `audit-tools/shared` (A3) so it cannot drift
// from remediate-code's. The domain signature (PRIORITY-bound) is kept for the
// existing call sites in advance.ts + decideNextStep.
export function findObligation(
  obligations: AuditObligation[],
): AuditObligation | undefined {
  return findFirstActionableObligation(PRIORITY, obligations);
}

export function decideNextStep(bundle: ArtifactBundle): NextStepDecision {
  // After intermediate artifacts are cleaned up, trust the persisted complete
  // state so re-runs don't attempt to rebuild from an empty bundle.
  if (bundle.audit_state?.status === "complete") {
    return {
      state: bundle.audit_state,
      selected_obligation: null,
      selected_executor: null,
      reason: "All known obligations are currently satisfied.",
    };
  }
  const state = deriveAuditState(bundle);
  const next = findObligation(state.obligations);

  if (!next) {
    return {
      state,
      selected_obligation: null,
      selected_executor: null,
      reason:
        state.status === "complete"
          ? "All known obligations are currently satisfied."
          : "No actionable missing obligation was found.",
    };
  }

  const executor = EXECUTOR_REGISTRY.find((item) =>
    item.obligation_ids.includes(next.id),
  );
  return {
    state,
    selected_obligation: next.id,
    selected_executor: executor?.id ?? null,
    reason: executor
      ? `Selected highest-priority actionable obligation ${next.id}.`
      : `No executor found for obligation ${next.id}; EXECUTOR_REGISTRY has no entry for this obligation ID. This is a configuration gap — the obligation was selected but cannot be dispatched.`,
  };
}

/**
 * The terminal friction-TRIAGE close-out for the audit half. Thin delegation to the
 * single-sourced `decideFrictionTriage` (`audit-tools/shared`) so the triage shape,
 * disposition vocabulary, blocking semantics, and close-out logic cannot drift from
 * the remediate half. Drops the former false-green (an empty up-front record no
 * longer satisfies): the close-out blocks ("dispose") until every captured
 * mechanical event AND every surfaced agent-feedback reflection carries a
 * disposition; an empty set (zero events AND zero reflections) is trivially
 * "disposed". Keyed only off `(artifactsDir, runId)`; never coupled to any repo's
 * backlog doc.
 */
export async function decideAuditFrictionCloseout(
  artifactsDir: string,
  runId: string,
): Promise<FrictionTriageDecision> {
  return decideFrictionTriage(artifactsDir, runId, "audit-code");
}
