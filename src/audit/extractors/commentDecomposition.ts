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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CouplingEdge } from "./dataStateCoupling.js";

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

/**
 * Extract concatenated comment text from source, honoring the file's comment
 * syntax and skipping string literals (single/double/backtick, backslash-escaped)
 * so a comment marker inside a string is not misread. A single-pass char scanner:
 * normal → string → line-comment → block-comment. Degrades gracefully (an
 * unterminated block just consumes to EOF).
 */
export function extractCommentText(source: string, path: string): string {
  const syntax = syntaxFor(path);
  const out: string[] = [];
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
        const stop = end === -1 ? n : end;
        out.push(source.slice(i + open.length, stop));
        i = end === -1 ? n : end + close.length;
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
        out.push(source.slice(i + marker.length, stop));
        i = stop;
        matchedLine = true;
        break;
      }
    }
    if (matchedLine) continue;

    i += 1;
  }

  return out.join("\n");
}

/** Normalize a repo path to forward slashes for matching. */
function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
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

/**
 * Reference tokens for a file, exported so the docs intent source shares one
 * definition of "how a file is named" with the comment source.
 */
export function fileReferenceTokens(posixPath: string): string[] {
  return referenceTokens(posixPath);
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

const DEFAULT_MAX_BYTES = 512 * 1024;

async function defaultReadFileText(
  absPath: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const buf = await readFile(absPath);
    if (buf.byteLength > maxBytes) return undefined;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
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

  const files = [...new Set(params.files.map(toPosix))].sort((a, b) =>
    a.localeCompare(b),
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
    (a, b) => b.length - a.length || a.localeCompare(b),
  );

  const weightByPair = new Map<string, number>();
  let scannedFiles = 0;
  for (const file of files) {
    const text = await read(join(params.root, file));
    if (text === undefined) continue;
    scannedFiles += 1;
    const comments = extractCommentText(text, file);
    if (comments.length === 0) continue;
    const posixComments = toPosix(comments);
    const referenced = new Set<string>();
    for (const token of tokens) {
      const owner = tokenOwner.get(token)!;
      if (owner === file || referenced.has(owner)) continue;
      if (posixComments.includes(token)) referenced.add(owner);
    }
    for (const other of referenced) {
      const a = file.localeCompare(other) <= 0 ? file : other;
      const b = file.localeCompare(other) <= 0 ? other : file;
      const key = `${a} ${b}`;
      weightByPair.set(key, (weightByPair.get(key) ?? 0) + 1);
    }
  }

  const edges: CouplingEdge[] = [];
  for (const [key, weight] of weightByPair) {
    const idx = key.indexOf(" ");
    edges.push({ a: key.slice(0, idx), b: key.slice(idx + 1), weight });
  }
  edges.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
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
  const codeFiles = [...new Set(params.codeFiles.map(toPosix))].sort((a, b) =>
    a.localeCompare(b),
  );
  const docFiles = [...new Set(params.docFiles.map(toPosix))].sort((a, b) =>
    a.localeCompare(b),
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
    (a, b) => b.length - a.length || a.localeCompare(b),
  );

  const groups: string[][] = [];
  for (const doc of docFiles) {
    const text = await read(join(params.root, doc));
    if (text === undefined) continue;
    const posixText = toPosix(text);
    const named = new Set<string>();
    for (const token of tokens) {
      const owner = tokenOwner.get(token)!;
      if (named.has(owner)) continue;
      if (posixText.includes(token)) named.add(owner);
    }
    if (named.size >= 2) {
      groups.push([...named].sort((a, b) => a.localeCompare(b)));
    }
  }
  groups.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return groups;
}
