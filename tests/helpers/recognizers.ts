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

// ── comment-symbol-drift ─────────────────────────────────────────────────────

/**
 * Identifier-shaped tokens a COMMENT cites in backticks — the ones a rename or
 * a deletion can strand.
 *
 * The rule this feeds: a comment that names a symbol must be reconciled against
 * the code it describes. It was previously gated by NOTHING, which is exactly
 * how `src/shared/continuityScore.ts`'s header went on claiming that audit
 * re-exported `computeContinuityScores` and biased review-packet ORDERING with
 * it long after the wiring was deleted — and `check-doc-code-citations` scans
 * DOCS, never comments, so no gate was even in a position to notice.
 *
 * Deliberately NARROW, because a comment is prose and the cost of a false red is
 * a gate nobody trusts. The exclusions are RULES, never a hand-list:
 *   • only backticked spans on a comment line (`//`, `*`, `/*`);
 *   • only bare identifiers — dotted, slashed, or quoted forms are a path or a
 *     member access, not a symbol this module could look up;
 *   • only names in one of the two spellings a SYMBOL actually takes: a
 *     compound ALL_CAPS constant (`STALE_LOCK_MS`) or a lowerCamelCase
 *     identifier (`voiQueue`, `renderConceptualReviewPrompt`). Prose words
 *     (`findings`), JS built-ins (`NaN`, `RangeError`), errno codes (`ENOENT`)
 *     and short device names (`COM1`) are single capitalised tokens, so they
 *     match neither spelling. A camelCase HOST GLOBAL (`structuredClone`,
 *     `setInterval`) does match, so those are excluded by an explicit name set
 *     rather than by shape — a finite, stable list of platform APIs, which is
 *     exactly the kind of thing a list IS right for;
 *   • never a name that also appears as a NON-comment token in the same file —
 *     a comment referencing the symbol its own file declares is self-evidencing
 *     and needs no cross-tree lookup.
 *
 * This returns CANDIDATES, not verdicts: the caller applies the resolution rule
 * (is this name exported anywhere in the tree?). Keeping the predicate in the
 * caller is what lets the same recognizer drive both the whole-tree guard and a
 * text-only shape check, which is how P51's form-reach data drives it.
 *
 * What this still CANNOT catch, declared rather than implied: a comment that
 * states a workflow SHAPE (which pass runs first, how many lanes exist) names no
 * identifier, so no text rule reaches it — those are the cases the reconciliation
 * is honest about not covering. And the exclusion of names appearing in the same
 * file's code means a comment can cite a symbol the file MENTIONS but no longer
 * declares without this firing; the export rule is what makes that rare, since a
 * genuinely-deleted import would take the mention with it.
 */
/** Same exemption idiom as the doc gates: explicit, inline, never inferred from prose. */
export const COMMENT_SYMBOL_EXEMPT = /comment-symbol-exempt:/;

/**
 * camelCase HOST GLOBALS — platform APIs a comment may name as prose. A closed,
 * stable list of the runtime's own surface, not of this repo's symbols; a name
 * in here is never a citation to something the tree is supposed to declare.
 */
export const HOST_GLOBALS: ReadonlySet<string> = new Set([
  "structuredClone",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
  "queueMicrotask",
  "requestAnimationFrame",
  "process",
  "require",
]);

/**
 * Comment-line indices an exemption marker covers: the marked line, and every
 * comment line after it in the same contiguous block.
 *
 * The block reach is what makes ONE marker enough for the class this exists for
 * — a comment recording that symbols were DELETED names several of them across
 * several lines, and a citation to a correctly-absent symbol is not drift. The
 * reach stops at the first non-comment line so a marker can never silently
 * exempt an unrelated comment further down the file.
 */
function exemptLines(lines: readonly string[]): Set<number> {
  const isComment = (line: string) => {
    const trimmed = line.trim();
    return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
  };
  const exempt = new Set<number>();
  let open = false;
  lines.forEach((raw, index) => {
    const comment = isComment(raw);
    if (!comment) {
      open = false;
      return;
    }
    if (COMMENT_SYMBOL_EXEMPT.test(raw)) open = true;
    if (open) exempt.add(index);
  });
  return exempt;
}

export function backtickedSymbolsInComments(
  text: string,
): { line: number; text: string; symbol: string }[] {
  const hits: { line: number; text: string; symbol: string }[] = [];
  const lines = text.split(/\r?\n/);
  const exempt = exemptLines(lines);
  const codeTokens = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const isComment =
      trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
    if (isComment) continue;
    for (const match of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) codeTokens.add(match[0]);
  }
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    const isComment =
      trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
    if (!isComment) return;
    // Deliberate ancient-history prose: a comment SAYING a symbol used to live
    // here and was superseded names something that is correctly absent, and
    // reddening it would force the history out of the comment that exists to
    // record it. Same class, same fix, as the doc gates' inline marker.
    if (exempt.has(index)) return;
    for (const match of raw.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim();
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) continue;
      // A compound ALL_CAPS constant (`STALE_LOCK_MS`, `CONCEPTUAL_FINDING_
      // CATEGORIES`) or a lowerCamelCase identifier. A single-token capitalised
      // word is neither: `NaN`/`RangeError` name JS built-ins, `ENOENT`/
      // `ENOBUFS`/`ETIMEDOUT` name errno codes, and `COM1` a device — all of
      // them things a comment may legitimately name as PROSE about a host API,
      // none a symbol this tree declares. Excluding them by shape needs no list.
      // BOTH anchored, and the camel arm anchored at BOTH ends: the doc gate's
      // spec-symbol rule learned this the hard way — `/…[A-Z]/` alone matches a
      // PREFIX, so a call-shaped example in prose (`writeContractArtifact(...)`,
      // `deriveNodeFiles(node)`) was reported as a dangling symbol when it is
      // simply not a citation. The two legs share one spelling rule.
      const isConstant = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(token);
      const isCamel = /^[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(token);
      if (!isConstant && !isCamel) continue;
      if (HOST_GLOBALS.has(token)) continue;
      if (codeTokens.has(token)) continue;
      hits.push({ line: index + 1, text: trimmed, symbol: token });
    }
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
 * The EMITTED-LANE execution-choice vocabulary — the keys a demand ranking must
 * never carry (`tests/shared/lane-demand.test.ts`).
 *
 * `BANNED_SIZING_KEY` above already covers `provider` and `model`; the rest are
 * this boundary's own. They are the terms the retired execution substrate named,
 * and the ones a well-meaning "just tell the host how big a model to use" edit
 * reaches for first: `tier`, `backend`, `pool`, `agent`, `quota`,
 * `context_window`, `max_tokens`, `temperature`. Kept separate from the sizing
 * ban because the DEMAND vocabulary legitimately carries the word `lane` as
 * prose while a `lane_id` field is exactly the leak — a whole-word ban cannot
 * tell those apart, so this one is keyed on the exact field name.
 */
export const BANNED_LANE_EXECUTION_SEGMENTS: readonly string[] = [
  "model",
  "provider",
  "tier",
  "backend",
  "pool",
  "agent",
  "quota",
  "context_window",
  "max_tokens",
  "temperature",
];

/**
 * True when a field NAME names an execution choice.
 *
 * SEGMENT-wise, not whole-word: the shipped field is `model_tier`, and a `\b`
 * boundary does not sit between `model` and `_` — both are word characters — so
 * a whole-word rule misses exactly the compound spellings a real edit produces
 * (`model_tier`, `provider_name`, `tier_hint`). Found by running this guard
 * against a deliberately injected `model_tier`: it stayed GREEN.
 *
 * Only `_`/`-`-separated SEGMENTS are matched, never substrings, so demand
 * vocabulary that merely contains a banned run of letters is untouched.
 */
export function isLaneExecutionKey(key: string): boolean {
  const segments = key.toLowerCase().split(/[^a-z0-9]+/u).filter((s) => s.length > 0);
  return segments.some((segment) => BANNED_LANE_EXECUTION_SEGMENTS.includes(segment));
}

/** The historical whole-word regex form, kept for prose-shaped input. */
export const BANNED_LANE_EXECUTION_KEY =
  /\b(model|provider|tier|backend|pool|agent|quota|context_window|max_tokens|temperature)\b/iu;

/**
 * Keys of an emitted object that name an execution choice rather than demand —
 * or, given JSON text, the same keys parsed out of it. The sibling of
 * {@link bannedSizingKeys} for the lane-demand shape.
 */
export function bannedLaneExecutionKeys(input: unknown): string[] {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  return objectKeys(value).filter(isLaneExecutionKey);
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
