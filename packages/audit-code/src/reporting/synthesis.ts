import type { AuditResult, CoverageMatrix, Finding, UnitManifest } from "../types.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type {
  AuditFindingsReport,
  CriticalFlowManifest,
  Finding as SharedFinding,
  FindingTheme,
  GraphBundle,
  SynthesisNarrative,
} from "@audit-tools/shared";
import { AUDITOR_REPORT_MARKER } from "@audit-tools/shared";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import { buildWorkBlocks, type WorkBlock } from "./workBlocks.js";
import { mergeFindings } from "./mergeFindings.js";
import { assignStableFindingIds } from "./findingIdentity.js";

/** Contract version stamped onto the canonical `audit-findings.json`. */
export const AUDIT_FINDINGS_CONTRACT_VERSION = "audit-tools/audit-findings/v1";

/**
 * Anything renderable as the deterministic audit report. Both `AuditReportModel`
 * (no narrative) and the canonical `AuditFindingsReport` (optionally carrying
 * themes/executive_summary/top_risks) satisfy this shape, so the same renderer
 * produces the base report and the narrative-enriched report.
 */
export interface RenderableAuditReport {
  summary: AuditReportSummary;
  // Widened to the shared Finding (lens: string) so both AuditReportModel (lens
  // narrowed to Lens) and the canonical AuditFindingsReport render unchanged.
  findings: SharedFinding[];
  work_blocks: WorkBlock[];
  themes?: FindingTheme[];
  executive_summary?: string;
  top_risks?: string[];
}

export interface AuditReportSummary {
  finding_count: number;
  work_block_count: number;
  severity_breakdown: Record<string, number>;
  audited_file_count: number;
  excluded_file_count: number;
  runtime_validation_status_breakdown: Record<string, number>;
  /**
   * Distinct count of tasks/files NOT audited because a packet budget cap
   * (FINDING-013) deferred them — kept separate from `excluded_file_count`
   * (non-auditable files), since a budget skip is an honest partial-coverage
   * signal, not an exclusion. Optional so the shared `AuditFindingsSummary`
   * (which omits it) stays assignable to this render shape; defaults to 0.
   */
  budget_deferred_task_count?: number;
}

export interface AuditReportModel {
  summary: AuditReportSummary;
  findings: Finding[];
  work_blocks: WorkBlock[];
}

function countBy<T>(
  items: Iterable<T>,
  selectKey: (item: T) => string | undefined,
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const item of items) {
    const key = selectKey(item);
    if (!key) {
      continue;
    }
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

function severityBreakdown(findings: Finding[]): Record<string, number> {
  return countBy(findings, (finding) => finding.severity);
}

function runtimeStatusBreakdown(
  report?: RuntimeValidationReport,
): Record<string, number> {
  return countBy(report?.results ?? [], (result) => result.status);
}

function coverageSummary(coverage?: CoverageMatrix): {
  audited_file_count: number;
  excluded_file_count: number;
  budget_deferred_task_count: number;
} {
  const files = coverage?.files ?? [];
  return {
    audited_file_count: files.filter((file) => file.audit_status === "complete").length,
    excluded_file_count: files.filter((file) => file.audit_status === "excluded").length,
    // Distinct from excluded: files a budget cap deferred (status set by scope).
    budget_deferred_task_count: files.filter(
      (file) => file.audit_status === "budget_deferred",
    ).length,
  };
}

function formatSeverityList(summary: Record<string, number>): string {
  const ordered = ["critical", "high", "medium", "low", "info"];
  const parts = ordered
    .filter((severity) => (summary[severity] ?? 0) > 0)
    .map((severity) => `${severity}: ${summary[severity]}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function buildAuditReportModel(params: {
  results: AuditResult[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
  coverageMatrix?: CoverageMatrix;
  runtimeValidationReport?: RuntimeValidationReport;
  externalAnalyzerResults?: ExternalAnalyzerResults;
  designAssessment?: DesignAssessment;
}): AuditReportModel {
  // Re-key the finalized findings with globally-unique, content-derived ids
  // before anything addresses them by id. buildWorkBlocks keys its union-find on
  // finding.id, so the locally-scoped, collision-prone ids worker packets emit
  // must be replaced here or unrelated findings fuse into one block.
  const findings = assignStableFindingIds(
    mergeFindings(
      params.results,
      params.runtimeValidationReport,
      params.externalAnalyzerResults,
      params.designAssessment,
    ),
  );
  const workBlocks = buildWorkBlocks({
    findings,
    unitManifest: params.unitManifest,
    graphBundle: params.graphBundle,
    criticalFlows: params.criticalFlows,
  });
  const coverage = coverageSummary(params.coverageMatrix);
  return {
    summary: {
      finding_count: findings.length,
      work_block_count: workBlocks.length,
      severity_breakdown: severityBreakdown(findings),
      audited_file_count: coverage.audited_file_count,
      excluded_file_count: coverage.excluded_file_count,
      budget_deferred_task_count: coverage.budget_deferred_task_count,
      runtime_validation_status_breakdown: runtimeStatusBreakdown(
        params.runtimeValidationReport,
      ),
    },
    findings,
    work_blocks: workBlocks,
  };
}

/**
 * Wrap the deterministic report model in the canonical `audit-findings.json`
 * contract — the machine hand-off consumed by the remediator. Narrative fields
 * are absent here; they are layered on later by {@link applyNarrative}.
 */
export function buildAuditFindingsReport(
  model: AuditReportModel,
): AuditFindingsReport {
  return {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary: { ...model.summary },
    findings: model.findings,
    work_blocks: model.work_blocks,
  };
}

/**
 * Merge an LLM synthesis narrative into the canonical findings report: keep only
 * themes whose `finding_ids` reference real findings, tag each covered finding
 * with its (first-claiming) `theme_id`, and attach the executive summary / top
 * risks. Deterministic and idempotent — the same narrative yields the same
 * report.
 */
export function applyNarrative(
  report: AuditFindingsReport,
  narrative: SynthesisNarrative,
): AuditFindingsReport {
  const validFindingIds = new Set(report.findings.map((finding) => finding.id));
  const themeByFinding = new Map<string, string>();
  const themes: FindingTheme[] = [];

  for (const theme of narrative.themes ?? []) {
    const findingIds = [
      ...new Set((theme.finding_ids ?? []).filter((id) => validFindingIds.has(id))),
    ];
    themes.push({
      theme_id: theme.theme_id,
      title: theme.title,
      root_cause: theme.root_cause,
      finding_ids: findingIds,
      suggested_fix_pattern: theme.suggested_fix_pattern,
    });
    for (const id of findingIds) {
      if (!themeByFinding.has(id)) {
        themeByFinding.set(id, theme.theme_id);
      }
    }
  }

  const findings = report.findings.map((finding) =>
    themeByFinding.has(finding.id)
      ? { ...finding, theme_id: themeByFinding.get(finding.id) }
      : finding,
  );

  return {
    ...report,
    findings,
    themes,
    executive_summary: narrative.executive_summary,
    top_risks: narrative.top_risks,
  };
}

export interface RenderAuditReportOptions {
  /** Scope manifest for the run; when delta, the report header reports it honestly. */
  scope?: AuditScopeManifest;
}

export function renderAuditReportMarkdown(
  report: RenderableAuditReport,
  options: RenderAuditReportOptions = {},
): string {
  const lines: string[] = [
    AUDITOR_REPORT_MARKER,
    "# Audit Report",
    "",
  ];

  if (report.executive_summary && report.executive_summary.trim().length > 0) {
    lines.push("## Executive Summary", "", report.executive_summary.trim(), "");
  }

  lines.push(
    "## Summary",
    "",
    `- Findings: ${report.summary.finding_count}`,
    `- Work blocks: ${report.summary.work_block_count}`,
    `- Severity breakdown: ${formatSeverityList(report.summary.severity_breakdown)}`,
    `- Fully audited files: ${report.summary.audited_file_count}`,
    `- Excluded non-auditable files: ${report.summary.excluded_file_count}`,
    ...((report.summary.budget_deferred_task_count ?? 0) > 0
      ? [
          `- Not audited (budget): ${report.summary.budget_deferred_task_count} task(s) skipped by packet budget cap`,
        ]
      : []),
    "",
  );

  if (report.top_risks && report.top_risks.length > 0) {
    lines.push("## Top Risks", "");
    for (const risk of report.top_risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  if (report.themes && report.themes.length > 0) {
    lines.push("## Themes", "");
    for (const theme of report.themes) {
      lines.push(`### ${theme.theme_id} — ${theme.title}`);
      lines.push("");
      lines.push(`- Root cause: ${theme.root_cause}`);
      lines.push(
        `- Findings: ${theme.finding_ids.length > 0 ? theme.finding_ids.join(", ") : "none"}`,
      );
      lines.push(`- Suggested fix pattern: ${theme.suggested_fix_pattern}`);
      lines.push("");
    }
  }

  lines.push("## Work Blocks", "");

  if (report.work_blocks.length === 0) {
    lines.push("No remediation work blocks were generated.", "");
  } else {
    for (const block of report.work_blocks) {
      lines.push(`### ${block.id}`);
      lines.push("");
      lines.push(`- Max severity: ${block.max_severity}`);
      lines.push(`- Units: ${block.unit_ids.join(", ")}`);
      lines.push(`- Owned files: ${block.owned_files.join(", ")}`);
      lines.push(`- Findings: ${block.finding_ids.join(", ")}`);
      lines.push(
        `- Depends on: ${block.depends_on.length > 0 ? block.depends_on.join(", ") : "none"}`,
      );
      lines.push(`- Rationale: ${block.rationale}`);
      lines.push("");
    }
  }

  lines.push("## Findings", "");
  if (report.findings.length === 0) {
    lines.push("No findings were recorded.", "");
  } else {
    for (const finding of report.findings) {
      lines.push(`### ${finding.id} — ${finding.title}`);
      lines.push("");
      lines.push(`- Severity: ${finding.severity}`);
      lines.push(`- Confidence: ${finding.confidence}`);
      lines.push(`- Lens: ${finding.lens}`);
      if (finding.theme_id) {
        lines.push(`- Theme: ${finding.theme_id}`);
      }
      lines.push(`- Files: ${finding.affected_files.map((file) => file.path).join(", ")}`);
      lines.push(`- Summary: ${finding.summary}`);
      if (finding.evidence && finding.evidence.length > 0) {
        lines.push("- Evidence:");
        for (const evidence of finding.evidence) {
          lines.push(`  - ${evidence}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("## Scope and Coverage", "");
  const scope = options.scope;
  if (scope && scope.mode === "delta") {
    lines.push(
      `**Delta audit since \`${scope.since}\`.** This run audited ${scope.seed_files.length} changed file(s) and ${scope.expanded_files.length} graph neighbour(s); all other auditable files were left out of scope (inherited from a prior audit where complete, otherwise excluded from this run). **A full audit is advised before release.**`,
    );
    if (scope.dropped_note) {
      lines.push("", scope.dropped_note);
    }
  } else if (scope && scope.mode === "budget") {
    lines.push(
      `**Partial audit (budget cap).** This run dispatched only the top-${scope.budget?.max_files ?? "K"} packet(s); ` +
        `${scope.deferred_packet_count ?? 0} packet(s) covering ${scope.deferred_task_ids?.length ?? 0} task(s) were deferred and NOT audited. ` +
        `Findings above reflect only the audited subset. **A full audit is advised before release.**`,
    );
    if (scope.dropped_note) {
      lines.push("", scope.dropped_note);
    }
  } else {
    lines.push(
      "This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.",
    );
  }
  lines.push("");
  return lines.join("\n");
}
