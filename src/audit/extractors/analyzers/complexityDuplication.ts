import type { NodeMetric } from "audit-tools/shared";

/**
 * Pure-JS per-node structural analyzers (no IO — operate only on a passed-in
 * source string). Each helper returns a {@link NodeMetric} for js/ts source and
 * `undefined` for everything else, so the bundle records ABSENCE (never a
 * zero-filled metric) for non-js/ts files.
 */

const JS_TS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** True for the JS/TS source files these metrics are defined over. */
export function isJsTsPath(path: string): boolean {
  const lower = path.toLowerCase();
  // `.d.ts` is a declaration file with no executable body — exclude it so a
  // type-only file is not credited with code complexity.
  if (lower.endsWith(".d.ts")) return false;
  return JS_TS_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// Branch / decision keywords used by the cyclomatic-approx measure. Counting
// these (plus one base path) approximates the number of independent paths
// through the source without a full parse — deliberately a lexical heuristic,
// hence the `-approx` suffix in the measure name.
const BRANCH_KEYWORD_PATTERN =
  /\b(?:if|else\s+if|for|while|case|catch|do)\b|&&|\|\||\?(?!\.)/g;

/**
 * Approximate cyclomatic complexity by counting branch/decision tokens plus a
 * base path of 1. Lexical (no parse) → tagged `cyclomatic-approx`. Returns
 * `undefined` for non-js/ts source.
 */
export function computeComplexityMetric(
  path: string,
  source: string,
): NodeMetric | undefined {
  if (!isJsTsPath(path)) return undefined;
  BRANCH_KEYWORD_PATTERN.lastIndex = 0;
  let branches = 0;
  while (BRANCH_KEYWORD_PATTERN.exec(source) !== null) branches += 1;
  return {
    value: branches + 1,
    measure: "cyclomatic-approx",
    reach: "js-ts-effective",
  };
}

/**
 * Normalize a source line for duplication fingerprinting: trim surrounding
 * whitespace and collapse internal runs of whitespace to a single space so that
 * cosmetic reformatting does not hide a duplicate.
 */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Duplication measure: the count of non-trivial source lines that appear more
 * than once (i.e. the number of duplicated line occurrences, excluding the
 * first occurrence of each). Lines are normalized (trimmed + whitespace
 * collapsed); blank lines and lines shorter than 3 chars are ignored as noise.
 * Tagged `duplicate-line-count`. Returns `undefined` for non-js/ts source.
 */
export function computeDuplicationMetric(
  path: string,
  source: string,
): NodeMetric | undefined {
  if (!isJsTsPath(path)) return undefined;
  const counts = new Map<string, number>();
  for (const rawLine of source.split(/\r?\n/)) {
    const normalized = normalizeLine(rawLine);
    if (normalized.length < 3) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  let duplicated = 0;
  for (const occurrences of counts.values()) {
    if (occurrences > 1) duplicated += occurrences - 1;
  }
  return {
    value: duplicated,
    measure: "duplicate-line-count",
    reach: "js-ts-effective",
  };
}

/**
 * Compute both metrics for one file. Returns `undefined` for non-js/ts source
 * (so the caller records no entry at all). For js/ts, always returns both a
 * complexity and a duplication metric.
 */
export function computeNodeMetricsForFile(
  path: string,
  source: string,
): { complexity?: NodeMetric; duplication?: NodeMetric } | undefined {
  if (!isJsTsPath(path)) return undefined;
  const complexity = computeComplexityMetric(path, source);
  const duplication = computeDuplicationMetric(path, source);
  const entry: { complexity?: NodeMetric; duplication?: NodeMetric } = {};
  if (complexity) entry.complexity = complexity;
  if (duplication) entry.duplication = duplication;
  return entry;
}
