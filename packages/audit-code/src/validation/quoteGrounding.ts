/**
 * Quote-and-verify grounding for audit findings (S7 anti-hallucination).
 *
 * The original audit design tried to stop hallucinated findings by forcing the
 * auditor to prove it read the file (`file_coverage[].total_lines == actual`).
 * That attests *breadth of reading*, is gameable (read the count from a listing,
 * never open the body), and proves nothing about whether a finding is *true*.
 *
 * This module attaches the safeguard to the *claim* instead: every finding cites
 * a verbatim span (`affected_files[].quoted_text`), and the tool re-reads that
 * span from disk and content-matches it. The confirmed bit is the tool's
 * re-check, never the model's word. A finding whose quote does not re-verify
 * (or that carries no quote at all) is marked `ungrounded` — surfaced, never
 * silently admitted as a confirmed finding.
 *
 * Matching is on *content*, normalized for whitespace/CRLF, not on line numbers
 * — so later edits that shift line numbers do not false-fail a still-valid
 * quote, while a quote that names code that does not exist cannot match.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Finding, FindingGrounding } from "@audit-tools/shared";

/** Normalize text for content-matching: drop CR, collapse whitespace, trim. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

/**
 * True when the (normalized) quoted span appears anywhere in the (normalized)
 * file content. An empty quote never matches (an empty quote grounds nothing).
 */
export function quoteMatches(fileContent: string, quotedText: string): boolean {
  const needle = normalizeForMatch(quotedText);
  if (needle.length === 0) return false;
  return normalizeForMatch(fileContent).includes(needle);
}

/** Reads a source file's text; injectable so the verifier is testable without fs. */
export type SourceReader = (absolutePath: string) => Promise<string>;

const defaultSourceReader: SourceReader = (absolutePath) =>
  readFile(absolutePath, "utf8");

/**
 * Re-verify a finding's cited verbatim span(s) against disk. A finding is
 * `grounded` as soon as ONE of its `affected_files[].quoted_text` spans matches
 * its cited file; it is `ungrounded` when it carries no quote at all, or when no
 * cited quote can be found on disk (with a reason naming the failed spans).
 */
export async function verifyFindingGrounding(
  repoRoot: string,
  finding: Finding,
  readSource: SourceReader = defaultSourceReader,
): Promise<FindingGrounding> {
  const quoted = (finding.affected_files ?? []).filter(
    (loc): loc is typeof loc & { quoted_text: string } =>
      typeof loc.quoted_text === "string" && loc.quoted_text.trim().length > 0,
  );

  if (quoted.length === 0) {
    return {
      status: "ungrounded",
      reason:
        "no affected_files entry carries a verbatim quoted_text span to re-verify",
    };
  }

  const misses: string[] = [];
  for (const loc of quoted) {
    const absolutePath = isAbsolute(loc.path) ? loc.path : join(repoRoot, loc.path);
    let content: string;
    try {
      content = await readSource(absolutePath);
    } catch {
      misses.push(`${loc.path}: file could not be read on disk`);
      continue;
    }
    if (quoteMatches(content, loc.quoted_text)) {
      return { status: "grounded" };
    }
    misses.push(`${loc.path}: quoted_text not found on disk`);
  }

  return { status: "ungrounded", reason: misses.join("; ") };
}
