import type { AuditResult, CoverageMatrix, Finding, UnitManifest } from "../types.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import type { IntentCheckpoint, SubmissionLedgerEvent } from "audit-tools/shared";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type {
  AuditFindingsReport,
  ContentCoherenceTrace,
  CriticalFlowManifest,
  Finding as SharedFinding,
  FindingTheme,
  GraphBundle,
  SynthesisNarrative,
  WorkBlockSeam,
} from "audit-tools/shared";
import {
  AUDIT_FINDINGS_CONTRACT_VERSION as SHARED_AUDIT_FINDINGS_CONTRACT_VERSION,
  AUDITOR_REPORT_MARKER,
  renderProcessFeedbackSection,
  renderFindingBlockLines,
  countBy,
  type AgentReflection,
} from "audit-tools/shared";
import type {
  RuntimeValidationReport,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";
import { buildWorkBlockPartition, type WorkBlock } from "./workBlocks.js";
import { mergeFindings } from "./mergeFindings.js";
import { selectCurrentResults } from "../orchestrator/ledger.js";
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
  work_block_seams: WorkBlockSeam[];
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
}

export interface AuditReportModel {
  summary: AuditReportSummary;
  findings: Finding[];
  coherence_trace: ContentCoherenceTrace;
  work_blocks: WorkBlock[];
  work_block_seams: WorkBlockSeam[];
  /** Tool-REFUTED findings (S7 tier-2 disproof) excluded from the admitted set. */
  quarantined_findings?: Finding[];
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
  externalAnalyzerResults?: ExternalAnalyzerResults[];
  designAssessment?: DesignAssessment;
  structureDecomposition?: StructureDecomposition;
  charterRegister?: CharterRegister;
  systemicChallenge?: SystemicChallengeRegister;
  /** Intake manifest byte sizes used to estimate remediation source context. */
  sizeIndex?: Readonly<Record<string, number>>;
}): AuditReportModel {
  // Re-key the finalized findings with globally-unique, content-addressed ids
  // before anything addresses them by id. mergeFindings emits exactly one
  // finding per file-independent identity (exact normalized lens|category|
  // title) across files, units, and passes, and assignStableFindingIds hashes
  // only stable identity signals — never line numbers, pass ids, or the merged
  // file list — so the same logical finding keeps one id across passes and
  // re-syntheses. Work partition coverage and seam identities key on finding.id,
  // so locally-scoped, collision-prone packet ids must be replaced here or
  // unrelated findings become indistinguishable in the partition contract.
  // O3 supersession: resolve the ledger to its CURRENT record per task lineage
  // before merging, so a re-dispatched result's fresh findings replace the stale
  // base record they superseded — including findings the re-audit dropped, which
  // a finding-id upsert alone would leave behind.
  const allFindings = assignStableFindingIds(
    mergeFindings(
      selectCurrentResults(params.results),
      params.runtimeValidationReport,
      params.externalAnalyzerResults,
      params.designAssessment,
      params.structureDecomposition,
      params.charterRegister,
      params.systemicChallenge,
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
  const workBlocks = buildWorkBlockPartition({
    findings,
    unitManifest: params.unitManifest,
    graphBundle: params.graphBundle,
    criticalFlows: params.criticalFlows,
    sizeIndex: params.sizeIndex,
  });
  const coverage = coverageSummary(params.coverageMatrix);
  // Count grounding over ALL findings (incl. quarantined-refuted) so the `refuted`
  // tally reflects findings dropped from the admitted set.
  const groundingBreakdown = groundingStatusBreakdown(allFindings);
  const model: AuditReportModel = {
    summary: {
      finding_count: findings.length,
      work_block_count: workBlocks.blocks.length,
      severity_breakdown: severityBreakdown(findings),
      lens_breakdown: lensBreakdown(findings),
      audited_file_count: coverage.audited_file_count,
      excluded_file_count: coverage.excluded_file_count,
      ...(Object.keys(groundingBreakdown).length > 0
        ? { grounding_status_breakdown: groundingBreakdown }
        : {}),
      runtime_validation_status_breakdown: runtimeStatusBreakdown(
        params.runtimeValidationReport,
        params.runtimeValidationTaskManifest,
      ),
    },
    findings,
    coherence_trace: workBlocks.coherence_trace,
    work_blocks: workBlocks.blocks,
    work_block_seams: workBlocks.seams,
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
    coherence_trace: model.coherence_trace,
    work_blocks: model.work_blocks,
    work_block_seams: model.work_block_seams,
    ...(model.quarantined_findings && model.quarantined_findings.length > 0
      ? { quarantined_findings: model.quarantined_findings }
      : {}),
  };
  return report;
}

/**
 * Merge an LLM synthesis narrative into the canonical findings report: tag each
 * covered finding with its (first-claiming) `theme_id`, and attach the
 * executive summary / top risks. Deterministic and idempotent — the same
 * narrative yields the same report.
 *
 * Uniform id-join contract: a `finding_ids` entry that names no finding in the
 * report REFUSES the whole narrative (throws, naming the unknown ids) — never a
 * silent drop, which would present a theme as covering findings it does not.
 */
export function applyNarrative(
  report: AuditFindingsReport,
  narrative: SynthesisNarrative,
): AuditFindingsReport {
  const validFindingIds = new Set(report.findings.map((finding) => finding.id));
  const themeByFinding = new Map<string, string>();
  const themes: FindingTheme[] = [];

  const unknownIds = (narrative.themes ?? []).flatMap((theme) =>
    (theme.finding_ids ?? []).filter((id) => !validFindingIds.has(id)),
  );
  if (unknownIds.length > 0) {
    throw new Error(
      `synthesis narrative refused — theme finding_ids name ${unknownIds.length} unknown ` +
        `finding id(s): ${[...new Set(unknownIds)].join(", ")}. Every finding_ids entry ` +
        `must be one of the ${validFindingIds.size} ids in audit-findings.json (copy ` +
        `exactly, never retype); re-submit the whole narrative.`,
    );
  }

  for (const theme of narrative.themes ?? []) {
    // Deduplicate within the theme first, then drop ids already claimed by a
    // prior (first-claiming) theme. This enforces the "each finding belongs to
    // at most one theme" contract — the first theme in narrative.themes to list
    // a given id wins; later themes have it stripped. (Unknown ids were refused
    // wholesale above, so every id here is a real finding.)
    const findingIds = [
      ...new Set((theme.finding_ids ?? []).filter((id) => !themeByFinding.has(id))),
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
  /**
   * The submission ledger's events, in arrival order. Rendered as per-kind
   * totals in the process section so a run that drifted and was repaired stays
   * distinguishable, in the DELIVERABLE, from one that was clean on the first
   * try — the fact the ledger exists to preserve, previously readable only by
   * opening the ledger itself.
   */
  submission_ledger?: readonly SubmissionLedgerEvent[];
}

/**
 * What happened to this run's submissions, when something went wrong.
 *
 * DRIFT is a refusal or a hand repair — never an acceptance, which is the happy
 * path and says nothing. So a run that was clean on the first try renders no
 * section at all, and the section's PRESENCE is itself the statement that this
 * run was not.
 *
 * Counted PER SUBMISSION, not per event, and "repaired" is read off each
 * submission's own trailing state. A bare `rejected N / accepted M` pair would
 * invite reading M as "of those N" while the two totals cover different
 * populations (a gate lane records every acceptance; a host work item records
 * one only where a refusal precedes it), so a fully-repaired run could render
 * as `rejected 3, accepted 0`. Per-submission trailing state has no such
 * ambiguity. Totals are sorted by content, never arrival: a derived summary may
 * sort; the ledger file it derives from may not.
 */
function renderSubmissionDriftSection(
  events: readonly SubmissionLedgerEvent[],
): string[] {
  const refusedIds = new Set(
    events
      .filter((event) => event.kind === "rejected")
      .map((event) => event.submission_id),
  );
  const handRepairedIds = new Set(
    events
      .filter((event) => event.kind === "recovered_by_hand")
      .map((event) => event.submission_id),
  );
  if (refusedIds.size === 0 && handRepairedIds.size === 0) return [];
  // Trailing state per submission: a refusal followed by an acceptance or a
  // hand recovery is RESOLVED; one that is still the last word is not.
  const trailing = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "expected") continue;
    trailing.set(event.submission_id, event.kind);
  }
  const resolved = [...refusedIds].filter(
    (id) => trailing.get(id) !== "rejected",
  ).length;
  const rejected = events.filter((event) => event.kind === "rejected");
  const lines = [
    "### Submission drift and repair",
    "",
    `${refusedIds.size} submission(s) were refused at least once during this run; ` +
      `${resolved} of them were later accepted or re-landed by hand` +
      (handRepairedIds.size > 0
        ? ` (${handRepairedIds.size} by an operator's hand recovery)`
        : "") +
      ". A refusal stays on the record after the later acceptance lands, so this run " +
      "is distinguishable from one that was clean on the first try.",
    "",
  ];
  if (rejected.length > 0) {
    const byCode = new Map<string, number>();
    for (const event of rejected) {
      const code = event.issue_code ?? "unspecified";
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    lines.push(
      `- Refusals by reason: ${[...byCode.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([code, count]) => `${code} ${count}`)
        .join(", ")}`,
      "",
    );
  }
  return lines;
}

/**
 * Standardized per-finding render (dogfood note 2). Every finding — admitted,
 * ungrounded, or refuted/quarantined — uses the ONE shared `renderFindingBlock`
 * (single-sourced in `audit-tools/shared` so the auditor report and the
 * remediator's host prompts can never drift apart). Decision-first defaults: a
 * one-line lead, a fixed-order labelled badge body, files trimmed to a `+N more`
 * count and evidence summarized with a pointer to `audit-findings.json` (the full
 * source of truth).
 */
function pushFindingBlock(finding: SharedFinding, lines: string[]): void {
  lines.push(...renderFindingBlockLines(finding));
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
      lines.push(`- Role: ${block.role}`);
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

  const workBlockSeams = report.work_block_seams ?? [];
  if (workBlockSeams.length > 0) {
    lines.push("## Work Block Seams", "");
    for (const seam of workBlockSeams) {
      lines.push(`### ${seam.id} — ${seam.kind}`);
      lines.push("");
      lines.push(`- Blocks: ${seam.block_ids.join(", ")}`);
      lines.push(
        `- Shared files: ${seam.shared_files.length > 0 ? seam.shared_files.join(", ") : "none"}`,
      );
      lines.push(
        `- Shared units: ${seam.shared_unit_ids.length > 0 ? seam.shared_unit_ids.join(", ") : "none"}`,
      );
      lines.push(`- Seam preparation required: ${seam.requires_preparation ? "yes" : "no"}`);
      lines.push(`- Rationale: ${seam.rationale}`, "");
    }
  }

  lines.push("## Findings", "");
  if (report.findings.length === 0) {
    lines.push("No findings were recorded.", "");
  } else {
    for (const finding of report.findings) {
      pushFindingBlock(finding, lines);
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
      pushFindingBlock(finding, lines);
    }
  }

  const driftLines = renderSubmissionDriftSection(options.submission_ledger ?? []);
  const feedbackLines = renderProcessFeedbackSection(options.reflections ?? []);
  if (driftLines.length > 0 && feedbackLines.length === 0) {
    // The drift block lives UNDER the process heading; with no reflections
    // there is no heading yet, so it brings its own.
    lines.push("## Process Feedback", "");
  }
  lines.push(...feedbackLines, ...driftLines);

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
    work_block_seams: report.work_block_seams ?? [],
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
