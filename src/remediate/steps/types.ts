export const REMEDIATION_STEP_CONTRACT_VERSION =
  "remediate-code-step/v1alpha1" as const;

// ── The LIVE host-handoff wire contracts ────────────────────────────────────
//
// Single-sourced here rather than kept private to the host-handoff module,
// because the artifact validator has to recognize the very documents the
// handoff mints. While these lived in one module the validator could only scan
// for names nothing writes, which is precisely how its discovery filters came
// to match zero files on every live run.

// v1alpha2 (obligation evidence-coverage floor): the work item BINDS the
// block's contract obligation ids (`obligation_ids`), and the result must cite
// evidence per bound obligation (`obligation_evidence`), coverage-validated at
// ingestion. A v1alpha1 document refuses closed as stale — re-prepare.
export const REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION =
  "remediation-host-workload/v1alpha2" as const;

export const REMEDIATION_HOST_RESULT_CONTRACT_VERSION =
  "remediation-host-result/v1alpha2" as const;

export const REMEDIATION_HOST_DECISION_CONTRACT_VERSION =
  "remediation-host-decision/v1alpha1" as const;

export type RemediationStepKind =
  | "confirm_intent"
  | "confirm_auto_discovered_input"
  | "confirm_resume_or_restart"
  | "locate_input"
  | "collect_starting_point"
  | "synthesize_intake"
  | "collect_intake_clarifications"
  | "contract_pipeline"
  | "collect_review_approval"
  | "collect_clarifications"
  | "dispatch_implement"
  | "phase_busy"
  | "collect_triage"
  | "close_run"
  | "present_report"
  | "input_conflict"
  | "unhandled_state"
  | "zero_documentable_findings"
  // The tool-owned suite gate came back RED. A THIRD thing, distinct from both
  // neighbours below, and the distinction is the point: `blocked` means
  // next-step itself died on an unhandled error, `phase_busy` means a peer
  // agent holds the phase mutex, and this means the repo's own suite failed
  // while the run is otherwise healthy. Conflating them is exactly the
  // attribution defect the 2026-07-30 entry records — a whole-repo red that
  // says nothing about which run, phase, or item caused it invites a response
  // aimed at the wrong thing (there, re-attempting every item).
  //
  // Persisted contract: an ADDITIVE value. A host that switches on `step_kind`
  // and does not know this one treats it as informational, which is the correct
  // reading — the step asks for nothing but a re-run once the suite is green.
  | "final_gate_red"
  // Terminal-exit backstop (backlog: abnormal-exit no-step-contract): written by
  // the CLI when next-step dies on an unhandled error, so a stale prior step can
  // never read as a live instruction. Mirrors audit-code's "blocked" kind.
  | "blocked"
  // A FOURTH thing, and the same attribution argument as `final_gate_red` above.
  // The obligation fold stopped without converging: an obligation kept
  // transitioning without ever clearing its own actionable state, so the
  // engine's backstop fired. Distinct from `unhandled_state`, which means the
  // machine has no transition for a state — there the state is the problem, here
  // the state is well-formed and an obligation is spinning on it. Conflating
  // them sends an operator to inspect a perfectly good state file.
  //
  // Until this existed, both remediate folds branched on the outcome's `step`
  // alone. `stopped` being ABSENT is what means "complete", so a wedged fold
  // reported as a finished run — the exact failure the shared engine's own
  // contract warns about.
  //
  // Persisted contract: an ADDITIVE value, read the same way as `final_gate_red`
  // by a host that does not know it.
  | "fold_did_not_converge"
  // A FIFTH thing, and the same attribution argument again. The extracted plan
  // was UNUSABLE and has been archived and removed: normalization refused, or
  // grounding dropped every finding. The run is recoverable — re-extract with the
  // problem corrected — but it is not a run that never had an input.
  //
  // Until this existed, that recovery returned a bare `null` and the decide loop
  // fell through to `collect_starting_point`, whose prompt is headed "Collect
  // Remediation Starting Point" and lists the default input locations. A host
  // whose plan had just been destroyed was told, in effect, that no intake
  // existed — and the reason, which the tool had computed and written to its own
  // run log, appeared nowhere the host would read. Two fixtures in one lap hit
  // it, each diagnosed by reading the source rather than the step.
  //
  // Conflating the two is the attribution defect this union has now recorded
  // five times: a discarded plan and a never-supplied input have different
  // repairs, and reporting the first as the second sends the operator to find an
  // input they already had.
  //
  // Persisted contract: an ADDITIVE value, read the same way as `final_gate_red`
  // by a host that does not know it.
  | "extracted_plan_discarded";

import type { StepStatus, AccessDeclaration } from "audit-tools/shared";

// AccessDeclaration is single-sourced in audit-tools/shared; re-exported here
// (from the single import above) so existing importers of this module are
// unchanged. No local re-declaration / second `from "audit-tools/shared"`
// listing — that was the duplicate this consolidates.
export type { AccessDeclaration };

export type RemediationStepStatus = StepStatus;

export interface RemediationStep {
  contract_version: typeof REMEDIATION_STEP_CONTRACT_VERSION;
  step_kind: RemediationStepKind;
  status: RemediationStepStatus;
  prompt_path: string;
  run_id: string;
  repo_root: string;
  artifacts_dir: string;
  allowed_commands: string[];
  stop_condition: string;
  artifact_paths: Record<string, string>;
  access?: AccessDeclaration;
}

export const REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION =
  "remediate-code-closing-result/v1alpha1" as const;

/**
 * How the run's remediation sources were resolved — the ONE declaration.
 *
 * This shape used to exist TWICE under this one name: an exported copy in
 * `intakeResolver.ts` and a private copy in `nextStep.ts`, neither referencing
 * the other. Two declarations under one name is a reader trap — a reader cannot
 * tell which one a given annotation means, and the shared name is a standing
 * invitation for the two to diverge the moment either is edited. So the shape is
 * single-sourced here (the module both the resolver and the decide loop already
 * import) and the two sites import it rather than restating it.
 */
export interface InputResolution {
  /** True when the host supplied `--input` explicitly. */
  supplied: boolean;
  /** The resolved candidate paths that exist on disk. */
  existing: string[];
  /** Supplied paths that do not exist — the collect-starting-point prompt names them. */
  missing: string[];
  /** Every path probed, in probe order (supplied paths, or the default candidates). */
  checked: string[];
  /**
   * EVERY discovered source that exists — the full context set surfaced to the
   * host at the discovered-sources gate, not just the single `existing[0]` the
   * pipeline auto-selects. On the no-`--input` path this is all default
   * candidates that exist on disk; on the `--input` path it equals `existing`.
   * Used only to build the awareness manifest at the discovered-sources gate;
   * never narrows the pipeline's own single-best selection (which still uses
   * `existing`).
   */
  allExisting: string[];
}
