// sites-pinned: tests/remediate/intake-finding-selection.test.ts
import { z } from "zod";
import {
  FindingSeveritySchema, projectApprovedFindings, projectAuditFindingsReportSubset,
  type AuditFindingsReport,
} from "audit-tools/shared";

export const FindingSelectionSchema = z.object({
  severity: z.array(FindingSeveritySchema),
  finding_ids: z.array(z.string().min(1)),
}).strict();
export type FindingSelection = z.infer<typeof FindingSelectionSchema>;

export interface FindingSelectionOptions {
  severity?: string[];
  findingIds?: string[];
}

/** Undefined means resume/no selection; explicit empty arrays select no work. */
export function requestedFindingSelection(options: FindingSelectionOptions): FindingSelection | undefined {
  if (options.severity === undefined && options.findingIds === undefined) return undefined;
  return FindingSelectionSchema.parse({
    severity: [...new Set(options.severity ?? [])].sort(),
    finding_ids: [...new Set(options.findingIds ?? [])].sort(),
  });
}

/** The selector is a union; downstream scope filters intersect this report. */
export function selectAuditFindings(value: unknown, selection: FindingSelection): AuditFindingsReport {
  const { findings } = projectApprovedFindings(value);
  const known = new Set(findings.map((finding) => finding.id));
  const unknown = selection.finding_ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown finding IDs in intake selection: ${unknown.join(", ")}`);
  return projectAuditFindingsReportSubset(value, findings.filter((finding) =>
    selection.severity.includes(finding.severity) || selection.finding_ids.includes(finding.id),
  ));
}

export function renderFindingSelection(selection: {
  criteria: FindingSelection;
  selected_count: number;
  projected_path: string;
} | undefined): string {
  if (!selection) return "";
  return [
    "", "## Native finding selection already applied", "",
    `${selection.selected_count} findings were selected by the UNION of severity ${JSON.stringify(selection.criteria.severity)} OR explicit IDs ${JSON.stringify(selection.criteria.finding_ids)}.`,
    `The selected source is ${selection.projected_path}.`,
    "Keep every finding in this selected source unless the user explicitly requests further narrowing. Do not copy the native severity list alone into checkpoint filters: that would lose explicitly selected IDs of other severities.",
    "Additional user-confirmed checkpoint filters and excluded scope intersect this selected set. Leave filters empty when no further narrowing was requested.",
  ].join("\n");
}
