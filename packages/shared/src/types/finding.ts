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
  /** Content hash of the file when the finding was planned (remediator). */
  hash_at_plan_time?: string;
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

export interface AuditFindingsSummary {
  finding_count: number;
  work_block_count: number;
  severity_breakdown: Record<string, number>;
  audited_file_count: number;
  excluded_file_count: number;
  runtime_validation_status_breakdown: Record<string, number>;
  lens_breakdown?: Record<string, number>;
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
  themes?: FindingTheme[];
  executive_summary?: string;
  top_risks?: string[];
}
