/**
 * The single validation and approved-membership authority for the canonical
 * audit-findings.json contract.
 */
import {
  AuditFindingsReportSchema,
  type AuditFindingsReport,
  type Finding,
  type WorkBlock,
  type WorkBlockSeam,
} from "../types/finding.js";
import type { ContentCoherenceTrace } from "../decompose/contentCoherence.js";
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
  coherenceTrace: ContentCoherenceTrace;
  workBlocks: WorkBlock[];
  workBlockSeams: WorkBlockSeam[];
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
  return {
    findings: report.findings,
    coherenceTrace: report.coherence_trace,
    workBlocks: report.work_blocks,
    workBlockSeams: report.work_block_seams,
    dispositionById,
  };
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

function projectedBreakdown(
  original: Readonly<Record<string, number>>,
  values: readonly string[],
): Record<string, number> {
  const projected = Object.fromEntries(
    Object.keys(original).map((key) => [key, 0]),
  ) as Record<string, number>;
  for (const value of values) {
    projected[value] = (projected[value] ?? 0) + 1;
  }
  return projected;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/**
 * Project a validated audit report onto an approved finding subset without
 * recomputing its canonical content-coherence membership.
 *
 * The original report is validated before any projection is attempted. Each
 * surviving coherence component is the original component with rejected ids
 * removed; empty components (and their corresponding work blocks) disappear.
 * This preserves the auditor's membership decision while ensuring no rejected
 * finding can leak back through trace, block, seam, theme, or summary metadata.
 * The finished projection is validated again before it is returned.
 */
export function projectAuditFindingsReportSubset(
  value: unknown,
  selectedFindings: readonly Finding[],
): AuditFindingsReport {
  // Validate fail-closed before inspecting or copying any report fields.
  const originalProjection = projectApprovedFindings(value);
  const report = AuditFindingsReportSchema.parse(value);
  const originalIds = new Set(
    originalProjection.findings.map((finding) => finding.id),
  );
  const selectedById = new Map<string, Finding>();
  for (const finding of selectedFindings) {
    if (!originalIds.has(finding.id)) {
      throw new TypeError(
        `Cannot project unknown approved finding "${finding.id}".`,
      );
    }
    if (selectedById.has(finding.id)) {
      throw new TypeError(
        `Cannot project duplicate approved finding "${finding.id}".`,
      );
    }
    selectedById.set(finding.id, finding);
  }
  const selectedIds = new Set(selectedById.keys());

  const normalizedItems = report.coherence_trace.normalized_items.filter(
    (item) => selectedIds.has(item.id),
  );
  const normalizedById = new Map(
    normalizedItems.map((item) => [item.id, item]),
  );
  const componentBlocks = report.coherence_trace.components.flatMap(
    (component, index) => {
      const findingIds = component.filter((id) => selectedIds.has(id));
      if (findingIds.length === 0) return [];
      const originalBlock = report.work_blocks[index]!;
      const members = findingIds.map((id) => selectedById.get(id)!);
      const maxSeverity = members.reduce((highest, finding) =>
        severityRank(finding.severity) > severityRank(highest.severity)
          ? finding
          : highest,
      ).severity;
      return [{
        component: findingIds,
        block: {
          id: originalBlock.id,
          finding_ids: findingIds,
          unit_ids: stableUnique(
            findingIds.flatMap(
              (id) => normalizedById.get(id)?.unit_ids ?? [],
            ),
          ),
          owned_files: stableUnique(
            members.flatMap((finding) =>
              finding.affected_files.map((location) =>
                location.path.replace(/\\/gu, "/"),
              ),
            ),
          ),
          role: members.some((finding) => finding.systemic === true)
            ? "coordination" as const
            : "implementation" as const,
          max_severity: maxSeverity,
          rationale: `Canonical coherence subset retaining ${members.length} approved finding(s) from ${originalBlock.id}.`,
          depends_on: originalBlock.depends_on,
        },
      }];
    },
  );
  const survivingBlockIds = new Set(
    componentBlocks.map(({ block }) => block.id),
  );
  const workBlocks: WorkBlock[] = componentBlocks.map(({ block }) => ({
    ...block,
    depends_on: block.depends_on.filter((id) => survivingBlockIds.has(id)),
  }));
  const findings = report.findings
    .filter((finding) => selectedIds.has(finding.id))
    .map((finding) => {
      const selected = selectedById.get(finding.id)!;
      return selected.related_findings === undefined
        ? selected
        : {
            ...selected,
            related_findings: selected.related_findings.filter((id) =>
              selectedIds.has(id),
            ),
          };
    });
  const themes = report.themes
    ?.map((theme) => ({
      ...theme,
      finding_ids: theme.finding_ids.filter((id) => selectedIds.has(id)),
    }))
    .filter((theme) => theme.finding_ids.length > 0);
  const groundingPopulation = [
    ...findings,
    ...(report.quarantined_findings ?? []),
  ];

  const projected: AuditFindingsReport = {
    ...report,
    findings,
    coherence_trace: {
      normalized_items: normalizedItems,
      components: componentBlocks.map(({ component }) => component),
    },
    work_blocks: workBlocks,
    work_block_seams: report.work_block_seams.filter((seam) =>
      seam.block_ids.every((id) => survivingBlockIds.has(id)),
    ),
    ...(themes === undefined ? {} : { themes }),
    summary: {
      ...report.summary,
      finding_count: findings.length,
      work_block_count: workBlocks.length,
      severity_breakdown: projectedBreakdown(
        report.summary.severity_breakdown,
        findings.map((finding) => finding.severity),
      ),
      ...(report.summary.lens_breakdown === undefined
        ? {}
        : {
            lens_breakdown: projectedBreakdown(
              report.summary.lens_breakdown,
              findings.map((finding) => finding.lens),
            ),
          }),
      ...(report.summary.grounding_status_breakdown === undefined
        ? {}
        : {
            grounding_status_breakdown: projectedBreakdown(
              report.summary.grounding_status_breakdown,
              groundingPopulation.flatMap((finding) =>
                finding.grounding === undefined
                  ? []
                  : [finding.grounding.status],
              ),
            ),
          }),
    },
  };

  // A projection is a first-class canonical report, not a permissive internal
  // intermediate. Catch any membership/summary drift at the write boundary.
  projectApprovedFindings(projected);
  return projected;
}

export function isValidAuditFindingsReport(
  value: unknown,
): value is AuditFindingsReport {
  return inspectAuditFindingsReport(value).issues.every((issue) => issue.severity !== "error");
}

/**
 * Whether a parsed value CLAIMS to be the audit-findings contract: the
 * canonical `contract_version` plus a `findings` array. Deliberately light —
 * this is the ROUTING predicate (structured-contract path vs markdown/freeform
 * input), not a validity check. A report that claims the contract but fails
 * full validation must enter the structured path and be refused THERE with its
 * real issues (`projectApprovedFindings` / `validateAuditFindingsReport`);
 * routing on full validity would silently divert a malformed report to the
 * markdown parser, laundering a contract violation into a wrong-path parse.
 * INV-remediate-state-07 still holds: an absent or non-canonical
 * contract_version never routes structured.
 */
export function claimsAuditFindingsContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.contract_version === AUDIT_FINDINGS_CONTRACT_VERSION &&
    Array.isArray(value.findings)
  );
}
