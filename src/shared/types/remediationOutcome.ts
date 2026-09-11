// Phase 7B — per-finding remediation outcome capture. The remediator emits one
// of these per finding into `remediation-outcomes.json` at close time. This is
// capture/surface only: it records what happened so a human (or a later
// calibration pass) can see how findings of each lens / file type fared. The
// auditor does not consume it automatically.

import { z } from "zod";

// CDC-25: the run's terminal-disposition vocabulary is
// T = { fixed, verified-already-fixed-at-HEAD, refuted-against-HEAD }. `fixed`
// already had two persisted encodings (`resolved` / `verified_no_change`);
// `verified_already_fixed` and `refuted` give the other two members of T their
// OWN persisted forms, so the distinction the run turns on is expressible in
// the machine contract itself rather than told apart only by free text (never
// collapsed onto `verified_no_change` and disambiguated in prose).
export const RemediationOutcomeStatusSchema = z.enum([
  "resolved",
  "verified_no_change",
  "inappropriate",
  "ignored",
  "blocked",
  "verified_already_fixed",
  "refuted",
]);
export type RemediationOutcomeStatus = z.infer<
  typeof RemediationOutcomeStatusSchema
>;

// CDC-28: `evidence.mechanism` is a structural enum, not free text, so RED
// condition (4)'s second leg — a persisted member CONTRADICTING the recorded
// mechanism — is a structural comparison (see `mechanismContradictsOutcome`
// below), never a substring match on English. `read_at_head_verification` is
// the mechanism that CONFIRMS a finding is already fixed at HEAD;
// `read_at_head_refutation` is the mechanism that determines a finding is not
// a real problem. The two are each other's contradiction for exactly the two
// outcome members (`verified_already_fixed` / `refuted`) that need one.
export const EVIDENCE_MECHANISM_KINDS = [
  "red_green_test",
  "build_lint_gate",
  "read_at_head_verification",
  "read_at_head_refutation",
] as const;
export const EvidenceMechanismKindSchema = z.enum(EVIDENCE_MECHANISM_KINDS);
export type EvidenceMechanismKind = z.infer<typeof EvidenceMechanismKindSchema>;

/**
 * The per-finding verification-evidence TRIPLE (INV-ISC-EVIDENCE-EMITTED):
 * `file` (a repo-relative path), `line` (a line or line range), and
 * `mechanism` (the structural enum above). This is the FLOOR of the widened
 * outcome record — a minimum the record must carry for a terminal disposition,
 * not a closed shape that excludes further fields later.
 */
export const EvidenceSchema = z
  .object({
    file: z.string().min(1),
    line: z.string().min(1),
    mechanism: EvidenceMechanismKindSchema,
    /** Optional human-readable elaboration; never load-bearing for the mechanism-contradiction check. */
    mechanism_detail: z.string().optional(),
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Whether `evidence` carries a complete triple (all three of file/line/
 * mechanism present and non-empty). The writer (`buildRemediationOutcomesReport`
 * in `src/remediate/phases/close.ts`) REFUSES to emit a terminal disposition
 * for a finding whose evidence fails this check.
 */
export function isCompleteEvidence(
  evidence: Partial<Evidence> | undefined,
): evidence is Evidence {
  return (
    evidence !== undefined &&
    typeof evidence.file === "string" &&
    evidence.file.length > 0 &&
    typeof evidence.line === "string" &&
    evidence.line.length > 0 &&
    typeof evidence.mechanism === "string" &&
    (EVIDENCE_MECHANISM_KINDS as readonly string[]).includes(evidence.mechanism)
  );
}

/** Names of the evidence-triple parts missing or empty on `evidence` (diagnostic only). */
export function missingEvidenceParts(
  evidence: Partial<Evidence> | undefined,
): Array<"file" | "line" | "mechanism"> {
  const missing: Array<"file" | "line" | "mechanism"> = [];
  if (!evidence || typeof evidence.file !== "string" || evidence.file.length === 0) {
    missing.push("file");
  }
  if (!evidence || typeof evidence.line !== "string" || evidence.line.length === 0) {
    missing.push("line");
  }
  if (
    !evidence ||
    typeof evidence.mechanism !== "string" ||
    !(EVIDENCE_MECHANISM_KINDS as readonly string[]).includes(evidence.mechanism)
  ) {
    missing.push("mechanism");
  }
  return missing;
}

/**
 * RED condition (4)'s mechanism-contradiction leg (CDC-25 / the W4 witness): a
 * `refuted` outcome whose mechanism is a read-at-HEAD VERIFICATION (confirms
 * already-fixed, not refuted), or a `verified_already_fixed` outcome whose
 * mechanism is a read-at-HEAD REFUTATION, is a WRONG VALUE — not a matter of
 * interpretation. Every other outcome/mechanism pairing is unconstrained by
 * this check (a red-green test or a build/lint gate is neutral evidence for
 * either of the two members).
 */
export function mechanismContradictsOutcome(
  outcome: RemediationOutcomeStatus,
  mechanism: EvidenceMechanismKind,
): boolean {
  if (outcome === "refuted" && mechanism === "read_at_head_verification") {
    return true;
  }
  if (outcome === "verified_already_fixed" && mechanism === "read_at_head_refutation") {
    return true;
  }
  return false;
}

// ── The ONE tool-owned gate-outcome vocabulary ───────────────────────────────
//
// Declared HERE, in the shared base layer, so every gate family names the three
// outcomes with the same words and the close/report path can consume one of
// them without importing a gate implementation. `src/remediate/steps/finalGate.ts`
// imports `FinalGateOutcomeKind` from this module rather than declaring a second
// copy — a gate that ran nothing was previously indistinguishable from a green
// floor precisely because the only thing recorded was a boolean, and two
// vocabularies for the same three outcomes would reintroduce that by another
// route.

/**
 * How a gate EVALUATION ended.
 *
 * `executed`   — the command list ran; `passed` is a real verdict.
 * `scoped_out` — the suite does not apply to this target; zero commands ran.
 * `disabled`   — a gate was DUE but did not run.
 * `history`    — a verdict for this exact tree content was already recorded, so
 *                the floor was NOT re-spawned; `passed` is that recorded verdict
 *                and `commands_run` counts the commands the RECORD held, never
 *                commands this evaluation ran. A fourth kind rather than a
 *                flavour of `executed`, because "the judge ran just now" and
 *                "a judge already ruled on this unchanged tree" are different
 *                facts about the same verdict — and a reader that cannot tell
 *                them apart cannot tell whether the floor is still being
 *                exercised at all.
 */
export const FinalGateOutcomeKindSchema = z.enum([
  "executed",
  "scoped_out",
  "disabled",
  "history",
]);
export type FinalGateOutcomeKind = z.infer<typeof FinalGateOutcomeKindSchema>;

/**
 * Which outcomes carry a REAL verdict. `executed` because a judge just ran;
 * `history` because a judge ran on this identical tree content and the answer
 * cannot have changed. Every other outcome — the not-run kinds AND the report's
 * own `absent` — has no verdict to report.
 *
 * Accepts `absent` as well as the gate kinds so the REPORT reader can ask this
 * one question rather than restating the list: a second hand-written list is
 * exactly how the next verdict-bearing kind comes back to read as absent.
 */
export function carriesGateVerdict(
  outcome: FinalGateOutcomeKind | "absent",
): boolean {
  return outcome === "executed" || outcome === "history";
}

/**
 * What the outcomes contract says about the run's tool-owned gate.
 *
 * `outcome` widens the gate kinds with `absent` — which is NOT a gate kind but
 * the report's own statement that no gate record existed for this run. It is
 * stated rather than inferred: the alternative is silence, and silence about a
 * gate reads as "fine".
 *
 * `passed` is `boolean | null`. Only a verdict-bearing kind ({@link
 * carriesGateVerdict}) carries one; every other kind carries `null`, so no
 * consumer of this contract can read a gate that did not run as a green floor.
 */
export const FinalGateReportSchema = z
  .object({
    outcome: z.union([FinalGateOutcomeKindSchema, z.literal("absent")]),
    passed: z.boolean().nullable(),
    commands_run: z.number(),
    /** Which gate produced it — a phase boundary, or the all-terminal funnel. */
    scope: z.string().optional(),
    /** Why a gate that did not run did not run, or why the record is absent. */
    reason: z.string().optional(),
    recorded_at: z.string().optional(),
  })
  .strict();
export type FinalGateReport = z.infer<typeof FinalGateReportSchema>;

/**
 * The report's statement when no gate record exists. A run that never reached a
 * gate, and a run whose gate record could not be read, both land here — never on
 * a green-shaped default.
 */
export const ABSENT_FINAL_GATE_REPORT: FinalGateReport = {
  outcome: "absent",
  passed: null,
  commands_run: 0,
  reason: "no tool-owned gate outcome was recorded for this run",
};

/**
 * One submission the run READMITTED, and through which verb.
 *
 * `kind` is the submission ledger's own event kind — declared as the two
 * recovery members rather than a boolean, because the two are not the same act:
 * `recovered_by_hand` re-lands a payload the normal lane's validator still
 * fully accepts, while `accepted_via_recovery` relaxed one of its corroboration
 * checks. A surface that collapsed them would erase exactly the difference that
 * makes a run's evidence bar legible.
 */
export const RecoveryMarkSchema = z
  .object({
    kind: z.enum(["recovered_by_hand", "accepted_via_recovery"]),
    submission_id: z.string(),
    lane: z.string(),
    issue_code: z.string().optional(),
    recorded_at: z.string(),
  })
  .strict();
export type RecoveryMark = z.infer<typeof RecoveryMarkSchema>;

/**
 * How the run's work was READMITTED, as read from the submission ledger at
 * close time.
 *
 * REQUIRED on the outcomes contract and never omitted: like {@link
 * FinalGateReport}, the clean case is written as an empty array rather than
 * left out, so a reader can distinguish "this run recovered nothing" from "this
 * release did not record the fact". The three-shape collapse the outcomes
 * contract exists to prevent — clean, repaired, unknown — was previously
 * expressible for the gate and not for recovery, so a run whose submission had
 * to be re-landed through a LOWER evidence bar produced a completion contract
 * byte-identical to a run that got it right first try.
 *
 * A recovery record is a monotone ACCUMULATOR over the run's ledger events: two
 * marks for one submission (say a hand re-land followed by a relaxed
 * acceptance) are two facts, and neither subsumes the other.
 */
export const RunRecoverySchema = z
  .object({
    recovered_by_hand: z.array(RecoveryMarkSchema),
    accepted_via_recovery: z.array(RecoveryMarkSchema),
    /** Ledger lines the close-phase read could not parse. See the writer. */
    dropped_lines: z.number(),
  })
  .strict();
export type RunRecovery = z.infer<typeof RunRecoverySchema>;

/**
 * The report's statement when the close-phase read found no recovery at all.
 * NOT the same as "the ledger could not be read": a read failure is reported by
 * the close phase itself rather than laundered into a clean-looking empty set.
 */
export const NO_RECOVERY: RunRecovery = {
  recovered_by_hand: [],
  accepted_via_recovery: [],
  dropped_lines: 0,
};

/** True when the run's ledger recorded any readmission. */
export function wasRecovered(recovery: RunRecovery): boolean {
  return (
    recovery.recovered_by_hand.length > 0 ||
    recovery.accepted_via_recovery.length > 0
  );
}

/**
 * Item C — result of the close-gate mechanical re-verify of an analyzer-born
 * finding. `verified_mechanically`: the finding's content-anchored lead
 * identity no longer fires on a re-run of the same pinned analyzer.
 * `lead_persists`: it still fires (objective evidence routed to triage).
 * `skipped`: the analyzer could not re-run (admission/resolve/spawn/parse) —
 * recorded with the reason, never silently treated as verified.
 */
export const MechanicalVerificationSchema = z
  .object({
    status: z.enum(["verified_mechanically", "lead_persists", "skipped"]),
    analyzer_id: z.string(),
    reason: z.string().optional(),
  })
  .strict();
export type MechanicalVerification = z.infer<typeof MechanicalVerificationSchema>;

export const RemediationOutcomeSchema = z
  .object({
    finding_id: z.string(),
    /** Audit lens the finding came from (free string in the wire contract). */
    lens: z.string(),
    /** Distinct file extensions of the finding's affected files (e.g. [".ts"]). */
    file_exts: z.array(z.string()),
    outcome: RemediationOutcomeStatusSchema,
    /** How many times the item was sent back for rework before this outcome. */
    rework_count: z.number(),
    /** The run's closing-action status (e.g. "success", "failed"). */
    closing_status: z.string(),
    /** Human-readable explanation for non-success closing statuses. */
    closing_status_reason: z.string().optional(),
    /**
     * For non-resolved outcomes: the failure or rationale text (e.g. why a
     * finding was deemed inappropriate, ignored, or blocked). Absent for
     * `resolved` and `verified_no_change` outcomes.
     */
    reason: z.string().optional(),
    /** ISO-8601 timestamp when work on this item first left pending. */
    started_at: z.string().optional(),
    /** ISO-8601 timestamp when the item reached its terminal status. */
    completed_at: z.string().optional(),
    /** Milliseconds between completed_at and started_at when both are present. */
    duration_ms: z.number().optional(),
    /** Item C — mechanical re-verify verdict for analyzer-born findings. */
    mechanical_verification: MechanicalVerificationSchema.optional(),
    /**
     * The per-finding verification-evidence triple (INV-ISC-EVIDENCE-EMITTED).
     * Optional at the schema level — a non-terminal (force-closed/blocked)
     * outcome may carry none — but the writer refuses to emit `outcome` as
     * `verified_already_fixed` or `refuted` without a complete one. FLOOR, not
     * a closed shape: pinning these three fields does not exclude later ones.
     */
    evidence: EvidenceSchema.optional(),
    /**
     * The attributing-module stamp (CDC-26): which module recorded this
     * finding's evidence at its own phase. Carried byte-exact from
     * `RemediationItemState.recorded_by_module` through to this record (the
     * ATTRIBUTION ROUND-TRIP) so the 26 INV-COVERAGE joins' condition (3) can
     * still tell which module closed which id.
     */
    recorded_by_module: z.string().optional(),
  })
  .strict();
export type RemediationOutcome = z.infer<typeof RemediationOutcomeSchema>;

// Full count keyed by every status (not Partial): built by summing all 7
// statuses, so each key is always present. An explicit object literal keeps the
// inferred type a complete `Record<RemediationOutcomeStatus, number>` rather
// than the Partial that `z.record(enum, …)` would infer (A6 gotcha).
const RemediationOutcomeCountsSchema = z
  .object({
    resolved: z.number(),
    verified_no_change: z.number(),
    inappropriate: z.number(),
    ignored: z.number(),
    blocked: z.number(),
    verified_already_fixed: z.number(),
    refuted: z.number(),
  })
  .strict();

// NOT strict: the on-disk remediation-outcomes.json is a superset of this shared
// subset (the remediator appends run-level fields like step_count / closing_result
// / plan_coverage). Unknown keys are tolerated so a real artifact still parses.
export const RemediationOutcomesReportSchema = z.object({
  contract_version: z.string(),
  total: z.number(),
  by_outcome: RemediationOutcomeCountsSchema,
  by_lens: z.record(z.string(), RemediationOutcomeCountsSchema.partial()),
  /** Earliest item started_at across all outcomes. */
  started_at: z.string().optional(),
  /** Latest item completed_at across all outcomes. */
  completed_at: z.string().optional(),
  /** Milliseconds between aggregate completed_at and started_at. */
  duration_ms: z.number().optional(),
  /**
   * The run's tool-owned gate outcome. REQUIRED, and never omitted on a run
   * that had no gate: the absent case is written as `{ outcome: "absent" }`, so
   * a reader can distinguish "the floor ran green" from "nothing ran" from "we
   * do not know" — which the outcomes contract previously could not express at
   * all, making a scoped-out or suppressed run's report byte-identical to an
   * executed-green one.
   */
  final_gate: FinalGateReportSchema,
  /**
   * How the run's work was READMITTED. REQUIRED, same shape as `final_gate`:
   * the clean case is `NO_RECOVERY` (empty sets), never an omitted key, so a
   * recovered run cannot render as a clean one and a pre-recovery release's
   * artifact cannot read as clean either.
   */
  recovery: RunRecoverySchema,
  outcomes: z.array(RemediationOutcomeSchema),
});
export type RemediationOutcomesReport = z.infer<
  typeof RemediationOutcomesReportSchema
>;
