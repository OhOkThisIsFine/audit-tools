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
import { spawnSync } from "node:child_process";
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
 *
 * INV-B3-1: strips a leading `./` ONLY — it must NEVER strip the leading dot of a
 * dotfile-directory segment (`.claude/…`, `.github/…`). The regex is anchored to
 * `./` (dot-SLASH); do not broaden it to `/^\.\/?/` or similar, or every
 * dotfile-dir citation silently un-grounds (it would no longer match its
 * `git ls-files` form by exact membership).
 */
export function normalizeRepoPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * True when `p` is a bare basename — a single path segment with no separator
 * (`advance.ts`), as opposed to a nested repo-relative path (`src/x/advance.ts`)
 * or a dotfile-dir path (`.claude/hooks/x.mjs`). A bare basename is the one shape
 * that cannot be resolved by a naive `root/<name>` join when the real file is
 * nested, so it is the shape {@link resolveBasenameToTrackedPath} rescues.
 */
export function isBareBasename(p: string): boolean {
  const t = p.trim();
  return t.length > 0 && !t.includes("/") && !t.includes("\\");
}

/**
 * INV-B3-2: resolve a bare basename (`advance.ts`) to its UNIQUE tracked full
 * path in the known-path corpus (`src/audit/orchestrator/advance.ts`). Returns
 * the single matching corpus entry when exactly one tracked path has that
 * basename; `undefined` when zero OR more-than-one path matches — an ambiguous
 * basename stays a checkable signal, never a silent false-pass.
 *
 * Corpus-agnostic and case-insensitive on the basename: it works whether the
 * caller's corpus is `normalizeRepoPath`-lowercased (the M-B3 gate) or
 * case-preserving (the fs-resolving remediate consumers), and returns the corpus
 * entry as-is so a case-preserving caller gets a real on-disk path back. Single
 * source (drift-plan convention) — the gate, both orchestrators, and
 * `groundDesignFinding` all resolve basenames through this one authority.
 */
export function resolveBasenameToTrackedPath(
  basename: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  const target = basename.trim().replace(/\\/g, "/");
  if (target.length === 0 || target.includes("/")) return undefined;
  const targetLower = target.toLowerCase();
  let match: string | undefined;
  for (const path of knownPaths) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base.toLowerCase() === targetLower) {
      if (match !== undefined) return undefined; // >1 match → ambiguous
      match = path;
    }
  }
  return match;
}

/**
 * Case-preserving corpus of the tracked working-tree paths at `root`, via
 * `git ls-files` (forward-slashed, trimmed). This is the sibling of the M-B3
 * gate's `enumerateRepoTreePaths` (which `normalizeRepoPath`-lowercases for
 * membership matching): the remediate consumers that resolve a basename and then
 * read the file off disk (line counting) need the REAL on-disk case, so this one
 * does not lowercase. Degrades to an empty set when git is missing / not a repo
 * (callers then fall back to their existing `existsSync` check — monotonic, never
 * a regression). OS-agnostic: `shell: false`, forward-slash output.
 */
export function enumerateTrackedFilePaths(root: string): Set<string> {
  const known = new Set<string>();
  let result;
  try {
    result = spawnSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return known;
  }
  if (!result || result.status !== 0 || typeof result.stdout !== "string") {
    return known;
  }
  for (const line of result.stdout.split("\n")) {
    const path = line.trim().replace(/\\/g, "/");
    if (path.length > 0) known.add(path);
  }
  return known;
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
