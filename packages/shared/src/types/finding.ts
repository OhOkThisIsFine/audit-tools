// Canonical machine contract for audit findings — the shape that flows from the
// auditor's `audit-findings.json` into the remediator. Before Phase 0 `Finding`
// was redefined in each package; this is the single source of truth. The
// auditor narrows `lens` to its `Lens` union (via Omit) and the remediator uses
// `Finding` directly. New optional fields (e.g. `theme_id`, added in Phase 6)
// land here and propagate to both.

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingConfidence = "high" | "medium" | "low";

export interface FindingLocation {
  path: string;
  line_start?: number;
  line_end?: number;
  symbol?: string;
  /**
   * Verbatim text copied from this span, exactly as it appears in the cited
   * file. The tool re-reads the file and content-matches this quote
   * (whitespace/CRLF-normalized, matched on content not line numbers) to ground
   * the finding; a finding whose quote does not re-verify is marked ungrounded
   * (S7 anti-hallucination — grounding the claim, not attesting the read).
   */
  quoted_text?: string;
  /** Content hash of the file when the finding was planned (remediator). */
  hash_at_plan_time?: string;
}

/**
 * Result of re-verifying a finding's cited verbatim span against disk. Attached
 * by the auditor's grounding pass at ingest; a hallucinated or stale finding
 * (quote not found on disk, or no quote provided) is surfaced as `ungrounded`
 * rather than silently admitted as a confirmed finding.
 */
export interface FindingGrounding {
  status: "grounded" | "ungrounded";
  /** When ungrounded, which cited span(s) failed to re-verify and why. */
  reason?: string;
}

export interface Finding {
  id: string;
  title: string;
  category: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  /** Audit lens; the auditor narrows this to its `Lens` union. */
  lens: string;
  summary: string;
  affected_files: FindingLocation[];
  impact?: string;
  likelihood?: string;
  evidence?: string[];
  reproduction?: string[];
  systemic?: boolean;
  related_findings?: string[];
  /** Synthesis theme this finding belongs to (Phase 6). */
  theme_id?: string;
  /**
   * Whether at least one evidence entry cites a real repo path (and valid line)
   * that exists on disk. Set by the remediator's deterministic grounding pass on
   * LLM-extracted findings; absent on auditor-produced findings (already grounded).
   */
  evidence_grounded?: boolean;
  /**
   * Result of the auditor's quote-and-verify grounding pass (S7): whether this
   * finding's cited verbatim span re-verified against disk. Absent until the
   * grounding pass runs at ingest.
   */
  grounding?: FindingGrounding;
  /** Contract-pipeline goal this generated remediation finding belongs to. */
  contract_goal_id?: string;
  /** Contract-pipeline obligation IDs this finding/task is intended to satisfy. */
  contract_obligation_ids?: string[];
  /** Contract-pipeline verification obligation IDs this task must prove. */
  verification_obligation_ids?: string[];
  /** Commands recommended by the implementation DAG for focused verification. */
  targeted_commands?: string[];
}

/** Report-level grouping of findings into parallelizable units of work. */
export interface WorkBlock {
  id: string;
  finding_ids: string[];
  unit_ids: string[];
  owned_files: string[];
  max_severity: FindingSeverity;
  rationale: string;
  depends_on: string[];
}

/** A synthesis theme: a root cause spanning several findings (Phase 6). */
export interface FindingTheme {
  theme_id: string;
  title: string;
  root_cause: string;
  finding_ids: string[];
  suggested_fix_pattern: string;
}

/**
 * The optional LLM synthesis-narrative payload (Phase 6). Produced by a single
 * cached host/provider pass over the deterministic findings and merged into
 * `audit-findings.json`. Omitted entirely when no provider is available.
 */
export interface SynthesisNarrative {
  themes: FindingTheme[];
  executive_summary?: string;
  top_risks?: string[];
}

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

export interface AuditFindingsSummary {
  finding_count: number;
  work_block_count: number;
  severity_breakdown: Record<string, number>;
  audited_file_count: number;
  excluded_file_count: number;
  runtime_validation_status_breakdown: Record<string, number>;
  lens_breakdown?: Record<string, number>;
  /**
   * Per-status counts of the auditor's quote-and-verify grounding pass (S7):
   * how many findings re-verified against disk (`grounded`) vs. were quarantined
   * as unverifiable (`ungrounded`). Absent when no finding carried a grounding
   * verdict (the grounding pass did not run on this report). A non-zero
   * `ungrounded` count means some findings are surfaced-but-not-confirmed — see
   * the report's "Ungrounded Findings (quarantined)" section.
   */
  grounding_status_breakdown?: Record<string, number>;
  /**
   * Units/tasks stranded by a partial-completion terminal (empty-pool or
   * livelock guard). Distinct from `budget_deferred_task_count` (planned
   * deferrals) — these units could not be dispatched because the provider pool
   * was exhausted before dispatch completed. Present only when a
   * `partial_completion_terminal` was set on the active-dispatch artifact.
   */
  stranded_unit_count?: number;
}

/**
 * The canonical `audit-findings.json` contract. Deterministic fields are always
 * present; narrative fields (themes/executive_summary/top_risks) are added by
 * the optional Phase 6 synthesis-narrative pass and omitted without a provider.
 */
export interface AuditFindingsReport {
  contract_version: string;
  summary: AuditFindingsSummary;
  findings: Finding[];
  work_blocks: WorkBlock[];
  /** Paths excluded from the audit per the intent checkpoint, with reasons. */
  excluded_scope?: Array<{ path: string; reason: string }>;
  themes?: FindingTheme[];
  executive_summary?: string;
  top_risks?: string[];
}
