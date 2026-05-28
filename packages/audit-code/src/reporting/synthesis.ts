import type { AuditResult, CoverageMatrix, Finding, UnitManifest } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { CriticalFlowManifest, GraphBundle } from "@audit-tools/shared";
import { AUDITOR_REPORT_MARKER } from "@audit-tools/shared";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import { buildWorkBlocks, type WorkBlock } from "./workBlocks.js";
import { mergeFindings } from "./mergeFindings.js";

export interface AuditReportSummary {
  finding_count: number;
  work_block_count: number;
  severity_breakdown: Record<string, number>;
  audited_file_count: number;
  excluded_file_count: number;
  runtime_validation_status_breakdown: Record<string, number>;
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
} {
  const files = coverage?.files ?? [];
  return {
    audited_file_count: files.filter((file) => file.audit_status === "complete").length,
    excluded_file_count: files.filter((file) => file.audit_status === "excluded").length,
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
  const findings = mergeFindings(
    params.results,
    params.runtimeValidationReport,
    params.externalAnalyzerResults,
    params.designAssessment,
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
      runtime_validation_status_breakdown: runtimeStatusBreakdown(
        params.runtimeValidationReport,
      ),
    },
    findings,
    work_blocks: workBlocks,
  };
}

export function renderAuditReportMarkdown(model: AuditReportModel): string {
  const lines: string[] = [
    AUDITOR_REPORT_MARKER,
    "# Audit Report",
    "",
    "## Summary",
    "",
    `- Findings: ${model.summary.finding_count}`,
    `- Work blocks: ${model.summary.work_block_count}`,
    `- Severity breakdown: ${formatSeverityList(model.summary.severity_breakdown)}`,
    `- Fully audited files: ${model.summary.audited_file_count}`,
    `- Excluded non-auditable files: ${model.summary.excluded_file_count}`,
    "",
    "## Work Blocks",
    "",
  ];

  if (model.work_blocks.length === 0) {
    lines.push("No remediation work blocks were generated.", "");
  } else {
    for (const block of model.work_blocks) {
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
  if (model.findings.length === 0) {
    lines.push("No findings were recorded.", "");
  } else {
    for (const finding of model.findings) {
      lines.push(`### ${finding.id} — ${finding.title}`);
      lines.push("");
      lines.push(`- Severity: ${finding.severity}`);
      lines.push(`- Confidence: ${finding.confidence}`);
      lines.push(`- Lens: ${finding.lens}`);
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
  lines.push(
    "This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.",
  );
  lines.push("");
  return lines.join("\n");
}
