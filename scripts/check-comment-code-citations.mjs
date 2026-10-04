#!/usr/bin/env node
// sites-pinned: tests/shared/comment-code-citations-gate.test.ts
// Backticked citation gate for SOURCE COMMENTS — the comment twin of
// `check:doc-code-citations`.
//
// WHY THIS EXISTS. Docs were gated and comments were gated by nothing, so a
// comment could name a symbol or a file the code had renamed or deleted and
// every gate stayed green — the 2026-08-31 finding: `src/shared/continuityScore.ts`'s
// header claimed audit re-exported its scorer and biased packet ORDERING with it,
// long after that wiring was gone, and a doc comment named a "combined" pass that
// existed nowhere. Both were found by a lane reading code to check a DOC, weeks
// after the fact.
//
// WHAT IS CHECKED — a backticked token inside a `//` or `/* */` comment of a
// tracked source file under the scanned trees (`SCANNED_PREFIXES`), with comments
// found by the TypeScript scanner, never by a line-prefix guess: a `//` inside a
// string, a template literal or a regex is not a comment, and a trailing comment
// after code is one. TWO rules, one engine:
//
//   • PATH — the token is classified and resolved by the SAME engine the doc gate
//     uses (scripts/shared/code-citation-resolution.mjs), in its ROOTED forms
//     only (`isRooted`): a slashed path must name a tracked file, and a
//     multi-segment directory under a tracked top-level dir must name a tracked
//     directory.
//   • SYMBOL — a bare identifier in one of the two symbol spellings the engine
//     owns (`isSymbolShaped`: a compound CONSTANT or a lowerCamelCase name) must
//     be in the engine's declared-identifier universe, built from EVERY tracked
//     source file — not only the scanned trees — so a comment citing a hook
//     helper or a script resolves.
//
// WHAT IS NOT, declared rather than implied (the guard's registry row states the
// same halves):
//   • a comment stating a workflow SHAPE (which pass runs first, how many lanes
//     exist) or an ENUMERATION in prose names no single identifier, so no text
//     rule reaches it (`check:conceptual-category-comment-drift` covers one
//     enumeration class);
//   • a token the same file's CODE also spells is not looked up: a comment
//     naming what its own file declares, or a fixture path its own test writes,
//     is self-evidencing. The continuityScore case above is exactly that shape
//     (the name survived as a declaration while the header described deleted
//     WIRING), so this gate would not catch it;
//   • a bare filename and a bare one-segment directory (see `isRooted` for the
//     measurement that put them out of scope);
//   • a single capitalised word, a lowercase word, a call or member form
//     (`foo()`, `a.b`) — prose or syntax, never a bare citation; and the
//     camelCase host globals in `HOST_GLOBALS`;
//   • `..`-relative paths, `~`/drive/URL tokens, glob/template tokens, the
//     runtime state layout and gitignored paths — the engine's out-of-scope set;
//   • a line suffix is stripped and the PATH resolved; whether the anchored line
//     still says what the comment claims is not checked.
//
// EXEMPTION is explicit and inline, the doc gates' marker form:
//     <!-- comment-citation-exempt: <reason> -->
// inside a comment exempts its own line and every later line of the same
// contiguous comment block (adjacent lines, nothing but whitespace between) —
// one marker is enough for a block recording that several symbols were DELETED,
// a marker placed just above an illustrative example path leaves the rest of the
// comment above it checked, and the reach stops at the first code so it can
// never exempt an unrelated comment. Two classes need it: deliberate
// archaeology (a name the comment says is gone) and an illustrative example
// path that names no real file.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { guardArgv } from "./shared/argvGuard.mjs";
import { compareCodeUnits } from "./shared/primitives.mjs";

import {
  CODE_EXTENSIONS,
  HAS_EXTENSION,
  buildPathIndex,
  classifyPathToken,
  declaredIdentifierUniverse,
  ignoreCandidates,
  ignoredPaths,
  isSymbolShaped,
  stripLineSuffix,
  resolvePathRecord,
  trackedFiles,
} from "./shared/code-citation-resolution.mjs";

/** The trees whose comments carry prose about code. */
const SCANNED_PREFIXES = ["src/", "scripts/", ".claude/hooks/", "tests/", "wrapper/", "dispatch/"];

const COMMENT_CITATION_EXEMPT = /comment-citation-exempt:/;

/**
 * camelCase HOST GLOBALS — platform APIs a comment may name as prose. A closed,
 * stable list of the runtime's own surface, not of this repo's symbols; a name
 * in here is never a citation to something the tree is supposed to declare.
 */
const HOST_GLOBALS = new Set([
  "structuredClone",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
  "queueMicrotask",
  "requestAnimationFrame",
]);

function scriptKindFor(fileName) {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.ts$/.test(fileName)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Every comment range in `text`, in source order. The trivia between two tokens
 * holds every comment between them; TypeScript splits it into the TRAILING
 * ranges of the earlier token (same line) and the LEADING ranges of the later
 * one (after the first newline), so both, over every leaf token plus
 * end-of-file, deduplicated by position, are every comment exactly once. JSDoc
 * nodes are skipped as leaves: their positions lie INSIDE a comment.
 */
function commentRanges(text, fileName = "file.ts") {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKindFor(fileName));
  const seen = new Map();
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
      ]) {
        if (!seen.has(range.pos)) seen.set(range.pos, range);
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * The candidate citations among the backticked tokens in the comments of
 * `text`, with the exemption and the same-file self-evidence already applied.
 * Resolution is the caller's rule; this returns candidates of two kinds:
 * `symbol` (a bare identifier in a symbol spelling, not a host global) and
 * `path` (a slashed token of path characters, which the caller classifies).
 */
export function commentCitations(text, fileName = "file.ts") {
  const ranges = commentRanges(text, fileName);
  // Non-comment identifiers: the text with every comment blanked out.
  let code = "";
  let cursor = 0;
  for (const range of ranges) {
    code += text.slice(cursor, range.pos) + " ";
    cursor = range.end;
  }
  code += text.slice(cursor);
  const codeTokens = new Set(code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);

  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const hits = [];
  // The exemption reach: from the LINE carrying the marker to the end of its
  // contiguous comment block. `exemptLine` is that first exempt line, or
  // Infinity while no marker is open.
  let exemptLine = Infinity;
  let previousEnd = -1;
  for (const range of ranges) {
    const adjacent = previousEnd >= 0 && /^[ \t]*\r?\n?[ \t]*$/.test(text.slice(previousEnd, range.pos));
    if (!adjacent) exemptLine = Infinity;
    previousEnd = range.end;
    const body = text.slice(range.pos, range.end);
    const marker = COMMENT_CITATION_EXEMPT.exec(body);
    if (marker && exemptLine === Infinity) exemptLine = lineOf(range.pos + marker.index);
    for (const match of body.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim();
      const line = lineOf(range.pos + (match.index ?? 0));
      if (line >= exemptLine) continue;
      const isSymbol =
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) &&
        isSymbolShaped(token) &&
        !HOST_GLOBALS.has(token);
      if (isSymbol) {
        if (!codeTokens.has(token)) hits.push({ line, token, kind: "symbol" });
      } else if (token.includes("/") && /^[A-Za-z0-9._/-]+(?::[~\d][\d,~–-]*)?$/.test(token)) {
        // Only a SLASHED token made of path characters can be a rooted path
        // citation (`isRooted`); regex and shell syntax (`^(src|tests)/`,
        // `src/(a|b)/`) never is. The same
        // SELF-EVIDENCE rule as symbols: a path the file's own code spells (a
        // fixture file a test writes, a layout name it joins) is not a claim
        // about the tree, so it is not looked up.
        const bare = stripLineSuffix(token).replace(/^\.\//, "");
        if (!code.includes(bare)) hits.push({ line, token, kind: "path" });
      }
    }
  }
  return hits;
}

/**
 * Only the ROOTED path forms are a comment's claim about the tree: a slashed
 * file path, or a directory with at least two segments under a tracked
 * top-level dir (`src/shared/types/`). Measured on the tree when this gate was
 * written, the other two forms were overwhelmingly NOT citations: a bare
 * `runs/` or `incoming/` names the RUN layout a module builds at runtime, and a
 * bare filename named a foreign ecosystem's manifest (`Cargo.toml`), a runtime
 * artifact, a third-party file or an illustrative example far more often than
 * a sibling module that was renamed — a false red is as corrosive as a false
 * green, so those forms are out of scope rather than marker-fed.
 */
function isRooted(record, index) {
  if (record.kind === "path") return true;
  if (record.kind === "dir") {
    return record.path.slice(0, -1).includes("/") && index.topDirs.has(record.path.split("/", 1)[0]);
  }
  return false;
}

function main() {
  const args = guardArgv(process.argv.slice(2), {
    name: "check-comment-code-citations",
    usage: "node scripts/check-comment-code-citations.mjs [<repo-root>]",
    positionals: 1,
  });
  const root = resolve(args.positionals[0] ?? process.cwd());
  const { examined, universe } = trackedFiles(root);
  const index = buildPathIndex({ examined, universe });
  const declared = declaredIdentifierUniverse(root, universe);
  // WHICH FILES ARE READ reads `examined` (tracked + index), never the untracked
  // set: an untracked scratch file may be CITED, never add citations of its own.
  const scanned = examined.filter((path) => {
    if (!SCANNED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
    const ext = HAS_EXTENSION.exec(path);
    return ext !== null && CODE_EXTENSIONS.has(ext[1].toLowerCase());
  });

  const symbolFailures = [];
  const records = [];
  let symbolCount = 0;
  for (const relPath of scanned) {
    const text = readFileSync(join(root, relPath), "utf8");
    for (const hit of commentCitations(text, relPath)) {
      if (hit.kind === "symbol") {
        symbolCount += 1;
        if (!declared.has(hit.token)) {
          symbolFailures.push({ relPath, line: hit.line, token: hit.token, verdict: "names nothing the tree declares" });
        }
        continue;
      }
      const record = classifyPathToken(hit.token, relPath, index);
      if (record && isRooted(record, index)) {
        records.push({ ...record, relPath, line: hit.line, token: hit.token });
      }
    }
  }

  const ignored = ignoredPaths(root, ignoreCandidates(records));
  const pathFailures = [];
  let pathCount = 0;
  for (const record of records) {
    const result = resolvePathRecord(record, index, ignored);
    if (result === null) continue;
    pathCount += 1;
    if (!result.ok) pathFailures.push({ ...record, verdict: result.verdict });
  }

  const failures = [...pathFailures, ...symbolFailures].sort(
    (a, b) => compareCodeUnits(a.relPath, b.relPath) || a.line - b.line,
  );
  if (failures.length > 0) {
    console.error(
      `check-comment-code-citations: ${failures.length} of ${pathCount} path + ${symbolCount} symbol backticked comment citation(s) do not resolve:`,
    );
    for (const f of failures) {
      console.error(`  ${f.relPath}:${f.line}  \`${f.token}\` — ${f.verdict}`);
    }
    console.error(
      "\nThe code the comment describes moved, was renamed, or was deleted. Re-point the comment at " +
        "what the code does now, or drop the claim. For a comment deliberately recording a retired " +
        "name or an illustrative example path, put `<!-- comment-citation-exempt: <reason> -->` on the " +
        "line above it: it covers that line and the rest of its comment block.",
    );
    process.exit(1);
  }
  console.log(
    `check-comment-code-citations: ${pathCount} path + ${symbolCount} symbol citation(s) across ` +
      `${scanned.length} tracked source files — every one resolves.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
