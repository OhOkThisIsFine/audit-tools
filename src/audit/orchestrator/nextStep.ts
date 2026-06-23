import { findFirstActionableObligation } from "audit-tools/shared";
import {
  frictionCaptured,
  persistFrictionCapture,
  frictionCapturePath,
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

/** The terminal friction-capture close-out decision for the audit half. */
export interface AuditFrictionCloseoutDecision {
  /**
   * "capture" → the close-out must fire this pass (a friction step is emitted and a
   * degrade-clean record persisted). "captured" → already recorded for this run_id;
   * the close-out is satisfied and the run proceeds to its complete/present terminal.
   */
  action: "capture" | "captured";
  /** The run_id-keyed friction record path (always set, for the handoff pointer). */
  recordPath: string;
}

/**
 * Resolve (and, on first fire, satisfy) the terminal friction-capture close-out for
 * the audit half. This is the audit analog of remediate-code's friction gate in
 * `handleComplete`:
 *
 *  - DETERMINISTIC: keyed only off the on-disk record at `(artifactsDir, runId)` via
 *    the SINGLE shared helper — never host discretion or a bundle flag.
 *  - DEGRADE-CLEANLY: on first fire it persists a zero-friction record up front, so
 *    the close-out is immediately satisfiable and can NEVER block completion.
 *  - NEVER RE-LOOP: once a record exists, returns "captured" and the run proceeds —
 *    the close-out fires at most once per run.
 *  - PARITY: identical shape + persist helper to the remediate side (single-sourced
 *    in `audit-tools/shared`), so the two halves cannot drift.
 *  - NEVER couples to any repo's backlog doc — the record lives under the run's own
 *    artifacts dir.
 *
 * Returns "capture" the first time (the host should be prompted to optionally enrich
 * the persisted record), "captured" thereafter.
 */
export async function decideAuditFrictionCloseout(
  artifactsDir: string,
  runId: string,
): Promise<AuditFrictionCloseoutDecision> {
  const recordPath = frictionCapturePath(artifactsDir, runId);
  if (await frictionCaptured(artifactsDir, runId)) {
    return { action: "captured", recordPath };
  }
  await persistFrictionCapture({
    artifactsDir,
    runId,
    tool: "audit-code",
    frictions: [],
  });
  return { action: "capture", recordPath };
}
