import type { CoverageMatrix } from "../types.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";

const TRIVIAL_DOTFILES = new Set([".gitignore", ".gitattributes"]);

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

export function isTrivialAuditPath(
  path: string,
  lineCount: number,
  hasExternalSignal = false,
): boolean {
  if (hasExternalSignal) {
    return false;
  }
  if (lineCount === 0) {
    return true;
  }

  const name = basename(path).toLowerCase();
  if (TRIVIAL_DOTFILES.has(name)) {
    return true;
  }

  // Empty package markers and docstring-only __init__.py files create a lot of
  // audit churn without adding meaningful coverage signal.
  if (name === "__init__.py" && lineCount <= 3) {
    return true;
  }

  if (lineCount <= 1) {
    return true;
  }

  return false;
}

export function autoCompleteTrivialCoverage(
  coverage: CoverageMatrix,
  lineIndex: Record<string, number>,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): string[] {
  const externalPaths = new Set(
    (externalAnalyzerResults ?? [])
      .flatMap((tool) => tool.results ?? [])
      .map((item) => item.path),
  );
  const skipped: string[] = [];

  for (const file of coverage.files) {
    if (file.audit_status === "excluded") {
      continue;
    }
    if (
      !isTrivialAuditPath(
        file.path,
        lineIndex[file.path] ?? 0,
        externalPaths.has(file.path),
      )
    ) {
      continue;
    }
    if (file.required_lenses.length === 0) {
      continue;
    }

    file.completed_lenses = [];
    file.required_lenses = [];
    file.audit_status = "excluded";
    file.classification_status = "excluded_trivial";
    file.unit_ids = [];
    skipped.push(file.path);
  }

  return skipped.sort();
}
