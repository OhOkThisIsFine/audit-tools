/**
 * Finding grounding primitives — single source for both orchestrators.
 *
 * Quote-and-verify grounding (S7 anti-hallucination): a finding cites a verbatim
 * span (`affected_files[].quoted_text`); the tool re-reads that span from disk
 * and content-matches it. The confirmed bit is the tool's re-check, never the
 * model's word. A finding whose quote does not re-verify — or that carries no
 * quote at all — is `ungrounded`: surfaced, never silently admitted as a
 * confirmed finding.
 *
 * Matching is on *content*, normalized for whitespace/CRLF, not on line numbers
 * — later edits that shift line numbers do not false-fail a still-valid quote,
 * while a quote naming code that does not exist cannot match.
 *
 * Before this module the auditor (`quoteGrounding.ts`) and the conceptual-review
 * grounding (`designFindingGrounding.ts`) each carried their own copy of
 * `normalizeForMatch` / `quoteMatches` / `verifyFindingGrounding` and a near-
 * identical path normalizer; this is the one authority both consume (drift-plan
 * E3 + P7).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Finding, FindingGrounding } from "../types/finding.js";

/** Normalize text for content-matching: drop CR, collapse whitespace, trim. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Repo-relative, separator- and case-normalized path for matching against a
 * known-paths set: trim, backslash→slash, strip a leading `./`, lowercase.
 *
 * The single path normalizer (drift-plan P7) shared by the conceptual-review
 * grounding and any other consumer that matches a cited `affected_files` path
 * against a repo manifest. (Quote-and-verify resolves a cited path against the
 * filesystem instead, so it does not lowercase — see `verifyFindingGrounding`.)
 */
export function normalizeRepoPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
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

/**
 * INV-GND-02 (total function): classify a finding's grounding as a verdict that
 * is ALWAYS defined. A finding whose `grounding` is undefined/absent is treated
 * as **ungrounded** — it was never re-verified, so it must be verified before a
 * fix is applied, never silently trusted. This is the single authority the
 * remediator consults on the structured-audit path so a missing verdict can
 * never be mistaken for a passing one.
 */
export function findingIsGrounded(finding: Pick<Finding, "grounding">): boolean {
  return finding.grounding?.status === "grounded";
}

/**
 * True when a finding must be verified-before-fix because it was NOT positively
 * grounded: `ungrounded` (quote didn't re-verify), `refuted` (anchor disproved —
 * normally already quarantined-excluded upstream), or no verdict at all
 * (undefined → treated as ungrounded, INV-GND-02). The remediator uses this to
 * flag such findings for a verify-first pass rather than blindly applying the fix.
 */
export function findingNeedsVerificationBeforeFix(
  finding: Pick<Finding, "grounding">,
): boolean {
  return !findingIsGrounded(finding);
}
