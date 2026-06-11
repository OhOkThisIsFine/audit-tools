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
];

export function findObligation(
  obligations: AuditObligation[],
): AuditObligation | undefined {
  for (const id of PRIORITY) {
    const item = obligations.find((o) => o.id === id);
    if (item && (item.state === "missing" || item.state === "stale")) {
      return item;
    }
  }
  return undefined;
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
