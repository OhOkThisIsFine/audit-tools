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
} from "../types/finding.js";
import { AUDIT_FINDINGS_CONTRACT_VERSION } from "../validation/findingsReport.js";
import { renderFindingBlockLines } from "./findingDisplay.js";

const SEVERITY_KEYS: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

function severityBreakdown(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of SEVERITY_KEYS) out[key] = 0;
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

function lensBreakdown(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.lens] = (out[f.lens] ?? 0) + 1;
  return out;
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
  const summary: AuditFindingsSummary = {
    finding_count: findings.length,
    work_block_count: 0,
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
    work_blocks: [],
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
