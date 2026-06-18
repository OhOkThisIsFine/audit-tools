// Canonical machine contract for audit findings — the shape that flows from the
// auditor's `audit-findings.json` into the remediator. Before Phase 0 `Finding`
// was redefined in each package; this is the single source of truth. The
// auditor narrows `lens` to its `Lens` union (via Omit) and the remediator uses
// `Finding` directly. New optional fields (e.g. `theme_id`, added in Phase 6)
// land here and propagate to both.
//
// A6: the contract is now defined ONCE as a zod schema; the TypeScript types are
// `z.infer`red from it and the worker-facing JSON schema is generated from the
// strict projection below (see `workerFindingSchema`). There is no longer a
// hand-written JSON schema to drift from these types.

import { z } from "zod";

/** Canonical finding severity vocabulary (most-severe-first). */
export const FindingSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Canonical finding confidence vocabulary (most-confident-first). */
export const FindingConfidenceSchema = z.enum(["high", "medium", "low"]);
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>;

export const FindingLocationSchema = z.object({
  path: z.string(),
  line_start: z.number().int().optional(),
  line_end: z.number().int().optional(),
  symbol: z.string().optional(),
  /**
   * Verbatim text copied from this span, exactly as it appears in the cited
   * file. The tool re-reads the file and content-matches this quote
   * (whitespace/CRLF-normalized, matched on content not line numbers) to ground
   * the finding; a finding whose quote does not re-verify is marked ungrounded
   * (S7 anti-hallucination — grounding the claim, not attesting the read).
   */
  quoted_text: z.string().optional(),
  /** Content hash of the file when the finding was planned (remediator). */
  hash_at_plan_time: z.string().optional(),
});
export type FindingLocation = z.infer<typeof FindingLocationSchema>;

/**
 * Result of re-verifying a finding's cited verbatim span against disk. Attached
 * by the auditor's grounding pass at ingest; a hallucinated or stale finding
 * (quote not found on disk, or no quote provided) is surfaced as `ungrounded`
 * rather than silently admitted as a confirmed finding.
 *
 * - `grounded`: the cited verbatim span re-verified against disk (S7 tier-1) or
 *   an executable anchor CONFIRMED the behavior claim (tier-2). Admitted as fact.
 * - `ungrounded`: the cited span did not re-verify, or no span was provided —
 *   surfaced-but-not-confirmed. Stays in the admitted findings, flagged.
 * - `refuted`: an executable anchor DISPROVED the claim (tier-2; e.g. a
 *   madge-disproven cycle). Distinct from `ungrounded` ("couldn't verify"):
 *   the tool actively disproved it, so it is quarantined-EXCLUDED from the
 *   admitted contract (see `AuditFindingsReport.quarantined_findings`).
 */
export const FindingGroundingSchema = z.object({
  status: z.enum(["grounded", "ungrounded", "refuted"]),
  /** When ungrounded/refuted, which cited span(s) failed and why. */
  reason: z.string().optional(),
});
export type FindingGrounding = z.infer<typeof FindingGroundingSchema>;

/**
 * What outcome of an executable anchor's command CONFIRMS the finding's claim.
 * The worker declares the falsifiable condition; the tool runs the command and
 * checks it, so the confirmed bit is the tool's run, never the model's word.
 * `text` is required for the output_* kinds (the substring to look for).
 */
export const AnchorExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exit_zero") }),
  z.object({ kind: z.literal("exit_nonzero") }),
  z.object({ kind: z.literal("output_includes"), text: z.string() }),
  z.object({ kind: z.literal("output_excludes"), text: z.string() }),
]);
export type AnchorExpectation = z.infer<typeof AnchorExpectationSchema>;

/**
 * An executable anchor for a *behavior* claim ("throws" / "test fails" / "no
 * cycle" / "unused symbol") — S7 tier-2. A read-only inspection command the tool
 * runs to confirm or refute the claim; a refuting run quarantines the finding as
 * ungrounded, exactly what disproved hallucinated cycle/symbol findings in the
 * 452-self-audit. `command` is argv (run without a shell, from the repo root);
 * the executable must be in the tool's inspection-only allowlist or the anchor is
 * skipped (not auto-run). `confirm_if` is the falsifiable condition that, when
 * the tool runs `command`, demonstrates the claim is true.
 */
export const ExecutableAnchorSchema = z.object({
  command: z.array(z.string()).min(1),
  confirm_if: AnchorExpectationSchema,
  /** Optional human description of what running the command proves. */
  claim: z.string().optional(),
});
export type ExecutableAnchor = z.infer<typeof ExecutableAnchorSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  severity: FindingSeveritySchema,
  confidence: FindingConfidenceSchema,
  /** Audit lens; the auditor narrows this to its `Lens` union. */
  lens: z.string(),
  summary: z.string(),
  affected_files: z.array(FindingLocationSchema),
  impact: z.string().optional(),
  likelihood: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  reproduction: z.array(z.string()).optional(),
  systemic: z.boolean().optional(),
  related_findings: z.array(z.string()).optional(),
  /** Synthesis theme this finding belongs to (Phase 6). */
  theme_id: z.string().optional(),
  /**
   * Whether at least one evidence entry cites a real repo path (and valid line)
   * that exists on disk. Set by the remediator's deterministic grounding pass on
   * LLM-extracted findings; absent on auditor-produced findings (already grounded).
   */
  evidence_grounded: z.boolean().optional(),
  /**
   * Result of the auditor's quote-and-verify grounding pass (S7): whether this
   * finding's cited verbatim span re-verified against disk. Absent until the
   * grounding pass runs at ingest.
   */
  grounding: FindingGroundingSchema.optional(),
  /**
   * Optional executable anchor for a behavior claim (S7 tier-2). The tool runs
   * the read-only `command` at ingest and folds the verdict into `grounding`: a
   * refuting run marks the finding ungrounded (quarantined) with the run as the
   * reason, a confirming run grounds it; an inconclusive/skipped run leaves the
   * quote-and-verify (tier-1) grounding in place. Absent for findings with no
   * runnable behavior claim.
   */
  executable_anchor: ExecutableAnchorSchema.optional(),
  /** Contract-pipeline goal this generated remediation finding belongs to. */
  contract_goal_id: z.string().optional(),
  /** Contract-pipeline obligation IDs this finding/task is intended to satisfy. */
  contract_obligation_ids: z.array(z.string()).optional(),
  /** Contract-pipeline verification obligation IDs this task must prove. */
  verification_obligation_ids: z.array(z.string()).optional(),
  /** Commands recommended by the implementation DAG for focused verification. */
  targeted_commands: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Report-level grouping of findings into parallelizable units of work. */
export const WorkBlockSchema = z.object({
  id: z.string(),
  finding_ids: z.array(z.string()),
  unit_ids: z.array(z.string()),
  owned_files: z.array(z.string()),
  max_severity: FindingSeveritySchema,
  rationale: z.string(),
  depends_on: z.array(z.string()),
});
export type WorkBlock = z.infer<typeof WorkBlockSchema>;

/** A synthesis theme: a root cause spanning several findings (Phase 6). */
export const FindingThemeSchema = z.object({
  theme_id: z.string(),
  title: z.string(),
  root_cause: z.string(),
  finding_ids: z.array(z.string()),
  suggested_fix_pattern: z.string(),
});
export type FindingTheme = z.infer<typeof FindingThemeSchema>;

/**
 * The optional LLM synthesis-narrative payload (Phase 6). Produced by a single
 * cached host/provider pass over the deterministic findings and merged into
 * `audit-findings.json`. Omitted entirely when no provider is available.
 */
export const SynthesisNarrativeSchema = z.object({
  themes: z.array(FindingThemeSchema),
  executive_summary: z.string().optional(),
  top_risks: z.array(z.string()).optional(),
});
export type SynthesisNarrative = z.infer<typeof SynthesisNarrativeSchema>;

/**
 * The canonical identity subset of a Finding — the fields that identify it
 * across the audit→remediate pipeline without contract-pipeline overlays.
 *
 * INV-shared-core-05: consumers that need to identify a finding (deduplicate,
 * compare, index) should use this type rather than stripping contract_* fields
 * ad-hoc. `findingIdentity()` extracts it safely.
 */
export interface FindingIdentity {
  id: string;
  title: string;
  severity: FindingSeverity;
  lens: string;
  affected_files: FindingLocation[];
  summary: string;
}

/**
 * Extract the canonical identity subset from a Finding, dropping any
 * contract-pipeline overlay fields (contract_goal_id, contract_obligation_ids,
 * verification_obligation_ids, targeted_commands). This is the stable,
 * pipeline-portable representation of what a finding IS, separate from how it
 * participates in a particular remediation run.
 *
 * INV-shared-core-05 invariant: the result must be derivable without knowing
 * which contract-pipeline fields are present, and must round-trip through JSON
 * without carrying any contract_* fields.
 */
export function findingIdentity(finding: Finding): FindingIdentity {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    lens: finding.lens,
    affected_files: finding.affected_files,
    summary: finding.summary,
  };
}

export const AuditFindingsSummarySchema = z.object({
  finding_count: z.number(),
  work_block_count: z.number(),
  severity_breakdown: z.record(z.string(), z.number()),
  audited_file_count: z.number(),
  excluded_file_count: z.number(),
  runtime_validation_status_breakdown: z.record(z.string(), z.number()),
  lens_breakdown: z.record(z.string(), z.number()).optional(),
  /**
   * Per-status counts of the auditor's grounding pass (S7): `grounded`
   * (re-verified against disk or anchor-confirmed), `ungrounded`
   * (surfaced-but-not-confirmed), `refuted` (anchor-DISPROVED →
   * quarantined-excluded). Counted over ALL findings incl. the
   * quarantined-refuted ones, so a non-zero `refuted` reflects findings that were
   * dropped from the admitted set. Absent when no finding carried a verdict.
   */
  grounding_status_breakdown: z.record(z.string(), z.number()).optional(),
  /**
   * Units/tasks stranded by a partial-completion terminal (empty-pool or
   * livelock guard). Distinct from `budget_deferred_task_count` (planned
   * deferrals) — these units could not be dispatched because the provider pool
   * was exhausted before dispatch completed. Present only when a
   * `partial_completion_terminal` was set on the active-dispatch artifact.
   */
  stranded_unit_count: z.number().optional(),
});
export type AuditFindingsSummary = z.infer<typeof AuditFindingsSummarySchema>;

/**
 * The canonical `audit-findings.json` contract. Deterministic fields are always
 * present; narrative fields (themes/executive_summary/top_risks) are added by
 * the optional Phase 6 synthesis-narrative pass and omitted without a provider.
 */
export const AuditFindingsReportSchema = z.object({
  contract_version: z.string(),
  summary: AuditFindingsSummarySchema,
  findings: z.array(FindingSchema),
  work_blocks: z.array(WorkBlockSchema),
  /**
   * Findings a tool-executable anchor REFUTED (S7 tier-2 disproof). Recorded here
   * but kept OUT of `findings`/`work_blocks` so a disproven claim never merges as
   * actionable fact — quarantine, not delete. Absent when nothing was refuted.
   */
  quarantined_findings: z.array(FindingSchema).optional(),
  /** Paths excluded from the audit per the intent checkpoint, with reasons. */
  excluded_scope: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .optional(),
  themes: z.array(FindingThemeSchema).optional(),
  executive_summary: z.string().optional(),
  top_risks: z.array(z.string()).optional(),
});
export type AuditFindingsReport = z.infer<typeof AuditFindingsReportSchema>;
