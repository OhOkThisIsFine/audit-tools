// Shared audit-deliverable emitter: build the canonical `audit-findings.json`
// machine contract + its `audit-report.md` human render from a Finding[] set.
//
// Single-sourced here (in `audit-tools/shared`) so BOTH halves of the pipeline
// emit an identical, re-consumable pair. The autonomous remediator uses it to
// re-emit the findings it left LIVE (never auto-fixed, never durably rejected)
// as a standard deliverable pair that round-trips straight back through the
// remediator's `defaultInputCandidates` (`audit-findings.json` preferred over
// `audit-report.md`) on the next nightly run — no special leftover format, no
// durable rejection state.

import type {
  AuditFindingsReport,
  AuditFindingsSummary,
  Finding,
  FindingSeverity,
  WorkBlock,
} from "../types/finding.js";
import { AUDIT_FINDINGS_CONTRACT_VERSION } from "../validation/findingsReport.js";
import { renderFindingBlockLines } from "./findingDisplay.js";
import { countBy } from "../countBy.js";
import {
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
} from "../decompose/contentCoherence.js";
import { deriveWorkBlockSeams } from "../decompose/workBlockSeams.js";
import {
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
} from "../tokens.js";

const SEVERITY_KEYS: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

/**
 * Every severity key is present (zero-filled) even when no finding carries
 * it — unlike the plain `countBy` result, which only has keys for severities
 * that actually occur. Insertion order is SEVERITY_KEYS' order: spreading
 * `counts` over the zero-filled base only overwrites existing keys' values,
 * it never reorders or appends (severity is a closed enum, so `counts` can
 * never introduce a key absent from SEVERITY_KEYS).
 */
function severityBreakdown(findings: readonly Finding[]): Record<string, number> {
  const zeroed: Record<string, number> = {};
  for (const key of SEVERITY_KEYS) zeroed[key] = 0;
  const counts = countBy(findings, (f) => f.severity);
  return { ...zeroed, ...counts };
}

function lensBreakdown(findings: readonly Finding[]): Record<string, number> {
  return countBy(findings, (f) => f.lens);
}

/**
 * Build the canonical `audit-findings.json` machine contract over `findings`.
 * The summary is derived deterministically; no work-blocks are emitted (the
 * deliverable is a flat, re-consumable finding set). Stamped with the same
 * `contract_version` the auditor emits, so `validateAuditFindingsReport` accepts
 * it and the remediator's structured fast-path consumes it losslessly.
 */
export function buildAuditFindingsDeliverable(
  findings: readonly Finding[],
): AuditFindingsReport {
  const coherenceTrace = buildContentCoherenceTrace(
    {
      items: findings.map((finding) => ({
        id: finding.id,
        file_paths: finding.affected_files.map((file) => file.path),
        unit_ids: [],
        tags: [finding.lens],
      })),
      relationships: [],
    },
    FINDINGS_DRAW_COHERENCE_POLICY,
  );
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const blocks: WorkBlock[] = coherenceTrace.components.map((ids, index) => {
    const members = ids.map((id) => findingById.get(id)!);
    const maxSeverity = members.reduce<FindingSeverity>(
      (highest, finding) =>
        SEVERITY_KEYS.indexOf(finding.severity) < SEVERITY_KEYS.indexOf(highest)
          ? finding.severity
          : highest,
      "info",
    );
    return {
      id: `block-${index + 1}`,
      finding_ids: [...ids],
      unit_ids: [],
      owned_files: [
        ...new Set(
          members.flatMap((finding) =>
            finding.affected_files.map((file) => file.path.replace(/\\/gu, "/")),
          ),
        ),
      ].sort(),
      role: members.some((finding) => finding.systemic === true)
        ? "coordination"
        : "implementation",
      max_severity: maxSeverity,
      rationale: `Canonical coherence component with ${members.length} finding(s).`,
      depends_on: [],
      token_estimate:
        ESTIMATED_PROMPT_OVERHEAD_TOKENS +
        members.length * ESTIMATED_ITEM_OVERHEAD_TOKENS,
    };
  });
  const summary: AuditFindingsSummary = {
    finding_count: findings.length,
    work_block_count: blocks.length,
    severity_breakdown: severityBreakdown(findings),
    audited_file_count: 0,
    excluded_file_count: 0,
    runtime_validation_status_breakdown: {},
    lens_breakdown: lensBreakdown(findings),
  };
  return {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary,
    findings: [...findings],
    coherence_trace: coherenceTrace,
    work_blocks: blocks,
    // Derived, never assumed empty: under the findings draw's file-AND-lens
    // eligibility a file cited by several lenses lands in several blocks, and a
    // hard-coded [] would hand the remediator a seed whose phase cut runs those
    // blocks in parallel over the same write path.
    work_block_seams: deriveWorkBlockSeams(blocks),
  };
}

/**
 * Render the `audit-report.md` human deliverable for `findings` using the ONE
 * shared finding renderer (parity with the auditor's report). `title` and
 * `intro` let the caller frame the deliverable (e.g. "leftovers from an
 * autonomous run").
 */
export function renderAuditDeliverableMarkdown(
  findings: readonly Finding[],
  options: { title?: string; intro?: string } = {},
): string {
  const lines: string[] = [`# ${options.title ?? "Audit Report"}`, ""];
  if (options.intro) {
    lines.push(options.intro, "");
  }
  if (findings.length === 0) {
    lines.push("No findings.", "");
    return lines.join("\n");
  }
  lines.push(`## Findings (${findings.length})`, "");
  for (const finding of findings) {
    lines.push(...renderFindingBlockLines(finding));
  }
  return lines.join("\n");
}

export interface AuditDeliverablePair {
  /** The canonical machine contract (audit-findings.json content). */
  findings_report: AuditFindingsReport;
  /** The human render (audit-report.md content). */
  report_markdown: string;
}

/**
 * Build BOTH halves of the re-consumable audit deliverable pair at once. The
 * JSON is the source of truth; the markdown is its render. The caller writes
 * `findings_report` to `audit-findings.json` and `report_markdown` to
 * `audit-report.md`.
 */
export function buildAuditDeliverablePair(
  findings: readonly Finding[],
  options: { title?: string; intro?: string } = {},
): AuditDeliverablePair {
  return {
    findings_report: buildAuditFindingsDeliverable(findings),
    report_markdown: renderAuditDeliverableMarkdown(findings, options),
  };
}
