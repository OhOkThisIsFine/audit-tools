import type { AuditResult, CoverageMatrix, Finding, UnitManifest } from "../types.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { IntentCheckpoint } from "audit-tools/shared";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { ActiveDispatchState } from "../types/activeDispatch.js";
import type {
  AuditFindingsReport,
  CriticalFlowManifest,
  Finding as SharedFinding,
  FindingTheme,
  GraphBundle,
  SynthesisNarrative,
} from "audit-tools/shared";
import {
  AUDIT_FINDINGS_CONTRACT_VERSION as SHARED_AUDIT_FINDINGS_CONTRACT_VERSION,
  AUDITOR_REPORT_MARKER,
  renderProcessFeedbackSection,
  type AgentReflection,
} from "audit-tools/shared";
import type {
  RuntimeValidationReport,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";
import { buildWorkBlocks, type WorkBlock } from "./workBlocks.js";
import { mergeFindings } from "./mergeFindings.js";
import { assignStableFindingIds } from "./findingIdentity.js";

/**
 * Contract version stamped onto the canonical `audit-findings.json`.
 * Single-sourced from `audit-tools/shared` so the auditor's output and the
 * remediator's validator can never drift (guarded by the
 * `seam-artifact-ipc-envelope` test).
 */
export const AUDIT_FINDINGS_CONTRACT_VERSION =
  SHARED_AUDIT_FINDINGS_CONTRACT_VERSION;

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
  /** Tool-REFUTED findings excluded from the admitted set (B4); rendered separately. */
  quarantined_findings?: SharedFinding[];
  themes?: FindingTheme[];
  executive_summary?: string;
  top_risks?: string[];
}

export interface AuditReportSummary {
  finding_count: number;
  work_block_count: number;
  severity_breakdown: Record<string, number>;
  lens_breakdown?: Record<string, number>;
  audited_file_count: number;
  excluded_file_count: number;
  runtime_validation_status_breakdown: Record<string, number>;
  /**
   * Per-status counts (grounded/ungrounded) of the S7 grounding pass. Optional
   * so the shared `AuditFindingsSummary` (which also makes it optional) stays
   * assignable to this render shape; absent when no finding carried a verdict.
   */
  grounding_status_breakdown?: Record<string, number>;
  /**
   * Distinct count of tasks/files NOT audited because a packet budget cap
   * (FINDING-013) deferred them — kept separate from `excluded_file_count`
   * (non-auditable files), since a budget skip is an honest partial-coverage
   * signal, not an exclusion. Optional so the shared `AuditFindingsSummary`
   * (which omits it) stays assignable to this render shape; defaults to 0.
   */
  budget_deferred_task_count?: number;
  /**
   * Units/tasks stranded by a partial-completion terminal (empty-pool or
   * livelock guard). Distinct from budget deferrals. Optional so the shared
   * `AuditFindingsSummary` stays assignable to this render shape.
   */
  stranded_unit_count?: number;
}

export interface AuditReportModel {
  summary: AuditReportSummary;
  findings: Finding[];
  work_blocks: WorkBlock[];
  /** Tool-REFUTED findings (S7 tier-2 disproof) excluded from the admitted set. */
  quarantined_findings?: Finding[];
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

function lensBreakdown(findings: Finding[]): Record<string, number> {
  return countBy(findings, (finding) => finding.lens);
}

/**
 * Per-status counts of the S7 grounding pass over the findings. Findings with no
 * grounding verdict (the pass did not run on them) are skipped by `countBy`, so
 * an empty result means "no finding was graded" and the caller omits the field.
 */
function groundingStatusBreakdown(findings: Finding[]): Record<string, number> {
  return countBy(findings, (finding) => finding.grounding?.status);
}

function runtimeStatusBreakdown(
  report?: RuntimeValidationReport,
  taskManifest?: RuntimeValidationTaskManifest,
): Record<string, number> {
  const breakdown = countBy(report?.results ?? [], (result) => result.status);
  const resultTaskIds = new Set((report?.results ?? []).map((result) => result.task_id));
  for (const task of taskManifest?.tasks ?? []) {
    if (!resultTaskIds.has(task.id)) {
      breakdown.pending = (breakdown.pending ?? 0) + 1;
    }
  }
  return breakdown;
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

function formatCountList(summary: Record<string, number>): string {
  const parts = Object.entries(summary)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function buildAuditReportModel(params: {
  results: AuditResult[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
  coverageMatrix?: CoverageMatrix;
  runtimeValidationReport?: RuntimeValidationReport;
  runtimeValidationTaskManifest?: RuntimeValidationTaskManifest;
  externalAnalyzerResults?: ExternalAnalyzerResults;
  designAssessment?: DesignAssessment;
  /** Active dispatch state; when a partial-completion terminal is set, its stranded count is carried into the summary. */
  activeDispatch?: ActiveDispatchState | null;
}): AuditReportModel {
  // Re-key the finalized findings with globally-unique, content-addressed ids
  // before anything addresses them by id. mergeFindings emits exactly one
  // finding per file-independent identity (exact normalized lens|category|
  // title) across files, units, and passes, and assignStableFindingIds hashes
  // only stable identity signals — never line numbers, pass ids, or the merged
  // file list — so the same logical finding keeps one id across passes and
  // re-syntheses. buildWorkBlocks keys its union-find on finding.id, so the
  // locally-scoped, collision-prone ids worker packets emit must be replaced
  // here or unrelated findings fuse into one block.
  const allFindings = assignStableFindingIds(
    mergeFindings(
      params.results,
      params.runtimeValidationReport,
      params.externalAnalyzerResults,
      params.designAssessment,
    ),
  );
  // B4: a tool-executable anchor that REFUTED a claim (status `refuted`, distinct
  // from `ungrounded`) is quarantined-EXCLUDED — kept out of the admitted findings
  // AND the work blocks so a disproven claim never merges as actionable fact. The
  // refuted findings are preserved in `quarantined_findings` (quarantine, not
  // delete) and rendered in their own report section. The exclusion happens AFTER
  // merge so a finding grounded on another pass (grounded-wins in mergeGrounding)
  // is never quarantined.
  const findings = allFindings.filter((f) => f.grounding?.status !== "refuted");
  const quarantinedRefuted = allFindings.filter((f) => f.grounding?.status === "refuted");
  const workBlocks = buildWorkBlocks({
    findings,
    unitManifest: params.unitManifest,
    graphBundle: params.graphBundle,
    criticalFlows: params.criticalFlows,
  });
  const coverage = coverageSummary(params.coverageMatrix);
  const strandedUnitCount =
    params.activeDispatch?.partial_completion_terminal?.stranded_ids?.length ?? 0;
  // Count grounding over ALL findings (incl. quarantined-refuted) so the `refuted`
  // tally reflects findings dropped from the admitted set.
  const groundingBreakdown = groundingStatusBreakdown(allFindings);
  const model: AuditReportModel = {
    summary: {
      finding_count: findings.length,
      work_block_count: workBlocks.length,
      severity_breakdown: severityBreakdown(findings),
      lens_breakdown: lensBreakdown(findings),
      audited_file_count: coverage.audited_file_count,
      excluded_file_count: coverage.excluded_file_count,
      budget_deferred_task_count: coverage.budget_deferred_task_count,
      ...(strandedUnitCount > 0 ? { stranded_unit_count: strandedUnitCount } : {}),
      ...(Object.keys(groundingBreakdown).length > 0
        ? { grounding_status_breakdown: groundingBreakdown }
        : {}),
      runtime_validation_status_breakdown: runtimeStatusBreakdown(
        params.runtimeValidationReport,
        params.runtimeValidationTaskManifest,
      ),
    },
    findings,
    work_blocks: workBlocks,
    ...(quarantinedRefuted.length > 0 ? { quarantined_findings: quarantinedRefuted } : {}),
  };
  return model;
}

/**
 * Wrap the deterministic report model in the canonical `audit-findings.json`
 * contract — the machine hand-off consumed by the remediator. Narrative fields
 * are absent here; they are layered on later by {@link applyNarrative}.
 */
export function buildAuditFindingsReport(
  model: AuditReportModel,
): AuditFindingsReport {
  const report: AuditFindingsReport = {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary: { ...model.summary },
    findings: model.findings,
    work_blocks: model.work_blocks,
    ...(model.quarantined_findings && model.quarantined_findings.length > 0
      ? { quarantined_findings: model.quarantined_findings }
      : {}),
  };
  return report;
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
    // Deduplicate within the theme first, then filter to valid ids that have not
    // yet been claimed by a prior (first-claiming) theme. This enforces the
    // "each finding belongs to at most one theme" contract — the first theme in
    // narrative.themes to list a given id wins; later themes have it stripped.
    const findingIds = [
      ...new Set((theme.finding_ids ?? []).filter((id) => validFindingIds.has(id) && !themeByFinding.has(id))),
    ];
    themes.push({
      theme_id: theme.theme_id,
      title: theme.title,
      root_cause: theme.root_cause,
      finding_ids: findingIds,
      suggested_fix_pattern: theme.suggested_fix_pattern,
    });
    for (const id of findingIds) {
      themeByFinding.set(id, theme.theme_id);
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
  /**
   * Opt-in agent meta-audit reflections to surface in a "Process Feedback"
   * section. Omitted/empty renders nothing. Populated from the parsed
   * `agent-feedback.jsonl` (`bundle.agent_reflections`) by the synthesis
   * executors.
   */
  reflections?: AgentReflection[];
  /**
   * The accepted intent checkpoint; its `excluded_scope` is surfaced in an
   * "Excluded / Out-of-Scope" section so omissions are explicit in the report.
   */
  intent_checkpoint?: IntentCheckpoint;
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
    ...(report.summary.lens_breakdown && Object.keys(report.summary.lens_breakdown).length > 0
      ? [`- Lens breakdown: ${formatCountList(report.summary.lens_breakdown)}`]
      : []),
    ...(report.summary.grounding_status_breakdown &&
    Object.keys(report.summary.grounding_status_breakdown).length > 0
      ? [
          `- Grounding (S7): ${formatCountList(report.summary.grounding_status_breakdown)}` +
            [
              (report.summary.grounding_status_breakdown.ungrounded ?? 0) > 0
                ? "ungrounded findings are surfaced-not-confirmed below"
                : null,
              (report.summary.grounding_status_breakdown.refuted ?? 0) > 0
                ? "refuted findings are quarantined-excluded below"
                : null,
            ]
              .filter(Boolean)
              .reduce((acc, note, i) => acc + (i === 0 ? " — " : "; ") + note, ""),
        ]
      : []),
    `- Fully audited files: ${report.summary.audited_file_count}`,
    `- Excluded non-auditable files: ${report.summary.excluded_file_count}`,
    ...((report.summary.budget_deferred_task_count ?? 0) > 0
      ? [
          `- Not audited (budget): ${report.summary.budget_deferred_task_count} task(s) skipped by packet budget cap`,
        ]
      : []),
    ...((report.summary.stranded_unit_count ?? 0) > 0
      ? [
          `- Not audited (provider pool exhausted): ${report.summary.stranded_unit_count} unit(s) were not audited because the provider pool was exhausted before dispatch could complete (partial coverage)`,
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
      lines.push(`- Category: ${finding.category}`);
      if (finding.theme_id) {
        lines.push(`- Theme: ${finding.theme_id}`);
      }
      lines.push(`- Files: ${finding.affected_files.map((file) => file.path).join(", ")}`);
      lines.push(`- Summary: ${finding.summary}`);
      if (finding.grounding?.status === "ungrounded") {
        lines.push(
          `- ⚠ Grounding: ungrounded — ${finding.grounding.reason ?? "cited span did not re-verify against disk"} (surfaced, not confirmed)`,
        );
      }
      if (finding.evidence && finding.evidence.length > 0) {
        lines.push("- Evidence:");
        for (const evidence of finding.evidence) {
          lines.push(`  - ${evidence}`);
        }
      }
      lines.push("");
    }
  }

  // S7 surfacing: list the findings the grounding pass could not re-verify
  // against disk in a dedicated, visually-separated section so they are never
  // silently confirmed. They remain in the main findings list (and in the machine
  // contract / work blocks) but are explicitly marked not-confirmed.
  const ungroundedFindings = report.findings.filter(
    (finding) => finding.grounding?.status === "ungrounded",
  );
  if (ungroundedFindings.length > 0) {
    lines.push("## Ungrounded Findings (not confirmed)", "");
    lines.push(
      `${ungroundedFindings.length} finding(s) could not be re-verified against the source on disk (S7 grounding: the cited verbatim span was not found, or no span was provided). They appear above with the other findings but are **not confirmed** — treat them with skepticism and check the code before acting.`,
      "",
    );
    for (const finding of ungroundedFindings) {
      lines.push(
        `- **${finding.id}** — ${finding.title} (${finding.severity}, ${finding.lens})`,
      );
      if (finding.grounding?.reason) {
        lines.push(`  - Reason: ${finding.grounding.reason}`);
      }
    }
    lines.push("");
  }

  // B4: tool-REFUTED findings — an executable anchor actively DISPROVED the claim.
  // Unlike ungrounded findings, these are EXCLUDED from the admitted findings and
  // work blocks (never actionable), but recorded here (quarantine, not delete) so
  // the disproof is auditable.
  const refutedFindings = report.quarantined_findings ?? [];
  if (refutedFindings.length > 0) {
    lines.push("## Refuted Findings (quarantined — excluded)", "");
    lines.push(
      `${refutedFindings.length} finding(s) were DISPROVED by a tool-executable anchor (S7 tier-2). They are **excluded** from the findings and work blocks above — a disproven claim is never actionable — and are listed here only for auditability.`,
      "",
    );
    for (const finding of refutedFindings) {
      lines.push(
        `- **${finding.id}** — ${finding.title} (${finding.severity}, ${finding.lens})`,
      );
      if (finding.grounding?.reason) {
        lines.push(`  - Refuted: ${finding.grounding.reason}`);
      }
    }
    lines.push("");
  }

  lines.push(...renderProcessFeedbackSection(options.reflections ?? []));

  const excludedScope = options.intent_checkpoint?.excluded_scope ?? [];
  if (excludedScope.length > 0) {
    lines.push("## Excluded / Out-of-Scope", "");
    lines.push(
      `${excludedScope.length} path(s) were excluded from this audit per the intent checkpoint:`,
      "",
    );
    for (const entry of excludedScope) {
      lines.push(`- \`${entry.path}\` — ${entry.reason}`);
    }
    lines.push("");
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

/**
 * Re-derive the summary fields that can be computed from the existing findings
 * and work_blocks, bump the contract_version to the current constant, and leave
 * upstream-derived fields that cannot be reconstructed (audited/excluded counts,
 * runtime validation breakdown) untouched.
 *
 * Safe to call on already-promoted `audit-findings.json` files without access to
 * the pruned `.audit-tools/audit` working-bundle intermediates.
 */
export function normalizeExistingFindingsReport(
  report: AuditFindingsReport,
): AuditFindingsReport {
  const groundingBreakdown = groundingStatusBreakdown(report.findings as Finding[]);
  return {
    ...report,
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary: {
      ...report.summary,
      finding_count: report.findings.length,
      work_block_count: report.work_blocks.length,
      severity_breakdown: severityBreakdown(report.findings as Finding[]),
      lens_breakdown: lensBreakdown(report.findings as Finding[]),
      ...(Object.keys(groundingBreakdown).length > 0
        ? { grounding_status_breakdown: groundingBreakdown }
        : {}),
    },
  };
}
