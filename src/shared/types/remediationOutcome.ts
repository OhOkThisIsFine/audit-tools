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
  outcomes: z.array(RemediationOutcomeSchema),
});
export type RemediationOutcomesReport = z.infer<
  typeof RemediationOutcomesReportSchema
>;
