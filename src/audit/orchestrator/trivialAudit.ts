import type { CoverageMatrix } from "../types.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import { isUnmeasuredLineCount } from "../cli/lineIndex.js";

const TRIVIAL_DOTFILES = new Set([".gitignore", ".gitattributes"]);

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

/**
 * AN UNMEASURED SIZE IS NOT A SIZE OF ZERO (DAT-3c07c004).
 *
 * `lineCount` is whatever the line index yielded for `path`, which is one of
 * THREE things, not two: a genuine count, the {@link UNMEASURED_LINE_COUNT}
 * sentinel `buildLineIndex` emits when the file could not be read, or `undefined`
 * for a key the index never carried. The last two are resolved through the ONE
 * shared predicate `isUnmeasuredLineCount` — never a local `?? 0`, which is
 * exactly the coercion that made a file nobody could measure indistinguishable
 * from a file genuinely containing nothing, and got it excluded from all audit
 * coverage without a trace.
 *
 * When the size is unmeasured only the SIZE-BASED rules are withheld; the
 * PATH-BASED rule still applies, because a `.gitignore` is trivial on the
 * strength of its name whether or not anyone managed to count its lines.
 */
export function isTrivialAuditPath(
  path: string,
  lineCount: number | undefined,
  hasExternalSignal = false,
): boolean {
  if (hasExternalSignal) {
    return false;
  }
  const measured = isUnmeasuredLineCount(lineCount) ? undefined : lineCount;

  if (measured === 0) {
    return true;
  }

  const name = basename(path).toLowerCase();
  if (TRIVIAL_DOTFILES.has(name)) {
    return true;
  }

  if (measured === undefined) {
    return false;
  }

  // Empty package markers and docstring-only __init__.py files create a lot of
  // audit churn without adding meaningful coverage signal.
  if (name === "__init__.py" && measured <= 3) {
    return true;
  }

  if (measured <= 1) {
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
    // No `?? 0` — an unmeasured file must be SKIPPED here (left un-excluded) so
    // it flows on to `buildPendingByLens` and earns a real, `unmeasured_line_count`
    // tagged task. This is the site that actually decided the file's fate: it runs
    // BEFORE `buildChunkedAuditTasks` (planningExecutors.ts), so a file excluded
    // here never reaches the task builder at all, and any leniency added downstream
    // is unreachable. A file that is trivial by NAME is still excluded.
    if (
      !isTrivialAuditPath(
        file.path,
        lineIndex[file.path],
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
