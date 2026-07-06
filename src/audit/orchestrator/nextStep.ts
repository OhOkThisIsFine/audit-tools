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
  "external_analyzers_current",
  "structure_artifacts",
  "graph_enrichment_current",
  "design_assessment_current",
  "structure_decomposition_current",
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

/**
 * Load-time invariant (E3, enforce-in-tooling): every obligation the priority
 * scan can select MUST map to exactly one executor in EXECUTOR_REGISTRY. Without
 * this, adding an id to PRIORITY (or dropping its registry entry) silently yields
 * a `selected_executor: null` "configuration gap" step at runtime — a latent
 * failure the auditor-agnostic invariant forbids. Asserting at module load makes
 * the gap impossible: a missing or ambiguous mapping throws loudly before any run.
 */
function assertExecutorRegistryCoversPriority(): void {
  for (const obligationId of PRIORITY) {
    const owners = EXECUTOR_REGISTRY.filter((executor) =>
      executor.obligation_ids.includes(obligationId),
    );
    if (owners.length === 0) {
      throw new Error(
        `Executor registry configuration gap: PRIORITY obligation "${obligationId}" has no executor in EXECUTOR_REGISTRY. Every scan-selectable obligation must map to exactly one executor.`,
      );
    }
    if (owners.length > 1) {
      throw new Error(
        `Executor registry ambiguity: PRIORITY obligation "${obligationId}" is owned by multiple executors (${owners.map((e) => e.id).join(", ")}). Each obligation must map to exactly one executor.`,
      );
    }
  }
}

assertExecutorRegistryCoversPriority();

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
 * Terminal friction-TRIAGE close-out for audit. Folded into the `present_report`
 * terminal step (not a separate executor) so it fires at exactly the right moment.
 * Blocks ("dispose") until every mechanical event + reflection is disposed AND ≥1
 * open observation written — empty set no longer trivially satisfies.
 * Single-sourced in `audit-tools/shared`; parity with remediate.
 */
export async function decideAuditFrictionCloseout(
  artifactsDir: string,
  runId: string,
): Promise<FrictionTriageDecision> {
  return decideFrictionTriage(artifactsDir, runId, "audit-code");
}
