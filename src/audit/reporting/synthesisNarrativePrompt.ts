import type { AuditFindingsReport } from "audit-tools/shared";

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
 */
export function renderSynthesisNarrativePrompt(
  report: AuditFindingsReport,
): string {
  const findings = report.findings;
  const rendered = findings.slice(0, MAX_RENDERED_FINDINGS).map(summarizeFinding);
  const overflowNote =
    findings.length > MAX_RENDERED_FINDINGS
      ? [`  ... and ${findings.length - MAX_RENDERED_FINDINGS} more findings (see audit-findings.json).`]
      : [];

  if (findings.length > MAX_RENDERED_FINDINGS) {
    process.stderr.write(
      `[audit-code] synthesisNarrative: truncated findings list to ${MAX_RENDERED_FINDINGS} of ${findings.length} total — remaining findings omitted from narrative prompt (see audit-findings.json)\n`
    );
  }

  return [
    "# Synthesis narrative",
    "",
    "The deterministic audit is complete. Your job is to add an interpretive narrative on top of the finalized findings — group them into a small number of root-cause themes, write a short executive summary, and list the top risks.",
    "",
    "Do not re-audit the code, change severities, or invent new findings. Use only the findings below; reference them by their exact `id`.",
    "",
    "When categories distinguish observational contract assessment findings from conceptual design critique findings, keep that distinction visible in themes and top risks instead of flattening them into one architecture bucket.",
    "",
    "## Summary",
    "",
    `- Findings: ${report.summary.finding_count}`,
    `- Work blocks: ${report.summary.work_block_count}`,
    "",
    "## Findings",
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
    "Prefer a handful of substantive themes over many thin ones. Every `finding_ids` entry must be an id listed above; unknown ids are dropped. A finding may belong to at most one theme.",
    "",
  ].join("\n");
}
