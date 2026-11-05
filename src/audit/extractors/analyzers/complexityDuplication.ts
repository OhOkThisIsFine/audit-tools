// sites-pinned: tests/audit/extractor-token-regressions.test.ts
import type { NodeMetric } from "audit-tools/shared";
import { getTreeSitterParser, type TsNode, type TsParser, type TsTree } from "./treeSitter.js";

/**
 * Per-node structural analyzers. The compute helpers do no IO — they read only a
 * passed-in source string and, for complexity, already-loaded tree-sitter
 * parsers ({@link loadFunctionComplexityParsers} is the one async loader).
 * Each helper returns a {@link NodeMetric} for js/ts source and
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

/**
 * The per-MODULE (single routine) cyclomatic limit recommended by McCabe and
 * Watson, NIST SP 500-235 (1996): a module whose complexity EXCEEDS 10 needs
 * justification, so a routine at exactly 10 is within the limit.
 */
const MCCABE_MODULE_LIMIT = 10;

/**
 * A complexity hotspot: a routine above the McCabe limit. Only the
 * `cyclomatic-max-function` measure is a per-routine number. The file-level proxy
 * (`cyclomatic-approx-file`, used when no grammar gave function boundaries) sums
 * every branch in the file, so comparing it with a per-routine limit would flag
 * a file of many small functions; it makes no hotspot claim at all.
 */
export function isComplexityHotspot(metric: Pick<NodeMetric, "measure" | "value">): boolean {
  return metric.measure === "cyclomatic-max-function" && metric.value > MCCABE_MODULE_LIMIT;
}

/**
 * A duplication signal: at least one line inside a repeated block. The block
 * size itself ({@link CLONE_MIN_LINES}) is the cited threshold; any line the
 * measure counts is already part of a clone.
 */
export function hasDuplicatedBlock(metric: Pick<NodeMetric, "value">): boolean {
  return metric.value > 0;
}

/**
 * Tree-sitter parsers that give js/ts function boundaries, one per grammar.
 * Each is optional: a grammar that failed to load degrades that file to the
 * lexical file-level proxy, never to a missing metric.
 */
export interface FunctionComplexityParsers {
  typescript?: TsParser;
  tsx?: TsParser;
  javascript?: TsParser;
}

/**
 * Load the three js/ts grammars (`tree-sitter-wasms`, a runtime dependency). The
 * caller owns the returned parsers and deletes them when its build ends.
 */
export async function loadFunctionComplexityParsers(): Promise<FunctionComplexityParsers> {
  const [typescript, tsx, javascript] = await Promise.all([
    getTreeSitterParser("typescript"),
    getTreeSitterParser("tsx"),
    getTreeSitterParser("javascript"),
  ]);
  return { typescript, tsx, javascript };
}

function parserFor(path: string, parsers: FunctionComplexityParsers | undefined): TsParser | undefined {
  if (!parsers) return undefined;
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return parsers.tsx;
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return parsers.typescript;
  // The javascript grammar parses JSX.
  return parsers.javascript;
}

/**
 * Which complexity measure a file gets under `parsers` — part of the graph
 * edge-cache key, so a contribution built with function boundaries and one built
 * from the file-level proxy are never replayed for each other.
 */
export function complexityScope(path: string, parsers: FunctionComplexityParsers | undefined): "function" | "file" {
  return parserFor(path, parsers) ? "function" : "file";
}

// Function-like nodes in the tree-sitter javascript / typescript / tsx grammars.
// Each opens its own cyclomatic count; its decisions never reach its parent.
const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "function",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
]);
// One decision point each (`else if` is a nested if_statement; `for…of` and
// `for…in` are for_in_statement; `default:` is a switch_default, not a decision).
const DECISION_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);
const SHORT_CIRCUIT_OPERATORS = new Set(["&&", "||", "??"]);

/**
 * The highest cyclomatic number (decisions + 1) of any function in the tree;
 * code outside every function counts as one more routine. Iterative, so a
 * deeply nested expression cannot exhaust the call stack.
 */
function maxFunctionComplexity(root: TsNode): number {
  const counters: Array<{ decisions: number }> = [{ decisions: 0 }];
  const stack: Array<{ node: TsNode; counter: { decisions: number } }> = [
    { node: root, counter: counters[0]! },
  ];
  while (stack.length > 0) {
    const { node, counter } = stack.pop()!;
    for (const child of node.namedChildren) {
      if (FUNCTION_NODE_TYPES.has(child.type)) {
        const own = { decisions: 0 };
        counters.push(own);
        stack.push({ node: child, counter: own });
        continue;
      }
      if (
        DECISION_NODE_TYPES.has(child.type) ||
        (child.type === "binary_expression" &&
          SHORT_CIRCUIT_OPERATORS.has(child.childForFieldName("operator")?.type ?? ""))
      ) {
        counter.decisions += 1;
      }
      stack.push({ node: child, counter });
    }
  }
  return counters.reduce((max, c) => Math.max(max, c.decisions + 1), 1);
}

// Branch / decision keywords used by the lexical file-level proxy. Counting
// these (plus one base path) approximates the number of independent paths
// through the WHOLE file without a parse — strings, comments and `?:` optional
// markers included, every function summed together.
// `??` is matched before the bare `?` alternative so nullish-coalescing
// counts as ONE branch token, like `&&`/`||`, not two bare `?` matches.
const BRANCH_KEYWORD_PATTERN =
  /\b(?:if|else\s+if|for|while|case|catch|do)\b|&&|\|\||\?\?|\?(?!\.)/g;

/**
 * Cyclomatic complexity of js/ts source. With a parser for the file's grammar,
 * the highest per-function cyclomatic number (`cyclomatic-max-function`).
 * Without one, or if the parse throws, a lexical branch count over the whole
 * file — a FILE-LEVEL PROXY (`cyclomatic-approx-file`), which overcounts against
 * a per-function limit. Returns `undefined` for non-js/ts source.
 */
export function computeComplexityMetric(
  path: string,
  source: string,
  parsers?: FunctionComplexityParsers,
): NodeMetric | undefined {
  if (!isJsTsPath(path)) return undefined;
  const parser = parserFor(path, parsers);
  if (parser) {
    let tree: TsTree | undefined;
    try {
      tree = parser.parse(source);
      return {
        value: maxFunctionComplexity(tree.rootNode),
        measure: "cyclomatic-max-function",
        reach: "js-ts-effective",
      };
    } catch {
      // Fall through to the file-level proxy: a parse failure must not drop the metric.
    } finally {
      tree?.delete();
    }
  }
  BRANCH_KEYWORD_PATTERN.lastIndex = 0;
  let branches = 0;
  while (BRANCH_KEYWORD_PATTERN.exec(source) !== null) branches += 1;
  return {
    value: branches + 1,
    measure: "cyclomatic-approx-file",
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
 * Smallest run of consecutive lines that counts as a clone: jscpd's documented
 * default minimum clone size (its `--min-lines` option, 5). A repeated single
 * LINE is not duplicated code — every
 * file repeats `});`, `/**`, `try {` — and counting lines flagged 1147 of 1285
 * js/ts files on this repository's own dogfood audit (2026-11-04).
 */
const CLONE_MIN_LINES = 5;

/**
 * Duplication measure: the number of non-trivial source lines that lie inside a
 * repeated block — a run of {@link CLONE_MIN_LINES} consecutive lines whose
 * content already appeared earlier in the file, not overlapping that earlier
 * copy (the first copy is the original and is not counted). Lines are
 * normalized (trimmed + whitespace collapsed); blank lines and lines shorter
 * than 3 chars are skipped before blocks are formed. Tagged
 * `duplicate-block-lines`. Returns `undefined` for non-js/ts source.
 */
export function computeDuplicationMetric(
  path: string,
  source: string,
): NodeMetric | undefined {
  if (!isJsTsPath(path)) return undefined;
  const lines: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const normalized = normalizeLine(rawLine);
    if (normalized.length >= 3) lines.push(normalized);
  }
  const firstStart = new Map<string, number>();
  const duplicated = new Set<number>();
  for (let start = 0; start + CLONE_MIN_LINES <= lines.length; start += 1) {
    const block = lines.slice(start, start + CLONE_MIN_LINES).join("\n");
    const earlier = firstStart.get(block);
    if (earlier === undefined) {
      firstStart.set(block, start);
    } else if (earlier + CLONE_MIN_LINES <= start) {
      for (let line = start; line < start + CLONE_MIN_LINES; line += 1) duplicated.add(line);
    }
  }
  return {
    value: duplicated.size,
    measure: "duplicate-block-lines",
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
  parsers?: FunctionComplexityParsers,
): { complexity?: NodeMetric; duplication?: NodeMetric } | undefined {
  if (!isJsTsPath(path)) return undefined;
  const complexity = computeComplexityMetric(path, source, parsers);
  const duplication = computeDuplicationMetric(path, source);
  const entry: { complexity?: NodeMetric; duplication?: NodeMetric } = {};
  if (complexity) entry.complexity = complexity;
  if (duplication) entry.duplication = duplication;
  return entry;
}
