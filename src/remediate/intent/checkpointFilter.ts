import type { Finding, IntentCheckpoint } from "audit-tools/shared";

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Exact path or directory-prefix match (e.g. "src/api" matches "src/api/x.ts"). */
function pathMatchesPrefix(filePath: string, entryPath: string): boolean {
  const f = normalize(filePath);
  const p = normalize(entryPath).replace(/\/+$/, "");
  if (!p) return false;
  return f === p || f.startsWith(`${p}/`);
}

/** Minimal glob match supporting `*` (within a segment) and `**` (across segments). */
function globMatches(filePath: string, glob: string): boolean {
  const f = normalize(filePath);
  const g = normalize(glob);
  if (!g.includes("*") && !g.includes("?")) {
    return pathMatchesPrefix(f, g);
  }
  // Translate the glob to a regex char-by-char so `*` / `**` / `?` are handled
  // and every other character is escaped — no placeholder substitution.
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(f);
}

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
  const excluded = checkpoint.excluded_scope ?? [];
  const mustNotTouch = checkpoint.must_not_touch ?? [];
  // A finding is excluded if ANY of its files falls under an excluded path or a
  // must-not-touch glob — remediating it would require touching forbidden scope.
  return paths.some(
    (path) =>
      excluded.some((entry) => pathMatchesPrefix(path, entry.path)) ||
      mustNotTouch.some((glob) => globMatches(path, glob)),
  );
}

/**
 * Drop findings the intent checkpoint excludes: those that fail the severity /
 * lens / package / theme filters, or whose files fall under `excluded_scope` /
 * `must_not_touch`. Returns the kept findings and the ids of the dropped ones
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
    (checkpoint.must_not_touch?.length ?? 0) > 0;
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
