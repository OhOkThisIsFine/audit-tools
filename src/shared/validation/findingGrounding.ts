// sites-pinned: tests/audit/quote-grounding.test.ts, tests/shared/finding-grounding.test.ts, tests/audit/host-ingest-grounding.test.ts
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
 * while a quote naming code that does not exist cannot match. The line numbers
 * a finding carries are DERIVED from where its quote occurs (`groundFinding`),
 * never taken from the reviewer.
 *
 * Before this module the auditor (`quoteGrounding.ts`) and the conceptual-review
 * grounding (`designFindingGrounding.ts`) each carried their own copy of
 * `normalizeForMatch` / `quoteMatches` / the quote verifier and a near-
 * identical path normalizer; this is the one authority both consume (drift-plan
 * E3 + P7).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "../tooling/exec.js";
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
 * filesystem instead, so it does not lowercase — see `groundFinding`.)
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
 * <!-- comment-citation-exempt: illustrative example path -->
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
 * `git ls-files -z` (forward-slashed). Consumers that resolve a basename and
 * then read the file off disk (line counting) need the REAL on-disk case,
 * so this enumeration does not lowercase.
 *
 * `-z` is load-bearing, not a flourish: plain `ls-files` renders any path git
 * considers unusual in C-quoted form (`core.quotePath` turns a non-ASCII byte
 * into `\303`, and a path containing a newline is quoted too), so a newline
 * split yielded an entry that no longer equals the real repo path — every
 * citation naming that file silently failed to ground while the file-disposition
 * rule, which already used `-z`, kept it in scope. NUL-delimited output is
 * unquoted and unambiguous, so entries are taken verbatim (no trim: with no line
 * terminator to strip, trimming could only damage a legitimately space-padded
 * POSIX path).
 *
 * Degrades to an empty set when git is missing / not a repo (callers then fall
 * back to their existing `existsSync` check — monotonic, never a regression).
 * OS-agnostic: forward-slash output.
 *
 * ASYNC (INV-SSF): every production caller runs under the remediation phase
 * lock, and a synchronous child starves the held lock's mtime heartbeat. The
 * async twin keeps the loop turning; the shared deadline bounds a git that
 * never answers.
 */
export async function enumerateTrackedFilePaths(
  root: string,
): Promise<Set<string>> {
  const known = new Set<string>();
  // `--recurse-submodules` is REQUIRED, and it is one half of an ATOMIC pair:
  // the other half is the same flag on the audit disposition's
  // `evaluateTrackedFiles`, which decides what enters the auditable SCOPE. Both
  // sides read "tracked" using the same recursive git enumeration, so the two
  // rules must agree — a parent-only listing returns just the gitlink for a
  // first-party submodule, and a citation naming a file inside one would then
  // fail to ground while it sat in scope, or vice versa. Never change one
  // without the other; `tests/audit/submodule-tracked-corpus.test.ts` builds a
  // real submodule and pins BOTH halves (each reverts red on its own).
  const result = await runTrackedAsync(
    ["git", "ls-files", "-z", "--recurse-submodules"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: TRACKED_CHILD_DEADLINE_MS,
    },
  );
  if (result.error || result.status !== 0) return known;
  for (const entry of result.stdout.split("\0")) {
    const path = entry.replace(/\\/g, "/");
    if (path.length > 0) known.add(path);
  }
  return known;
}

/** One place a quote occurs: TRUE 1-based lines of the raw file, inclusive. */
interface QuoteSpan {
  readonly line_start: number;
  readonly line_end: number;
}

/**
 * Every place the (normalized) quote occurs in the (normalized) file content,
 * each mapped back to the raw file's lines. Overlapping occurrences count: the
 * question is how many LOCATIONS the quote could name, and `aa` names two places
 * in `aaa`. An empty quote occurs nowhere (an empty quote grounds nothing).
 *
 * The normalized text is built here character by character, recording the raw
 * line of each kept character, and it is the same text {@link normalizeForMatch}
 * returns: CR dropped first (so `a\rb` joins to `ab`, exactly as the regex
 * pass does), each whitespace run collapsed to one space, the ends trimmed. A
 * collapsed run takes the line of its first character; an occurrence never
 * starts or ends on a space, because the trimmed needle cannot.
 */
function locateQuote(fileContent: string, quotedText: string): QuoteSpan[] {
  const needle = normalizeForMatch(quotedText);
  if (needle.length === 0) return [];
  let text = "";
  const lineOf: number[] = [];
  let line = 1;
  let pendingSpaceLine: number | undefined;
  for (const char of fileContent) {
    if (char === "\r") continue;
    if (/\s/u.test(char)) {
      if (pendingSpaceLine === undefined && text.length > 0) pendingSpaceLine = line;
    } else {
      if (pendingSpaceLine !== undefined) {
        text += " ";
        lineOf.push(pendingSpaceLine);
        pendingSpaceLine = undefined;
      }
      text += char;
      for (let unit = 0; unit < char.length; unit += 1) lineOf.push(line);
    }
    if (char === "\n") line += 1;
  }
  const spans: QuoteSpan[] = [];
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  ) {
    spans.push({ line_start: lineOf[at]!, line_end: lineOf[at + needle.length - 1]! });
  }
  return spans;
}

/**
 * True when the (normalized) quoted span appears anywhere in the (normalized)
 * file content. An empty quote never matches (an empty quote grounds nothing).
 */
export function quoteMatches(fileContent: string, quotedText: string): boolean {
  return locateQuote(fileContent, quotedText).length > 0;
}

/** Reads a source file's text; injectable so the verifier is testable without fs. */
export type SourceReader = (absolutePath: string) => Promise<string>;

const defaultSourceReader: SourceReader = (absolutePath) =>
  readFile(absolutePath, "utf8");

/**
 * A {@link SourceReader} memoized by absolute path, for ONE grounding pass: a
 * batch whose findings all cite the same file reads that file once rather than
 * once per finding. The promise is cached — including a rejecting one — so an
 * unreadable path is not retried per citation either.
 *
 * Scope it to a single pass and discard it: a reader that outlived the pass
 * would serve stale bytes after a later edit, which is exactly what quote-and-
 * verify exists to catch.
 */
export function createMemoizedSourceReader(): SourceReader {
  const cache = new Map<string, Promise<string>>();
  return (absolutePath) => {
    const cached = cache.get(absolutePath);
    if (cached !== undefined) return cached;
    const pending = defaultSourceReader(absolutePath);
    cache.set(absolutePath, pending);
    return pending;
  };
}

/**
 * Ground a finding against disk: re-read each cited verbatim span, and let the
 * code it quotes — never a number the reviewer typed — say where it is.
 *
 * Line numbers are TOOL-OWNED. Every `affected_files` entry loses whatever
 * `line_start`/`line_end` it arrived with; an entry whose quote occurs exactly
 * once in its file gets that occurrence's lines written back. A quote that
 * occurs nowhere names nothing, and one that occurs more than once names no
 * single place, so neither carries lines. A typed number used to pass every
 * check while pointing anywhere in the file; a span derived from content the
 * tool has just found cannot.
 *
 * The finding is `grounded` as soon as ONE entry's quote occurs exactly once;
 * otherwise `ungrounded`, with a reason naming each entry that failed and why.
 * The verdict is written to `finding.grounding` and also returned. It never
 * refuses: an unlocatable quote is surfaced as unconfirmed, not discarded with
 * its sibling findings.
 */
export async function groundFinding(
  repoRoot: string,
  finding: Finding,
  readSource: SourceReader = defaultSourceReader,
): Promise<FindingGrounding> {
  const entries = Array.isArray(finding.affected_files) ? finding.affected_files : [];
  const misses: string[] = [];
  let quotedCount = 0;
  let located = false;
  for (const loc of entries) {
    if (typeof loc !== "object" || loc === null) continue;
    delete loc.line_start;
    delete loc.line_end;
    if (
      typeof loc.path !== "string" ||
      typeof loc.quoted_text !== "string" ||
      loc.quoted_text.trim().length === 0
    ) {
      continue;
    }
    quotedCount += 1;
    const absolutePath = isAbsolute(loc.path) ? loc.path : join(repoRoot, loc.path);
    let content: string;
    try {
      content = await readSource(absolutePath);
    } catch {
      misses.push(`${loc.path}: file could not be read on disk`);
      continue;
    }
    const spans = locateQuote(content, loc.quoted_text);
    if (spans.length === 1) {
      loc.line_start = spans[0]!.line_start;
      loc.line_end = spans[0]!.line_end;
      located = true;
    } else if (spans.length === 0) {
      misses.push(`${loc.path}: quoted_text not found on disk`);
    } else {
      misses.push(
        `${loc.path}: quoted_text occurs ${spans.length} times, so it names no single ` +
          "location; quote a span that occurs once",
      );
    }
  }

  const grounding: FindingGrounding =
    quotedCount === 0
      ? {
          status: "ungrounded",
          reason:
            "no affected_files entry carries a verbatim quoted_text span to re-verify",
        }
      : located
        ? { status: "grounded" }
        : { status: "ungrounded", reason: misses.join("; ") };
  finding.grounding = grounding;
  return grounding;
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
