/**
 * The single validation and approved-membership authority for the canonical
 * audit-findings.json contract.
 */
import {
  AuditFindingsReportSchema,
  type AuditFindingsReport,
  type Finding,
} from "../types/finding.js";
import { severityRank } from "../types/lens.js";
import type { ValidationIssue } from "./basic.js";
import { isRecord, pushValidationIssue } from "./basic.js";

export const AUDIT_FINDINGS_CONTRACT_VERSION =
  "audit-tools/audit-findings/v1alpha1" as const;

export interface ApprovedFindingDisposition {
  status: "approved" | "quarantined_refuted";
  source: "findings" | "quarantined_findings";
  workBlockId: string | null;
  themeId: string | null;
}

export interface ApprovedFindingsProjection {
  findings: Finding[];
  dispositionById: Map<string, ApprovedFindingDisposition>;
}

interface Inspection {
  issues: ValidationIssue[];
  projection?: ApprovedFindingsProjection;
}

function childPath(path: string, child: string): string {
  return path ? `${path}.${child}` : child;
}

function pushCountMismatch(
  issues: ValidationIssue[],
  path: string,
  label: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected) {
    pushValidationIssue(
      issues,
      path,
      `${label} must equal the authoritative approved-findings projection (${expected}), got ${actual}.`,
    );
  }
}

function validateBreakdown(
  issues: ValidationIssue[],
  path: string,
  label: string,
  actual: Record<string, number>,
  expected: Map<string, number>,
): void {
  const keys = new Set([...Object.keys(actual), ...expected.keys()]);
  for (const key of [...keys].sort()) {
    pushCountMismatch(
      issues,
      childPath(path, key),
      `${label}.${key}`,
      actual[key] ?? 0,
      expected.get(key) ?? 0,
    );
  }
}

function buildProjection(
  report: AuditFindingsReport,
  path: string,
  issues: ValidationIssue[],
): ApprovedFindingsProjection {
  const approvedById = new Map<string, Finding>();
  const quarantinedById = new Map<string, Finding>();
  const declaredIds = new Set<string>();

  const registerFinding = (
    finding: Finding,
    source: "findings" | "quarantined_findings",
    index: number,
  ): void => {
    const idPath = childPath(path, `${source}.${index}.id`);
    if (finding.id.trim().length === 0) {
      pushValidationIssue(issues, idPath, "Finding id must be a non-empty string.");
      return;
    }
    if (declaredIds.has(finding.id)) {
      pushValidationIssue(
        issues,
        idPath,
        `Duplicate finding id "${finding.id}" across approved/quarantined membership.`,
      );
      return;
    }
    declaredIds.add(finding.id);
    (source === "findings" ? approvedById : quarantinedById).set(finding.id, finding);
  };

  report.findings.forEach((finding, index) => registerFinding(finding, "findings", index));
  (report.quarantined_findings ?? []).forEach((finding, index) => {
    registerFinding(finding, "quarantined_findings", index);
    if (finding.grounding?.status !== "refuted") {
      pushValidationIssue(
        issues,
        childPath(path, `quarantined_findings.${index}.grounding.status`),
        "Quarantined findings must carry grounding.status=\"refuted\" provenance.",
      );
    }
    if (finding.theme_id !== undefined) {
      pushValidationIssue(
        issues,
        childPath(path, `quarantined_findings.${index}.theme_id`),
        "Quarantined findings cannot belong to an approved finding theme.",
      );
    }
  });

  const blockIds = new Set<string>();
  const blockByFinding = new Map<string, string>();
  for (let blockIndex = 0; blockIndex < report.work_blocks.length; blockIndex++) {
    const block = report.work_blocks[blockIndex]!;
    const blockPath = childPath(path, `work_blocks.${blockIndex}`);
    if (block.id.trim().length === 0 || blockIds.has(block.id)) {
      pushValidationIssue(
        issues,
        childPath(blockPath, "id"),
        block.id.trim().length === 0
          ? "Work block id must be a non-empty string."
          : `Duplicate work block id "${block.id}".`,
      );
    } else {
      blockIds.add(block.id);
    }
    if (block.finding_ids.length === 0) {
      pushValidationIssue(
        issues,
        childPath(blockPath, "finding_ids"),
        "Every work block must contain at least one approved finding id.",
      );
    }
    const localIds = new Set<string>();
    const blockFindings: Finding[] = [];
    for (let findingIndex = 0; findingIndex < block.finding_ids.length; findingIndex++) {
      const findingId = block.finding_ids[findingIndex]!;
      const findingPath = childPath(blockPath, `finding_ids.${findingIndex}`);
      if (localIds.has(findingId)) {
        pushValidationIssue(issues, findingPath, `Duplicate finding id "${findingId}" in work block.`);
        continue;
      }
      localIds.add(findingId);
      const finding = approvedById.get(findingId);
      if (!finding) {
        pushValidationIssue(
          issues,
          findingPath,
          quarantinedById.has(findingId)
            ? `Work block cannot reference quarantined finding "${findingId}".`
            : `Work block references unknown finding "${findingId}".`,
        );
        continue;
      }
      blockFindings.push(finding);
      const existingBlock = blockByFinding.get(findingId);
      if (existingBlock !== undefined) {
        pushValidationIssue(
          issues,
          findingPath,
          `Approved finding "${findingId}" belongs to multiple work blocks ("${existingBlock}", "${block.id}").`,
        );
      } else {
        blockByFinding.set(findingId, block.id);
      }
    }
    if (blockFindings.length > 0) {
      const expectedMax = blockFindings.reduce((highest, finding) =>
        severityRank(finding.severity) > severityRank(highest.severity) ? finding : highest,
      ).severity;
      if (block.max_severity !== expectedMax) {
        pushValidationIssue(
          issues,
          childPath(blockPath, "max_severity"),
          `max_severity must match the block's approved findings (${expectedMax}).`,
        );
      }
    }
  }

  for (const [findingId] of approvedById) {
    // A flat re-consumable deliverable intentionally has zero work blocks. Once
    // any block projection exists, however, it must cover the approved universe
    // completely rather than silently omitting selected findings.
    if (report.work_blocks.length > 0 && !blockByFinding.has(findingId)) {
      pushValidationIssue(
        issues,
        childPath(path, "work_blocks"),
        `Approved finding "${findingId}" is missing from every work block.`,
      );
    }
  }
  for (let blockIndex = 0; blockIndex < report.work_blocks.length; blockIndex++) {
    const block = report.work_blocks[blockIndex]!;
    const seenDependencies = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < block.depends_on.length; dependencyIndex++) {
      const dependencyId = block.depends_on[dependencyIndex]!;
      const dependencyPath = childPath(path, `work_blocks.${blockIndex}.depends_on.${dependencyIndex}`);
      if (seenDependencies.has(dependencyId)) {
        pushValidationIssue(issues, dependencyPath, `Duplicate work block dependency "${dependencyId}".`);
      } else if (dependencyId === block.id) {
        pushValidationIssue(issues, dependencyPath, "A work block cannot depend on itself.");
      } else if (!blockIds.has(dependencyId)) {
        pushValidationIssue(issues, dependencyPath, `Unknown work block dependency "${dependencyId}".`);
      }
      seenDependencies.add(dependencyId);
    }
  }

  const themeIds = new Set<string>();
  const themeByFinding = new Map<string, string>();
  for (let themeIndex = 0; themeIndex < (report.themes ?? []).length; themeIndex++) {
    const theme = report.themes![themeIndex]!;
    const themePath = childPath(path, `themes.${themeIndex}`);
    if (theme.theme_id.trim().length === 0 || themeIds.has(theme.theme_id)) {
      pushValidationIssue(
        issues,
        childPath(themePath, "theme_id"),
        theme.theme_id.trim().length === 0
          ? "Theme id must be a non-empty string."
          : `Duplicate theme id "${theme.theme_id}".`,
      );
    } else {
      themeIds.add(theme.theme_id);
    }
    const localIds = new Set<string>();
    for (let findingIndex = 0; findingIndex < theme.finding_ids.length; findingIndex++) {
      const findingId = theme.finding_ids[findingIndex]!;
      const findingPath = childPath(themePath, `finding_ids.${findingIndex}`);
      if (localIds.has(findingId)) {
        pushValidationIssue(issues, findingPath, `Duplicate finding id "${findingId}" in theme.`);
        continue;
      }
      localIds.add(findingId);
      if (!approvedById.has(findingId)) {
        pushValidationIssue(issues, findingPath, `Theme references non-approved finding "${findingId}".`);
        continue;
      }
      const existingTheme = themeByFinding.get(findingId);
      if (existingTheme !== undefined) {
        pushValidationIssue(
          issues,
          findingPath,
          `Approved finding "${findingId}" belongs to multiple themes ("${existingTheme}", "${theme.theme_id}").`,
        );
      } else {
        themeByFinding.set(findingId, theme.theme_id);
      }
    }
  }

  report.findings.forEach((finding, index) => {
    const projectedTheme = themeByFinding.get(finding.id);
    if (finding.theme_id !== projectedTheme) {
      pushValidationIssue(
        issues,
        childPath(path, `findings.${index}.theme_id`),
        projectedTheme === undefined
          ? `Finding references unknown or unclaimed theme "${finding.theme_id}".`
          : `Finding theme_id must match its authoritative theme membership ("${projectedTheme}").`,
      );
    }
  });

  pushCountMismatch(
    issues,
    childPath(path, "summary.finding_count"),
    "summary.finding_count",
    report.summary.finding_count,
    report.findings.length,
  );
  pushCountMismatch(
    issues,
    childPath(path, "summary.work_block_count"),
    "summary.work_block_count",
    report.summary.work_block_count,
    report.work_blocks.length,
  );
  const severityBreakdown = new Map<string, number>();
  const lensBreakdown = new Map<string, number>();
  for (const finding of report.findings) {
    severityBreakdown.set(finding.severity, (severityBreakdown.get(finding.severity) ?? 0) + 1);
    lensBreakdown.set(finding.lens, (lensBreakdown.get(finding.lens) ?? 0) + 1);
  }
  validateBreakdown(
    issues,
    childPath(path, "summary.severity_breakdown"),
    "summary.severity_breakdown",
    report.summary.severity_breakdown,
    severityBreakdown,
  );
  if (report.summary.lens_breakdown !== undefined) {
    validateBreakdown(
      issues,
      childPath(path, "summary.lens_breakdown"),
      "summary.lens_breakdown",
      report.summary.lens_breakdown,
      lensBreakdown,
    );
  }

  const dispositionById = new Map<string, ApprovedFindingDisposition>();
  for (const [findingId] of approvedById) {
    dispositionById.set(findingId, {
      status: "approved",
      source: "findings",
      workBlockId: blockByFinding.get(findingId) ?? null,
      themeId: themeByFinding.get(findingId) ?? null,
    });
  }
  for (const [findingId] of quarantinedById) {
    dispositionById.set(findingId, {
      status: "quarantined_refuted",
      source: "quarantined_findings",
      workBlockId: null,
      themeId: null,
    });
  }
  return { findings: report.findings, dispositionById };
}

function inspectAuditFindingsReport(value: unknown, path = ""): Inspection {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(
      issues,
      path,
      `Expected an AuditFindingsReport object, got ${typeof value}.`,
    );
    return { issues };
  }

  const contractPath = childPath(path, "contract_version");
  if (!("contract_version" in value)) {
    pushValidationIssue(
      issues,
      contractPath,
      `Missing required field: contract_version. Expected "${AUDIT_FINDINGS_CONTRACT_VERSION}".`,
    );
  } else if (typeof value.contract_version !== "string") {
    pushValidationIssue(
      issues,
      contractPath,
      `contract_version must be a string, got ${typeof value.contract_version}.`,
    );
  } else if (value.contract_version !== AUDIT_FINDINGS_CONTRACT_VERSION) {
    pushValidationIssue(
      issues,
      contractPath,
      `contract_version mismatch: expected "${AUDIT_FINDINGS_CONTRACT_VERSION}", got "${value.contract_version}". Report cannot be processed safely.`,
    );
  }

  const parsed = AuditFindingsReportSchema.safeParse(value);
  if (!parsed.success) {
    for (const zodIssue of parsed.error.issues) {
      const suffix = zodIssue.path.map(String).join(".");
      pushValidationIssue(
        issues,
        suffix ? childPath(path, suffix) : path,
        `${suffix || "value"}: ${zodIssue.message}`,
      );
    }
    return { issues };
  }
  return { issues, projection: buildProjection(parsed.data, path, issues) };
}

export function validateAuditFindingsReport(
  value: unknown,
  path = "",
): ValidationIssue[] {
  return inspectAuditFindingsReport(value, path).issues;
}

export function projectApprovedFindings(value: unknown): ApprovedFindingsProjection {
  const inspection = inspectAuditFindingsReport(value);
  const errors = inspection.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0 || inspection.projection === undefined) {
    const detail = errors
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new TypeError(`Invalid AuditFindingsReport: ${detail}`);
  }
  return inspection.projection;
}

export function isValidAuditFindingsReport(
  value: unknown,
): value is AuditFindingsReport {
  return inspectAuditFindingsReport(value).issues.every((issue) => issue.severity !== "error");
}
