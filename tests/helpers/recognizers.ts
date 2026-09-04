// The pure text recognizers behind six contract tests, in ONE home.
//
// Each of these tests is a form-recognizing guard: it scans source or docs for
// a syntax shape and reds when it finds (or fails to find) one. P51 (owner
// decision baf2da68fa9cd24f) declares every such guard's recognized FORMS as
// data in scripts/guard-reach-data.mjs, and tests/shared/guard-form-reach.test.ts
// drives the REAL recognizer over each declared sample. A recognizer inlined in
// a test file cannot be driven that way — importing a test file runs its tests
// — so the matchers live here and both the owning test and the form check call
// the same function. One regex, one home: an edit here is what both exercise.
import { maskCode } from "../../scripts/check-doc-links.mjs";
import { LANE_RESULTS_HEADING } from "../../src/audit/cli/fanoutLanes.js";

// ── conceptual-category-comment-drift ────────────────────────────────────────

/**
 * The eight conceptual-design finding categories the review prompt emits. The
 * canonical occurrence is the `one of: …` enum inside `conceptualOutputFormat`
 * (src/audit/orchestrator/designReviewPrompt.ts); this pinned copy is what lets
 * the drift test notice a re-enumeration anywhere else.
 */
export const CONCEPTUAL_CATEGORY_TOKENS = [
  "fundamental_approach",
  "core_assumption",
  "structural_risk",
  "architecture_pattern",
  "design_simplification",
  "tool_opportunity",
  "integration",
  "missing_capability",
] as const;

/** A comment line that names 3+ canonical tokens is a hand copy of the set. */
export function enumeratingCommentLines(
  text: string,
  tokens: readonly string[] = CONCEPTUAL_CATEGORY_TOKENS,
): { line: number; text: string; named: string[] }[] {
  const hits: { line: number; text: string; named: string[] }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    const isComment =
      trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
    if (!isComment) return;
    const named = tokens.filter((token) => raw.includes(token));
    if (named.length >= 3) hits.push({ line: index + 1, text: trimmed, named });
  });
  return hits;
}

// ── sync-spawn-fold-safety ───────────────────────────────────────────────────

// Sync spawn entry points. `runTrackedAsync(` also contains `runTracked` as a
// substring, so the sync-twin token is matched with a negative lookahead.
const SYNC_SPAWN_TOKENS: { label: string; pattern: RegExp }[] = [
  { label: "spawnSync", pattern: /\bspawnSync\b/u },
  { label: "spawnSyncHidden", pattern: /\bspawnSyncHidden\b/u },
  { label: "runTracked (sync twin)", pattern: /\brunTracked(?!Async)\b/u },
  { label: "execSync", pattern: /\bexecSync\b/u },
];

/**
 * Code lines that reach a synchronous spawn. Comments may NAME the sync twin
 * (e.g. "never runTracked"); only code lines count — a leading `*`, `//` or
 * `/*` marks the documentation lines.
 */
export function syncSpawnHits(source: string): { line: number; label: string; text: string }[] {
  const hits: { line: number; label: string; text: string }[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const token of SYNC_SPAWN_TOKENS) {
      if (token.pattern.test(line)) hits.push({ line: index + 1, label: token.label, text: trimmed });
    }
  }
  return hits;
}

// ── shipped-doc-surface ──────────────────────────────────────────────────────

/** Inline links and reference definitions, code masked so examples are not links. */
export function relativeLinkTargets(markdown: string): string[] {
  const masked = maskCode(markdown.replace(/\r\n/g, "\n"));
  const targets: string[] = [];
  for (const pattern of [
    /\[[^\]]*\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g,
    /^[ \t]{0,3}\[[^\]]+\]:[ \t]+<?([^\s<>]+)>?/gm,
  ]) {
    for (const match of masked.matchAll(pattern)) targets.push(match[1]);
  }
  return targets.filter(
    (target) =>
      !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#") && !target.startsWith("//"),
  );
}

/**
 * GitHub's heading slugs: lowercased, punctuation dropped, spaces hyphenated.
 * Code spans and inline links in a heading contribute their text only.
 */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  // Fences masked (a `#` line inside one is not a heading), but NOT inline code
  // spans: maskCode blanks their bytes, and GitHub keeps the text inside them.
  const body = markdown
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?^[ \t]{0,3}\1[ \t]*$/gm, (m) => m.replace(/[^\n]/g, " "));
  for (const match of body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm)) {
    const text = match[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase();
    anchors.add(text.replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-"));
  }
  return anchors;
}

/** Every `owner/repo` slug spelled in an absolute GitHub URL, code masked. */
export function absoluteGitHubSlugs(markdown: string): string[] {
  const text = maskCode(markdown.replace(/\r\n/g, "\n"));
  return [...text.matchAll(/https:\/\/github\.com\/([^/\s)#]+)\/([^/\s)#]+)/g)].map(
    (match) => `${match[1]}/${match[2]}`,
  );
}

// ── source scans shared by the submission and prompt guards ──────────────────

/**
 * Drop comments before scanning source, so a guard is about CODE. Block comments
 * are blanked to their own newlines so reported line numbers stay true; only
 * whole-line `//` comments are stripped, so a `https://` inside a string literal
 * is never mistaken for one.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Sizing / execution / transport identity — none of it is this package's business. */
export const BANNED_SIZING_KEY =
  /packet_id|wave_id|shard|provider|model|endpoint|token_budget|budget|cost|rate_limit|concurrency|lease|admission|window|transport/iu;

/** The same ban as source identifiers, whole-word so `submission_path` is untouched. */
const BANNED_SIZING_IDENTIFIER =
  /\b(packet_id|wave_id|shard_index|shard|provider|model|endpoint|token_budget|max_tokens|context_window|rate_limit|concurrency|lease|admission|transport)\b/iu;

/** Recursive key walk (same idiom as tests/audit/host-handoff.test.ts). */
export function objectKeys(value: unknown, seen: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) objectKeys(item, seen);
    return seen;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      seen.push(key);
      objectKeys(child, seen);
    }
  }
  return seen;
}

/**
 * Keys carrying sizing identity anywhere in an emitted object — or in JSON
 * text, which is how a declared form sample arrives.
 */
export function bannedSizingKeys(input: unknown): string[] {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  return objectKeys(value).filter((key) => BANNED_SIZING_KEY.test(key));
}

/** Code lines that reintroduce the retired execution/sizing vocabulary. */
export function bannedSizingIdentifierLines(source: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  stripComments(source)
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (BANNED_SIZING_IDENTIFIER.test(line)) hits.push({ line: index + 1, text: line.trim() });
    });
  return hits;
}

/**
 * Code lines that name the retired `incoming/` submission directory — as a
 * path segment (`join(artifactsDir, "incoming", …)`) or as a rendered literal
 * (`incoming/<name>.json`) in a prompt or packet body.
 */
export function incomingLiteralLines(source: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  stripComments(source)
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (/["'`]incoming["'`]/.test(line) || /incoming\//.test(line)) {
        hits.push({ line: index + 1, text: line.trim() });
      }
    });
  return hits;
}

// ── prompt-capability ────────────────────────────────────────────────────────

/** The `- \`<path>\` (<key>)` entries a rendered "## Required Inputs" block lists. */
export function requiredInputEntries(prompt: string): Array<{ path: string; key: string }> {
  const section = prompt.split(/^## Required Inputs$/m)[1];
  if (section === undefined) return [];
  const body = section.split(/^## /m)[0]!;
  return [...body.matchAll(/^- `([^`]+)` \(([a-z_]+)\)$/gm)].map((match) => ({
    path: match[1]!,
    key: match[2]!,
  }));
}

/**
 * Code lines that mint a second results-path section or promise one "provided
 * below" — the two shapes that let the bound path and its alternative drift.
 */
export function resultsPathDriftLines(source: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  stripComments(source)
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.includes(LANE_RESULTS_HEADING) || /results path provided below/i.test(line)) {
        hits.push({ line: index + 1, text: line.trim() });
      }
    });
  return hits;
}
