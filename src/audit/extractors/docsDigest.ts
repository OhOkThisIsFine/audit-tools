// Docs-digest extractor (change 3, scope-confirmation context). Deterministic
// and bounded: the doc universe comes from the pipeline's single doc predicate
// (`isDocIntentFile` — never a second "what is a doc" rule), selection is
// depth-then-path ordered so root READMEs lead, and every emitted array is
// content-derived stable order (path-sort), never readdir/iteration order.
//
// Degrades to an empty digest without a root (mirrors the comment/doc intent
// extractors); an unreadable or oversized doc is skipped, not thrown on.

import { join } from "node:path";
import type { FileDisposition } from "audit-tools/shared";
import { isDocIntentFile } from "../decompose/buildStructureDecomposition.js";
import type { DocsDigest, DocsDigestEntry } from "../types/docsDigest.js";
import { DEFAULT_MAX_BYTES, defaultReadFileText } from "./readFileText.js";

/** Selection cap: how many docs the digest carries (budget-context rule). */
const DEFAULT_MAX_DOCS = 12;
/** Per-doc excerpt cap in characters. */
const DEFAULT_MAX_EXCERPT_CHARS = 1_000;

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

/**
 * First markdown ATX heading text, or undefined when the doc has none.
 * Fence-aware: a `# line` inside a ``` / ~~~ code fence is code, not a title
 * (review finding: a fenced example before the real title won the match).
 */
function firstAtxHeading(text: string): string | undefined {
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Leading excerpt: newline-normalized, blank-run-collapsed, capped at
 * `maxChars` on a line boundary (a mid-word cut reads as corruption to the
 * scope decider; a dropped tail line does not).
 */
function leadingExcerpt(text: string, maxChars: number): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const cut = normalized.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

export interface BuildDocsDigestParams {
  /** Repo root (absolute); when absent, extraction degrades to an empty digest. */
  root?: string;
  disposition: FileDisposition;
  /** Injectable file reader (tests supply a map-backed reader). */
  readFileText?: (absPath: string) => Promise<string | undefined>;
  maxDocs?: number;
  maxExcerptChars?: number;
}

export async function buildDocsDigest(
  params: BuildDocsDigestParams,
): Promise<DocsDigest> {
  const maxDocs = params.maxDocs ?? DEFAULT_MAX_DOCS;
  const maxExcerptChars = params.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const read =
    params.readFileText ??
    ((abs: string) => defaultReadFileText(abs, DEFAULT_MAX_BYTES));

  const docPaths = [
    ...new Set(
      params.disposition.files
        .filter((file) => isDocIntentFile(file.path, file.status))
        .map((file) => toPosix(file.path)),
    ),
  ].sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));

  const generated_at = new Date().toISOString();
  if (!params.root || docPaths.length === 0) {
    return { generated_at, docs: [] };
  }

  const docs: DocsDigestEntry[] = [];
  const omitted: string[] = [];
  for (const path of docPaths) {
    if (docs.length >= maxDocs) {
      omitted.push(path);
      continue;
    }
    const raw = await read(join(params.root, path));
    if (raw === undefined) continue;
    // Strip a UTF-8 BOM once so a BOM-prefixed first-line heading still
    // matches (review finding: U+FEFF displaced the `#` at position 0).
    // charCodeAt spelling keeps the check visible — a U+FEFF regex literal is
    // an invisible character in source.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    docs.push({
      path,
      title: firstAtxHeading(text) ?? (path.split("/").at(-1) ?? path),
      excerpt: leadingExcerpt(text, maxExcerptChars),
    });
  }

  return {
    generated_at,
    docs,
    ...(omitted.length > 0 ? { omitted_paths: omitted.sort((a, b) => a.localeCompare(b)) } : {}),
  };
}
