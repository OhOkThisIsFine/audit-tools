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
import { AnalyzerLeadProvenanceSchema } from "../analyzers/provenance.js";
import { ContentCoherenceTraceSchema } from "../decompose/contentCoherence.js";
import { MeasuredOutcomeSchema } from "../measurement/measuredOutcome.js";

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

export const FindingLocationObjectSchema = z.object({
  path: z.string(),
  line_start: z.number().int().min(1).optional(),
  line_end: z.number().int().min(1).optional(),
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

/**
 * THE one statement of each line-span rule (every draw, audit and remediate).
 * Exported so the dispatch prompt's contract block renders the very sentences
 * the schema enforces — {@link findingLocationLineIssues} emits these exact
 * strings, so wording cannot drift between the check and the prompt.
 */
export const FINDING_LINE_START_INTEGER_RULE =
  "affected_files[].line_start must be an integer >= 1.";
export const FINDING_LINE_END_INTEGER_RULE =
  "affected_files[].line_end must be an integer >= 1.";
export const FINDING_LINE_ORDER_RULE =
  "affected_files: when both ends are cited, line_start must be less than or equal to line_end.";

/** One violated line-span rule, naming the field that violates it. */
export interface FindingLocationLineIssue {
  field: "line_start" | "line_end";
  message: string;
}

/**
 * THE one evaluation of the line-span rules: when a location cites lines at
 * all, the span is 1-based integers with `line_start <= line_end`. Returns
 * every violated rule with its statement.
 *
 * Consumed by BOTH ingestion doors so neither can drift from the other: the
 * zod refinement ({@link refineFindingLocationLines}) turns these into schema
 * issues at parse time, and the downstream audit-results validator walks the
 * same function over its raw per-location records — the batch lane reaches
 * that validator WITHOUT a worker-projection parse, so the check has to live
 * there too, not only behind the parse.
 *
 * The fields stay `unknown`: callers hold everything from fully-parsed
 * locations to raw JSON payloads, and the guards below are exactly what makes
 * that honest.
 */
export function findingLocationLineIssues(location: {
  line_start?: unknown;
  line_end?: unknown;
}): readonly FindingLocationLineIssue[] {
  const issues: FindingLocationLineIssue[] = [];
  if (
    location.line_start !== undefined &&
    !Number.isInteger(location.line_start)
  ) {
    issues.push({
      field: "line_start",
      message: FINDING_LINE_START_INTEGER_RULE,
    });
  }
  if (location.line_end !== undefined && !Number.isInteger(location.line_end)) {
    issues.push({
      field: "line_end",
      message: FINDING_LINE_END_INTEGER_RULE,
    });
  }
  if (
    Number.isInteger(location.line_start) &&
    Number.isInteger(location.line_end) &&
    Number(location.line_start) > Number(location.line_end)
  ) {
    issues.push({
      field: "line_start",
      message: FINDING_LINE_ORDER_RULE,
    });
  }
  return issues;
}

/**
 * Applies {@link findingLocationLineIssues} as a zod refinement. Exported so
 * every projection applies the SAME refinement — `.superRefine` wraps in
 * ZodEffects, which cannot be re-`extend`ed, so each projection composes
 * object + refinement itself rather than this file baking them together and
 * freezing the shape.
 */
export const refineFindingLocationLines = (
  location: z.infer<typeof FindingLocationObjectSchema>,
  context: z.RefinementCtx,
): void => {
  for (const issue of findingLocationLineIssues(location)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [issue.field],
      message: issue.message,
    });
  }
};

export const FindingLocationSchema =
  FindingLocationObjectSchema.superRefine(refineFindingLocationLines);
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
 * Whether the DEFECT a conceptual finding names is present at HEAD — the third
 * axis, orthogonal to `grounding` (does it cite something real) and to the
 * remediation outcome (what did we do about it). Grounding on the conceptual
 * path certifies only that a cited component path exists, so it reads as
 * confirmation while certifying far less; this field carries the presence claim.
 *
 * EVERY value here is JUDGE-AUTHORED. `judge_confirmed` is deliberately NOT
 * spelled `confirmed`: the bare word is already taken by the executable-anchor
 * contract above, where "the confirmed bit is the tool's run, never the model's
 * word". This one is the opposite provenance — a judge's reading of HEAD, never
 * a tool run — and the name must say so wherever it is read.
 *
 * - `judge_confirmed`: the judge checked the named defect against current code
 *   and it holds. The tool guarantees the claim is PRESENT, CONSISTENT and
 *   PUBLISHED (and that a non-`asserted` claim carries a note); never that it is
 *   true.
 * - `asserted`: not checked. The default, and it is stated explicitly rather
 *   than left absent — an optional field defaults to silence, which is the
 *   failure this vocabulary exists to end.
 * - `refuted_at_head`: the judge checked and the defect is absent or already
 *   remediated. It can NEVER appear on an admitted finding: the adjudication
 *   validator forces a `refuted_at_head` candidate to `rejected`, and a rejected
 *   candidate maps to no final finding.
 */
export const FindingVerificationStatusSchema = z.enum([
  "judge_confirmed",
  "asserted",
  "refuted_at_head",
]);
export type FindingVerificationStatus = z.infer<
  typeof FindingVerificationStatusSchema
>;

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
   * How far up the goal graph a fix for this finding ripples (conceptual
   * design-review spine, Phase A). Simultaneously PRIORITY (high blast = high
   * value — re-drawing a charter boundary beats a leaf fix) and a RISK gate (a
   * wrong high-blast finding is catastrophic → it must clear a higher adversarial
   * bar before it is actionable). An integer height over the goal DAG; absent on
   * findings with no goal-graph linkage (treated as 0 when ranking). Populated by
   * the conceptual pass (later phases); deterministic findings omit it.
   */
  blast_radius: z.number().int().min(0).optional(),
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
   * Whether the defect this finding names is present at HEAD. TOOL-DERIVED at
   * conceptual ingest from the judge's per-candidate verification claims — host
   * supply is REFUSED, exactly as for `grounding`, so the value can always be
   * cross-checked against the adjudication record. Optional because the per-file
   * audit workers have no verification concept; absent outside the conceptual
   * design-review path.
   */
  verification_status: FindingVerificationStatusSchema.optional(),
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
  /**
   * Content-anchored identity of the analyzer lead this finding was born from
   * (item C). Copied verbatim from the injected lead by the auditing worker;
   * remediation's close-verify draw re-runs the analyzer and checks this exact
   * identity no longer fires. Absent on findings not born from analyzer leads.
   */
  analyzer_provenance: AnalyzerLeadProvenanceSchema.optional().describe(
    "Content-anchored identity of the analyzer lead this finding was born from. Copy it VERBATIM from the injected lead's provenance object; omit for findings not born from an analyzer lead.",
  ),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Report-level grouping of findings into parallelizable units of work. */
export const WorkBlockSchema = z.object({
  id: z.string(),
  finding_ids: z.array(z.string()),
  unit_ids: z.array(z.string()),
  owned_files: z.array(z.string()),
  /** Implementation work, or a broad/systemic coordination obligation. */
  role: z.enum(["implementation", "coordination"]),
  max_severity: FindingSeveritySchema,
  rationale: z.string(),
  depends_on: z.array(z.string()),
  /** Advisory deterministic content estimate; never a membership or fit claim. */
  token_estimate: z.number().int().nonnegative().optional(),
});
export type WorkBlock = z.infer<typeof WorkBlockSchema>;

/**
 * One CONTESTED FILE and every work block that owns it — a predicted write
 * conflict, which always requires a seam-first phase before those blocks may run
 * in parallel.
 *
 * The seam is keyed on the file rather than on a block PAIR: the conflict is a
 * property of the contested path, so N blocks over one file are one seam with N
 * `block_ids`, not N·(N−1)/2 records repeating it. `id` is derived from the file
 * (never positional) because `prepares_seam_ids` in the remediation contract
 * pipeline references it.
 */
export const WorkBlockSeamSchema = z
  .object({
    id: z.string(),
    /** The contested repo-relative path, forward-slashed. */
    file: z.string().min(1),
    /**
     * Every block owning `file`: at least two DISTINCT ids, sorted. `.min(2)` is
     * load-bearing (it is what makes the record a conflict), so a repeated id
     * must not satisfy it.
     */
    block_ids: z.array(z.string()).min(2),
    kind: z.enum(["predicted_write_conflict", "systemic_coordination"]),
    /**
     * A contested file IS a write conflict, so this is `true` by construction.
     * Stated as a literal rather than left to the producer: the remediation gate
     * and the phase cut both filter on `requires_preparation === true`, so a
     * seam that arrived `false` would be silently dropped rather than refused.
     */
    requires_preparation: z.literal(true),
    rationale: z.string(),
  })
  .superRefine((seam, context) => {
    if (new Set(seam.block_ids).size !== seam.block_ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["block_ids"],
        message: "block_ids must name at least two DISTINCT work blocks.",
      });
    }
  });
export type WorkBlockSeam = z.infer<typeof WorkBlockSeamSchema>;

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
 * The optional synthesis-narrative payload (Phase 6). Produced from one host
 * review of the deterministic findings and merged into `audit-findings.json`.
 * Omitted when no validated narrative result was supplied.
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

/**
 * What ONE lens the operator selected actually delivered.
 *
 * `lens_breakdown` is a `countBy` over what was PRODUCED, so a selected lens
 * that produced nothing has no key at all — and the render suppressed the whole
 * line on an empty map. A run therefore advertised the operator's chosen scope,
 * delivered a fraction of it, and nothing could distinguish "reviewed, nothing
 * found" from "never reviewed". This states the difference:
 *
 *   • `findings` — asked, and it found something.
 *   • `clean` — asked through a lens-open channel that was ingested, and there
 *     was nothing there. The ONLY value that may be read as "no defect".
 *   • `not_run` — selected, and no lens-open channel was ever ingested. Absence
 *     of a finding is not absence of a defect.
 */
export const LensCoverageEntrySchema = z
  .object({
    lens: z.string(),
    /** True when the operator's resolved selection includes this lens. */
    selected: z.boolean(),
    findings_count: z.number().int().min(0),
    outcome: MeasuredOutcomeSchema,
  })
  .strict();
export type LensCoverageEntry = z.infer<typeof LensCoverageEntrySchema>;

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
   * Per-status counts of the judge's defect-presence claim, over the FINDINGS —
   * `judge_confirmed` versus `asserted`, which is what lets a remediator rank
   * one above the other. `refuted_at_head` never appears here: the adjudication
   * validator forces a refuted candidate to `rejected`, and a rejected candidate
   * maps to no final finding. Absent when no finding carried a status.
   *
   * Finding-scoped, and deliberately NOT reconciled with the CANDIDATE-scoped
   * counts on `conceptual_review_adjudication.json`: the post-adjudication
   * grounding quarantine can drop a merged candidate's final finding, so the two
   * populations legitimately differ. One reconciled number would have to pick a
   * population and would hide the quarantine.
   */
  verification_status_breakdown: z.record(z.string(), z.number()).optional(),
  /**
   * What EVERY lens the operator selected delivered — the statement that makes
   * an absent `lens_breakdown` key legible. Optional because a run that carried
   * no lens selection has no coverage claim to make, and because the recovery
   * deliverable mints a summary from a flat finding set with no checkpoint at
   * all. PRESENCE is guaranteed at the synthesis boundary, which holds the
   * checkpoint; this schema and its validator own only internal consistency.
   */
  lens_coverage: z.array(LensCoverageEntrySchema).optional(),
});
export type AuditFindingsSummary = z.infer<typeof AuditFindingsSummarySchema>;

/**
 * The canonical `audit-findings.json` contract. Deterministic fields are always
 * present; narrative fields (themes/executive_summary/top_risks) are added by
 * the optional Phase 6 synthesis-narrative pass and omitted without a validated result.
 */
export const AuditFindingsReportSchema = z
  .object({
    contract_version: z.string(),
    summary: AuditFindingsSummarySchema,
    findings: z.array(FindingSchema),
    coherence_trace: ContentCoherenceTraceSchema,
    work_blocks: z.array(WorkBlockSchema),
    work_block_seams: z.array(WorkBlockSeamSchema),
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
  })
  .superRefine((report, context) => {
    const components = report.coherence_trace.components;
    if (components.length !== report.work_blocks.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["work_blocks"],
        message:
          "work_blocks must project exactly one block per coherence component.",
      });
      return;
    }
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index] ?? [];
      const findingIds = report.work_blocks[index]?.finding_ids ?? [];
      if (
        component.length !== findingIds.length ||
        component.some((id, memberIndex) => id !== findingIds[memberIndex])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["work_blocks", index, "finding_ids"],
          message:
            "finding_ids must exactly match the corresponding canonical coherence component.",
        });
      }
    }
    const findingIds = report.findings.map((finding) => finding.id).sort();
    const tracedIds = components.flat().sort();
    const normalizedIds = report.coherence_trace.normalized_items
      .map((item) => item.id)
      .sort();
    const sameIds = (left: string[], right: string[]): boolean =>
      left.length === right.length &&
      left.every((id, index) => id === right[index]);
    if (!sameIds(findingIds, tracedIds) || !sameIds(findingIds, normalizedIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coherence_trace", "components"],
        message:
          "coherence trace must cover every approved finding exactly once.",
      });
    }
  });
export type AuditFindingsReport = z.infer<typeof AuditFindingsReportSchema>;
