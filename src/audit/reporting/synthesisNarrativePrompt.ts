// sites-pinned: tests/audit/synthesis-narrative-prompt.test.ts, tests/audit/reporting-invariants.test.ts
//
// The narrative prompt is a LANE file: a reader opens this one file and writes
// the narrative JSON back. Everything it needs to obey the prompt must either be
// in the file or at a path the lane is granted, which is why the findings-report
// path is a parameter here rather than a bare filename in the prose.

import type { AuditFindingsReport } from "audit-tools/shared";
import { severityRank } from "audit-tools/shared";

const MAX_RENDERED_FINDINGS = 120;

function summarizeFinding(finding: AuditFindingsReport["findings"][number]): string {
  const files = finding.affected_files
    .map((file) => file.path)
    .slice(0, 4)
    .join(", ");
  return `- ${finding.id} [${finding.severity}/${finding.lens}/${finding.category}] ${finding.title} — ${finding.summary}${
    files ? ` (files: ${files})` : ""
  }`;
}

/**
 * Prompt for the optional synthesis-narrative pass. The host groups the
 * already-finalized deterministic findings into root-cause themes and writes a
 * `SynthesisNarrative` JSON document — it does not re-audit or invent findings.
 *
 * Owner review 2026-09-17 (docs/reviews/prompt-refinement-2026-09-13.md, prompt
 * 14) settled three things this renderer now states:
 *
 *  1. The findings are ordered MOST-SEVERE-FIRST before the cap applies. They
 *     arrive in merge order (see `buildAuditFindingsDeliverable`, which copies
 *     the array untouched), and a dogfood audit produces two to three THOUSAND
 *     findings — so a merge-order cut at 120 could, and on a real run would,
 *     drop every `critical` finding off the end of a prompt that then asks the
 *     reader for the top risks. The sort is stable, so merge order survives as
 *     the tie-break within one severity.
 *  2. The overflow line names the REAL findings-report path. It previously said
 *     "see audit-findings.json" — a bare filename, outside the one path the
 *     lane is granted (`fanoutLanes.ts` declares the lane's own prompt file),
 *     so the note pointed the reader at something it could neither locate nor
 *     open. The emitter now grants that path alongside it.
 *  3. Two themes that claim one finding refuse the whole narrative. The prompt
 *     states the rule the consumer enforces, never a rule the consumer quietly
 *     repairs — `applyNarrative` is the enforcer.
 */
export function renderSynthesisNarrativePrompt(
  report: AuditFindingsReport,
  /**
   * Host-facing path of the complete findings report. The overflow line points
   * the reader here, and the emitting step grants it read access — so this is
   * an ACCESS-BEARING argument, not a cosmetic one.
   */
  findingsPath: string,
): string {
  // Stable sort, most-severe-first: `severityRank` is 5 for `critical` down to
  // 1 for `info`, and V8's sort is stable, so findings of equal severity keep
  // the merge order the report was built in.
  const ordered = [...report.findings].sort(
    (left, right) => severityRank(right.severity) - severityRank(left.severity),
  );
  const rendered = ordered.slice(0, MAX_RENDERED_FINDINGS).map(summarizeFinding);
  const omitted = ordered.slice(MAX_RENDERED_FINDINGS);
  const overflowNote =
    omitted.length > 0
      ? [
          `  ... and ${omitted.length} more findings, every one at \`${omitted[0]!.severity}\` severity or below. Read the complete report at ${findingsPath} when a theme needs them.`,
        ]
      : [];

  if (omitted.length > 0) {
    process.stderr.write(
      `[audit-code] synthesisNarrative: truncated findings list to ${MAX_RENDERED_FINDINGS} of ${ordered.length} total — remaining findings omitted from narrative prompt (see ${findingsPath})\n`
    );
  }

  return [
    "# Synthesis narrative",
    "",
    "The deterministic audit is complete. Group its findings into a small number of root-cause themes, write a short executive summary, and list the top risks. Reference every finding by its exact `id`.",
    "",
    "## Summary",
    "",
    `- Findings: ${report.summary.finding_count}`,
    `- Work blocks: ${report.summary.work_block_count}`,
    "",
    "## Findings",
    "",
    "Ordered most-severe first.",
    "",
    ...(rendered.length > 0 ? rendered : ["- (no findings were recorded)"]),
    ...overflowNote,
    "",
    "## Output format",
    "",
    "Write a single JSON object conforming to:",
    "",
    "```json",
    "{",
    '  "themes": [',
    "    {",
    '      "theme_id": "T-001",',
    '      "title": "short root-cause title",',
    '      "root_cause": "what underlying cause ties these findings together",',
    '      "finding_ids": ["<finding id>", "..."],',
    '      "suggested_fix_pattern": "the shared remediation approach for this theme"',
    "    }",
    "  ],",
    '  "executive_summary": "2-4 sentence overview of the audit outcome",',
    '  "top_risks": ["highest-impact risk", "..."]',
    "}",
    "```",
    "",
    "Rules:",
    "",
    "- Every `finding_ids` entry is a finding id of this audit, copied exactly. One unknown id refuses the whole narrative.",
    "- A finding belongs to at most one theme. Two themes that claim the same finding refuse the whole narrative.",
    "- Prefer a few substantive themes over many thin ones.",
    "",
  ].join("\n");
}
