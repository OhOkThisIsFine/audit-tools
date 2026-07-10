import {
  fileExclusionReason,
  pathMatchesPrefix,
  type Finding,
  type IntentCheckpoint,
} from "audit-tools/shared";

function affectedPaths(finding: Finding): string[] {
  return (finding.affected_files ?? []).map((f) => f.path).filter(Boolean);
}

function matchesFilters(
  finding: Finding,
  filters: IntentCheckpoint["filters"],
): boolean {
  if (!filters) return true;
  if (filters.severity?.length && !filters.severity.includes(finding.severity)) {
    return false;
  }
  if (filters.lenses?.length && !filters.lenses.includes(finding.lens)) {
    return false;
  }
  if (filters.themes?.length) {
    const themeKeys = [finding.theme_id, finding.category].filter(
      (v): v is string => typeof v === "string",
    );
    if (!themeKeys.some((k) => filters.themes!.includes(k))) return false;
  }
  if (filters.packages?.length) {
    const paths = affectedPaths(finding);
    const inPackage = paths.some((path) =>
      filters.packages!.some((pkg) => pathMatchesPrefix(path, pkg)),
    );
    if (!inPackage) return false;
  }
  return true;
}

function isPathExcluded(finding: Finding, checkpoint: IntentCheckpoint): boolean {
  const paths = affectedPaths(finding);
  if (paths.length === 0) return false;
  // A finding is excluded if ANY of its files falls under the checkpoint's structured
  // scope (excluded_scope / disposition_overrides / must_not_touch) — remediating it
  // would require touching forbidden scope. Per-file field coverage is single-sourced
  // with audit via the shared `fileExclusionReason`; only the ANY-file aggregation
  // (vs audit's every-file) is remediate's domain policy.
  return paths.some((path) => fileExclusionReason(path, checkpoint) !== null);
}

/**
 * Drop findings the intent checkpoint excludes: those that fail the severity /
 * lens / package / theme filters, or whose files fall under the structured scope
 * (`excluded_scope` / `disposition_overrides` / `must_not_touch`). Returns the
 * kept findings and the ids of the dropped ones
 * (for the coverage ledger and the final report). A checkpoint with no filters
 * or exclusions keeps everything. A draft checkpoint (confirmed_by: "draft") is
 * not yet confirmed — no filtering is applied.
 */
export function filterFindingsByCheckpoint(
  findings: Finding[],
  checkpoint: IntentCheckpoint | undefined,
): { kept: Finding[]; droppedIds: string[] } {
  if (!checkpoint) return { kept: findings, droppedIds: [] };
  // Draft checkpoints have not been confirmed by the host; treat as absent.
  if (checkpoint.confirmed_by === "draft") return { kept: findings, droppedIds: [] };
  const hasConstraints =
    Boolean(checkpoint.filters) ||
    (checkpoint.excluded_scope?.length ?? 0) > 0 ||
    (checkpoint.must_not_touch?.length ?? 0) > 0 ||
    (checkpoint.disposition_overrides?.length ?? 0) > 0;
  if (!hasConstraints) return { kept: findings, droppedIds: [] };

  const droppedIds: string[] = [];
  const kept = findings.filter((finding) => {
    if (
      !matchesFilters(finding, checkpoint.filters) ||
      isPathExcluded(finding, checkpoint)
    ) {
      droppedIds.push(finding.id);
      return false;
    }
    return true;
  });
  return { kept, droppedIds };
}
