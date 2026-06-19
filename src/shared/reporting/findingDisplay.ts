// Single-sourced finding display (dogfood note 2 + auditor/remediator parity).
//
// The auditor's findings report and the remediator's host-facing prompts both
// present findings to a human who has to DECIDE something (act/skip, how far to
// scope, approve/disapprove). Before this module each rendered findings its own
// way — uneven field order, some with grounding and some without, dense
// single-paragraph summaries, full 12-path dumps. That is exactly the drift the
// "enforce in tooling, not host discretion" principle forbids, so the block is
// defined ONCE here and both pipelines render through it.
//
// The block is decision-first: a one-line lead, a fixed-order labelled badge
// body, then only the data a reader needs to act — long file lists and deep
// evidence are trimmed/summarized with a pointer to the machine contract (the
// full source of truth). Callers that need the FULL set (e.g. an implement worker
// that must edit every cited file) pass `trimFiles: false` / `summarizeEvidence:
// false`; callers that present a decision view take the trimming defaults.

/** A cited file location — either a bare path or a path with a line range. */
export type FindingFileRef =
  | string
  | { path: string; line_start?: number; line_end?: number };

/**
 * The fields the badge body renders — no `id`/`title`, so a projection that keys
 * its identity differently (e.g. the remediator's review item with `finding_id`)
 * still satisfies it without adapting. The shared `Finding` type satisfies it too.
 */
export interface FindingBadge {
  severity: string;
  confidence?: string;
  lens: string;
  summary?: string;
  affected_files?: ReadonlyArray<FindingFileRef>;
  evidence?: readonly string[];
  grounding?: { status: string; reason?: string };
  systemic?: boolean;
  impact?: string;
  likelihood?: string;
}

/** A badge plus the identity fields the full-block heading needs. */
export interface FindingDisplay extends FindingBadge {
  id: string;
  title: string;
}

export interface FindingDisplayOptions {
  /** Trim the file list to the first `maxFiles` + a `+N more` count. Default true. */
  trimFiles?: boolean;
  /** Cap for `trimFiles`. Default 4. */
  maxFiles?: number;
  /** Summarize evidence to a count + top item pointing at the JSON. Default true. */
  summarizeEvidence?: boolean;
  /** Render the grounding line (always, even when no verdict). Default true. */
  showGrounding?: boolean;
  /** Render the `- Files:` line. Default true. */
  showFiles?: boolean;
  /** Render the `- Details:` (full summary) line. Default true. */
  showDetails?: boolean;
  /** Render the `- Evidence:` line. Default true. */
  showEvidence?: boolean;
  /** Where the full record lives, named in the evidence pointer. Default `audit-findings.json`. */
  evidencePointer?: string;
}

const DEFAULT_MAX_FILES = 4;
const MAX_EVIDENCE_LEAD = 160;

/** First sentence of a summary, for the one-line lead above the badge body. */
export function findingLead(summary: string | undefined): string {
  const trimmed = (summary ?? "").trim();
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

/** `path:start–end` (en-dash), backticked; falls back to `path` with no lines. */
export function formatFindingFileRef(file: FindingFileRef): string {
  if (typeof file === "string") {
    return `\`${file}\``;
  }
  let ref = file.path;
  if (typeof file.line_start === "number") {
    ref += `:${file.line_start}`;
    if (typeof file.line_end === "number" && file.line_end !== file.line_start) {
      ref += `–${file.line_end}`;
    }
  }
  return `\`${ref}\``;
}

/** Grounding line — grounded / ungrounded / refuted / not assessed. */
export function findingGroundingLine(finding: FindingBadge): string {
  const grounding = finding.grounding;
  if (!grounding) {
    return "- Grounding: not assessed";
  }
  if (grounding.status === "grounded") {
    return "- Grounding: grounded";
  }
  if (grounding.status === "ungrounded") {
    return `- Grounding: ⚠ ungrounded — ${grounding.reason ?? "cited span did not re-verify against disk"} (surfaced, not confirmed)`;
  }
  if (grounding.status === "refuted") {
    return `- Grounding: ✗ refuted — ${grounding.reason ?? "an executable anchor disproved the claim"}`;
  }
  return `- Grounding: ${grounding.status}`;
}

/**
 * The fixed-order labelled badge body — the `- ...` lines, no heading, no lead.
 * Same labels, same order, every finding: Severity → Confidence → Lens →
 * Grounding → [Systemic] → [Impact] → [Likelihood] → [Files] → [Details] →
 * [Evidence]. Callers compose a heading / lead / context-specific lines around it.
 */
export function renderFindingBadgeBody(
  finding: FindingBadge,
  opts: FindingDisplayOptions = {},
): string[] {
  const {
    trimFiles = true,
    maxFiles = DEFAULT_MAX_FILES,
    summarizeEvidence = true,
    showGrounding = true,
    showFiles = true,
    showDetails = true,
    showEvidence = true,
    evidencePointer = "audit-findings.json",
  } = opts;

  const lines: string[] = [];
  lines.push(`- Severity: ${finding.severity}`);
  if (finding.confidence) {
    lines.push(`- Confidence: ${finding.confidence}`);
  }
  lines.push(`- Lens: ${finding.lens}`);
  if (showGrounding) {
    lines.push(findingGroundingLine(finding));
  }
  if (finding.systemic === true) {
    lines.push("- Systemic: yes");
  }
  if (finding.impact) {
    lines.push(`- Impact: ${finding.impact}`);
  }
  if (finding.likelihood) {
    lines.push(`- Likelihood: ${finding.likelihood}`);
  }

  const files = finding.affected_files ?? [];
  if (showFiles && files.length > 0) {
    const shownRefs = (trimFiles ? files.slice(0, maxFiles) : files).map(
      formatFindingFileRef,
    );
    const extra = files.length - shownRefs.length;
    lines.push(
      `- Files: ${shownRefs.join(", ")}${extra > 0 ? ` +${extra} more` : ""}`,
    );
  }

  const summary = (finding.summary ?? "").trim();
  const lead = findingLead(summary);
  if (showDetails && summary && summary !== lead) {
    lines.push(`- Details: ${summary}`);
  }

  const evidence = finding.evidence ?? [];
  if (showEvidence && evidence.length > 0) {
    if (!summarizeEvidence) {
      lines.push("- Evidence:");
      for (const item of evidence) {
        lines.push(`  - ${item}`);
      }
    } else if (evidence.length === 1) {
      lines.push(`- Evidence: ${evidence[0]}`);
    } else {
      const first = evidence[0];
      const top =
        first.length > MAX_EVIDENCE_LEAD
          ? `${first.slice(0, MAX_EVIDENCE_LEAD)}…`
          : first;
      lines.push(
        `- Evidence: ${evidence.length} items (top: "${top}") — see ${evidencePointer} for the full list`,
      );
    }
  }

  return lines;
}

/**
 * The full standardized finding block as lines: `### id — title`, a blank line, a
 * one-line lead (when the summary has one), a blank line, then the badge body and
 * a trailing blank separator. Used wherever a finding is presented on its own.
 */
export function renderFindingBlockLines(
  finding: FindingDisplay,
  opts: FindingDisplayOptions = {},
): string[] {
  const lines: string[] = [`### ${finding.id} — ${finding.title}`, ""];
  const lead = findingLead(finding.summary);
  if (lead) {
    lines.push(lead, "");
  }
  lines.push(...renderFindingBadgeBody(finding, opts));
  lines.push("");
  return lines;
}

/** Convenience: {@link renderFindingBlockLines} joined into one string. */
export function renderFindingBlock(
  finding: FindingDisplay,
  opts: FindingDisplayOptions = {},
): string {
  return renderFindingBlockLines(finding, opts).join("\n");
}
