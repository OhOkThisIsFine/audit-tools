// Comment-decomposition extractor (Phase B intent-declared source; design of
// record spec/conceptual-design-review-design.md §"Structure decomposition
// sources" rule 2: "Comments are their own delta — comments are stated intent
// embedded in code").
//
// Comments are stated intent embedded in the code. This extractor mines the
// INTENT-DECLARED structure they assert: where a file's comments explicitly
// cross-reference another in-scope file (by path), the author is declaring the
// two related. Those cross-references become an intent-declared coupling source
// that the overlay-and-delta operator compares against the behavior graphs — a
// comment that claims a boundary the code does not honor surfaces as a
// non-co-localization finding downstream.
//
// The "stripped vs unstripped" pair the design calls for falls out structurally:
// the STRIPPED view (code without comments) is exactly the existing call/import
// coupling graph; the UNSTRIPPED intent is this comment source. Phase C layers the
// LLM comments-stripped semantic-cohesion pass on top; Phase B stays deterministic.
//
// Comment lexing is keyed by file EXTENSION — comment syntax is per-language
// lexical fact, not an environment coupling (the language-neutral invariant is
// about the graph/planning contract, not pretending `.py` doesn't use `#`).
// Unknown extensions fall back to the C-family `//` + `/* */` so a stray `#`
// (e.g. a JS private field) is never misread as a comment.

import { join } from "node:path";
import type { CouplingEdge } from "./dataStateCoupling.js";
import { DEFAULT_MAX_BYTES, defaultReadFileText } from "./readFileText.js";
import { toPosixPath } from "../../shared/paths.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";

interface CommentSyntax {
  line: string[];
  block: Array<[string, string]>;
}

const C_FAMILY: CommentSyntax = { line: ["//"], block: [["/*", "*/"]] };
const HASH_ONLY: CommentSyntax = { line: ["#"], block: [] };
const PY: CommentSyntax = {
  line: ["#"],
  block: [
    ['"""', '"""'],
    ["'''", "'''"],
  ],
};
const MARKUP: CommentSyntax = { line: [], block: [["<!--", "-->"]] };
const CSS: CommentSyntax = { line: [], block: [["/*", "*/"]] };
const SQL_LIKE: CommentSyntax = { line: ["--"], block: [["/*", "*/"]] };

/** Extension (with dot, lowercased) → comment syntax. Unknown → C_FAMILY. */
const SYNTAX_BY_EXT: Record<string, CommentSyntax> = {
  ".js": C_FAMILY, ".jsx": C_FAMILY, ".ts": C_FAMILY, ".tsx": C_FAMILY,
  ".mjs": C_FAMILY, ".cjs": C_FAMILY, ".mts": C_FAMILY, ".cts": C_FAMILY,
  ".java": C_FAMILY, ".c": C_FAMILY, ".h": C_FAMILY, ".cpp": C_FAMILY,
  ".hpp": C_FAMILY, ".cc": C_FAMILY, ".cs": C_FAMILY, ".go": C_FAMILY,
  ".rs": C_FAMILY, ".swift": C_FAMILY, ".kt": C_FAMILY, ".scala": C_FAMILY,
  ".php": C_FAMILY, ".dart": C_FAMILY,
  ".py": PY, ".pyi": PY,
  ".rb": HASH_ONLY, ".sh": HASH_ONLY, ".bash": HASH_ONLY, ".zsh": HASH_ONLY,
  ".yaml": HASH_ONLY, ".yml": HASH_ONLY, ".toml": HASH_ONLY, ".r": HASH_ONLY,
  ".pl": HASH_ONLY, ".conf": HASH_ONLY, ".ini": HASH_ONLY, ".cfg": HASH_ONLY,
  ".sql": SQL_LIKE, ".lua": SQL_LIKE, ".hs": SQL_LIKE, ".elm": SQL_LIKE,
  ".html": MARKUP, ".htm": MARKUP, ".xml": MARKUP, ".vue": MARKUP,
  ".svelte": MARKUP, ".md": MARKUP, ".markdown": MARKUP,
  ".css": CSS, ".scss": CSS, ".less": CSS,
};

function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}

function syntaxFor(path: string): CommentSyntax {
  return SYNTAX_BY_EXT[extensionOf(path)] ?? C_FAMILY;
}

/** One comment span: outer offsets include the markers, inner offsets exclude them. */
interface CommentSpan {
  outerStart: number;
  outerEnd: number;
  innerStart: number;
  innerEnd: number;
}

/**
 * Scan a source file for its comment spans, honoring the file's comment syntax
 * and skipping string literals (single/double/backtick, backslash-escaped) so a
 * comment marker inside a string is not misread. A single-pass char scanner:
 * normal → string → line-comment → block-comment. Degrades gracefully (an
 * unterminated block just consumes to EOF).
 *
 * The ONE home of the comment grammar walk: `extractCommentText` (the stated
 * channel's evidence) and `stripCommentText` (the revealed channel's feed) are
 * both thin consumers of these spans, so extract and strip can never disagree on
 * what a comment is.
 */
function scanCommentSpans(source: string, path: string): CommentSpan[] {
  const syntax = syntaxFor(path);
  const spans: CommentSpan[] = [];
  const n = source.length;
  let i = 0;

  const startsWith = (marker: string): boolean =>
    source.startsWith(marker, i);

  while (i < n) {
    const ch = source[i]!;

    // String literals — skip so markers inside them don't count.
    if (ch === '"' || ch === "'" || ch === "`") {
      // Python triple-quote docstrings are handled as block comments below; only
      // treat as a string here when it is NOT an opening triple quote for PY.
      const triple = ch + ch + ch;
      const isTriple = startsWith(triple);
      const treatAsBlock = syntax.block.some(([open]) => open === triple);
      if (!(isTriple && treatAsBlock)) {
        i += 1;
        while (i < n) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === ch) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
    }

    // Block comments (incl. Python triple-quote docstrings).
    let matchedBlock = false;
    for (const [open, close] of syntax.block) {
      if (startsWith(open)) {
        const end = source.indexOf(close, i + open.length);
        const innerEnd = end === -1 ? n : end;
        const outerEnd = end === -1 ? n : end + close.length;
        spans.push({
          outerStart: i,
          outerEnd,
          innerStart: i + open.length,
          innerEnd,
        });
        i = outerEnd;
        matchedBlock = true;
        break;
      }
    }
    if (matchedBlock) continue;

    // Line comments.
    let matchedLine = false;
    for (const marker of syntax.line) {
      if (startsWith(marker)) {
        const nl = source.indexOf("\n", i);
        const stop = nl === -1 ? n : nl;
        spans.push({
          outerStart: i,
          outerEnd: stop,
          innerStart: i + marker.length,
          innerEnd: stop,
        });
        i = stop;
        matchedLine = true;
        break;
      }
    }
    if (matchedLine) continue;

    i += 1;
  }

  return spans;
}

/** Extract concatenated comment text from source (the spans' inner slices). */
export function extractCommentText(source: string, path: string): string {
  return scanCommentSpans(source, path)
    .map((span) => source.slice(span.innerStart, span.innerEnd))
    .join("\n");
}

/**
 * Mask every comment span with spaces, preserving newlines — so the result has
 * EXACTLY the same number of lines as the source and every surviving character
 * sits at its original line.
 *
 * This is the substrate of the line-true packet channels, and it is a
 * REIMPLEMENTATION rather than a wrapper over {@link stripCommentText} on
 * purpose. `stripCommentText` REMOVES span text and then collapses blank-line
 * runs, so its output's line indices have no relation to the source's; deriving a
 * line number from it would emit confidently wrong provenance, which is the exact
 * failure the packet contract exists to close. `stripCommentText` keeps its
 * signature and its collapse for its own consumers.
 */
function maskCommentSpans(source: string, path: string): string {
  const spans = scanCommentSpans(source, path);
  if (spans.length === 0) return source;
  // SLICE-based, exactly like `stripCommentText` — so the mask and the strip
  // partition the file identically and cannot disagree about a span boundary.
  //
  // ⚠ Every offset `scanCommentSpans` emits is a UTF-16 CODE UNIT index: it
  // walks with `source[i]` and `String.prototype.indexOf`. Indexing the mask by
  // code POINT (`[...source]`) drifts one position left per astral character
  // preceding a comment, so the comment text stops being masked and real code is
  // blanked in its place — the revealed channel then ships the comment it exists
  // to remove, and the structural channel publishes it as a declaration. Three of
  // the 123 `src/` files in the repo that motivated this carry emoji. `slice`
  // takes the same code-unit indices the scanner produced, so the two agree by
  // construction rather than by luck.
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(source.slice(cursor, span.outerStart));
    // Blank the span's content while KEEPING its newlines, so every later line
    // keeps its true number.
    parts.push(
      source.slice(span.outerStart, span.outerEnd).replace(/[^\n]/g, " "),
    );
    cursor = span.outerEnd;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

/** One source line with its TRUE 1-based number. */
export interface NumberedSourceLine {
  line: number;
  text: string;
}

/**
 * The comment text of a file, span by span, each line carrying its TRUE 1-based
 * source line number. The span-preserving twin of {@link extractCommentText},
 * which joins the inner slices and discards every position.
 *
 * `scanCommentSpans` already computes `innerStart`/`innerEnd`; the line numbers
 * were always derivable from those offsets and were simply thrown away. Blank
 * lines inside a span are dropped — they carry no testimony — so a multi-line
 * block comment yields one run per contiguous stretch of substantive lines.
 */
export function extractCommentLines(
  source: string,
  path: string,
): NumberedSourceLine[] {
  const spans = scanCommentSpans(source, path);
  if (spans.length === 0) return [];
  const lineStarts = lineStartOffsets(source);
  const byLine = new Map<number, string>();
  for (const span of spans) {
    const inner = source.slice(span.innerStart, span.innerEnd);
    let lineNo = lineNumberAt(lineStarts, span.innerStart);
    for (const text of inner.split("\n")) {
      if (text.trim().length > 0) {
        const existing = byLine.get(lineNo);
        byLine.set(lineNo, existing === undefined ? text : `${existing} ${text}`);
      }
      lineNo += 1;
    }
  }
  return [...byLine.keys()]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: byLine.get(line)! }));
}

/**
 * The comment-stripped source of a file, each surviving line carrying its TRUE
 * 1-based source line number. The line-true twin of {@link stripCommentText}.
 *
 * A line whose content was entirely comment disappears, which leaves a GAP in the
 * numbering. That gap discloses where comment blocks are and how large they are —
 * never what they say. It is a bounded, deliberate reversal of the 2026-08-05
 * blank-run collapse for THIS channel only: there is no leak-free line-true
 * option (padding the removed spans reproduces the same negative space), and
 * without line truth the revealed channel's citations cannot be validated at all.
 */
export function strippedSourceLines(
  source: string,
  path: string,
): NumberedSourceLine[] {
  const masked = maskCommentSpans(source, path);
  const out: NumberedSourceLine[] = [];
  const lines = masked.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!.replace(/\s+$/, "");
    if (text.trim().length === 0) continue;
    out.push({ line: i + 1, text });
  }
  return out;
}

/** Offsets at which each line of `source` starts (index 0 = line 1). */
function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** The 1-based line number containing `offset`, by binary search. */
function lineNumberAt(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The complement of `extractCommentText`: the source with every comment span
 * removed (markers included) — the revealed channel's comment-blind feed. Shares
 * the span scanner, so the two views partition the file identically. Blank-line
 * runs left behind by removed comments are collapsed to one so the stripped view
 * doesn't leak comment POSITIONS as blank-line negative space.
 */
export function stripCommentText(source: string, path: string): string {
  const spans = scanCommentSpans(source, path);
  if (spans.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(source.slice(cursor, span.outerStart));
    cursor = span.outerEnd;
  }
  parts.push(source.slice(cursor));
  return parts
    .join("")
    .split("\n")
    .filter((line, idx, all) => line.trim().length > 0 || (idx > 0 && all[idx - 1]!.trim().length > 0))
    .join("\n");
}

const GENERIC_STEMS = new Set([
  "index",
  "types",
  "type",
  "utils",
  "util",
  "helpers",
  "helper",
  "constants",
  "main",
  "mod",
]);

/**
 * Distinctive reference tokens for a file — the strings a comment would plausibly
 * use to name it. Path-like tokens (≥ 2 segments) are always distinctive; a bare
 * basename qualifies only when it is long enough and not a generic stem, so
 * `index`/`types` never spuriously couple files.
 */
function referenceTokens(posixPath: string): string[] {
  const tokens = new Set<string>();
  const noExt = posixPath.replace(/\.[^./]+$/, "");
  tokens.add(posixPath);
  tokens.add(noExt);
  const segs = posixPath.split("/");
  if (segs.length >= 2) {
    tokens.add(segs.slice(-2).join("/"));
    const lastTwoNoExt = segs.slice(-2).join("/").replace(/\.[^./]+$/, "");
    tokens.add(lastTwoNoExt);
  }
  const base = segs[segs.length - 1] ?? posixPath;
  const stem = base.replace(/\.[^./]+$/, "");
  if (stem.length >= 5 && !GENERIC_STEMS.has(stem.toLowerCase())) {
    tokens.add(base); // basename WITH extension only, to stay distinctive
  }
  // Keep only tokens with a path separator or a kept distinctive basename.
  return [...tokens].filter((t) => t.includes("/") || t === base);
}

export interface CommentDecompositionResult {
  /** Intent-declared coupling edges from comment cross-references (undirected). */
  edges: CouplingEdge[];
  /** Number of files whose source was read + scanned. */
  scannedFiles: number;
}

export interface CommentDecompositionParams {
  root: string;
  /** In-scope repo-relative file paths. */
  files: string[];
  /**
   * Injectable file reader (absolute path → text | undefined). Defaults to a
   * size-capped node:fs read; tests supply a map-backed reader.
   */
  readFileText?: (absPath: string) => Promise<string | undefined>;
  /** Skip files larger than this many bytes when reading (default 512 KiB). */
  maxBytes?: number;
}

/**
 * Derive intent-declared coupling edges from comment cross-references across the
 * in-scope files. For each file, its comment text is scanned for the distinctive
 * reference tokens of OTHER files; a match adds an undirected edge. Deterministic:
 * files are processed in sorted order and edges are canonicalized + sorted.
 */
export async function deriveCommentDecomposition(
  params: CommentDecompositionParams,
): Promise<CommentDecompositionResult> {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  const read =
    params.readFileText ?? ((abs: string) => defaultReadFileText(abs, maxBytes));

  const files = [...new Set(params.files.map(toPosixPath))].sort((a, b) =>
    compareCodeUnits(a, b),
  );

  // token → owning file (longest/most-specific token wins on collision is
  // unnecessary; a token maps to exactly one file by construction of paths).
  const tokenOwner = new Map<string, string>();
  for (const file of files) {
    for (const token of referenceTokens(file)) {
      // A token shared by two files (possible for a bare basename) is ambiguous —
      // drop it rather than couple arbitrarily.
      if (tokenOwner.has(token)) tokenOwner.set(token, "\0ambiguous");
      else tokenOwner.set(token, file);
    }
  }
  for (const [token, owner] of [...tokenOwner]) {
    if (owner === "\0ambiguous") tokenOwner.delete(token);
  }
  // Sort tokens longest-first so a specific path matches before a substring.
  const tokens = [...tokenOwner.keys()].sort(
    (a, b) => b.length - a.length || compareCodeUnits(a, b),
  );

  const weightByPair = new Map<string, number>();
  let scannedFiles = 0;
  for (const file of files) {
    const text = await read(join(params.root, file));
    if (text === undefined) continue;
    scannedFiles += 1;
    const comments = extractCommentText(text, file);
    if (comments.length === 0) continue;
    const posixComments = toPosixPath(comments);
    const referenced = new Set<string>();
    for (const token of tokens) {
      const owner = tokenOwner.get(token)!;
      if (owner === file || referenced.has(owner)) continue;
      if (posixComments.includes(token)) referenced.add(owner);
    }
    for (const other of referenced) {
      const a = compareCodeUnits(file, other) <= 0 ? file : other;
      const b = compareCodeUnits(file, other) <= 0 ? other : file;
      const key = `${a} ${b}`;
      weightByPair.set(key, (weightByPair.get(key) ?? 0) + 1);
    }
  }

  const edges: CouplingEdge[] = [];
  for (const [key, weight] of weightByPair) {
    const idx = key.indexOf(" ");
    edges.push({ a: key.slice(0, idx), b: key.slice(idx + 1), weight });
  }
  edges.sort((x, y) => compareCodeUnits(x.a, y.a) || compareCodeUnits(x.b, y.b));
  return { edges, scannedFiles };
}

export interface DocGroupsParams {
  root: string;
  /** Doc files (prose) to mine — README / ADRs / other markdown. */
  docFiles: string[];
  /** In-scope code files a doc may name (the grouping universe). */
  codeFiles: string[];
  readFileText?: (absPath: string) => Promise<string | undefined>;
  maxBytes?: number;
}

/**
 * Derive intent-declared groups from docs: each doc's ENTIRE text (docs are
 * prose, not comment-embedded) is scanned for the reference tokens of in-scope
 * code files; every code file a single doc names becomes one group (the doc
 * declares a module). Returns disjoint member groups of size ≥ 2 (a doc naming
 * one file declares no grouping), lexically sorted. Deterministic.
 */
export async function deriveDocGroups(
  params: DocGroupsParams,
): Promise<string[][]> {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  const read =
    params.readFileText ?? ((abs: string) => defaultReadFileText(abs, maxBytes));
  const codeFiles = [...new Set(params.codeFiles.map(toPosixPath))].sort((a, b) =>
    compareCodeUnits(a, b),
  );
  const docFiles = [...new Set(params.docFiles.map(toPosixPath))].sort((a, b) =>
    compareCodeUnits(a, b),
  );

  const tokenOwner = new Map<string, string>();
  for (const file of codeFiles) {
    for (const token of referenceTokens(file)) {
      if (tokenOwner.has(token)) tokenOwner.set(token, "\0ambiguous");
      else tokenOwner.set(token, file);
    }
  }
  for (const [token, owner] of [...tokenOwner]) {
    if (owner === "\0ambiguous") tokenOwner.delete(token);
  }
  const tokens = [...tokenOwner.keys()].sort(
    (a, b) => b.length - a.length || compareCodeUnits(a, b),
  );

  const groups: string[][] = [];
  for (const doc of docFiles) {
    const text = await read(join(params.root, doc));
    if (text === undefined) continue;
    const posixText = toPosixPath(text);
    const named = new Set<string>();
    for (const token of tokens) {
      const owner = tokenOwner.get(token)!;
      if (named.has(owner)) continue;
      if (posixText.includes(token)) named.add(owner);
    }
    if (named.size >= 2) {
      groups.push([...named].sort((a, b) => compareCodeUnits(a, b)));
    }
  }
  groups.sort((a, b) => compareCodeUnits(a[0] ?? "", b[0] ?? ""));
  return groups;
}
