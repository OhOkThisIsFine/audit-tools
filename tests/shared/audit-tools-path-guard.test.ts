/**
 * `.audit-tools` path-literal guard (V5). `src/shared/io/auditToolsPaths.ts` is
 * the single source of truth for the on-disk `.audit-tools/` layout — every
 * runtime path join must route through its helpers/constants, never re-spell the
 * literal. This guard scans all source under `src/` + `wrapper/` for the literal
 * `.audit-tools` used in a path-construction context and fails loud on any
 * occurrence outside a documented allowlist, so a new hand-constructed join can't
 * silently reintroduce the drift the V5 sweep removed.
 *
 * Two V5-RESIDUAL BLIND SPOTS were closed here (both were declared, neither was
 * covered — see the tests at the bottom of this file, which pin the closure):
 *
 *  1. **Template-literal construction.** The scanner only saw `"`/`'`-quoted
 *     joins, so `` join(root, `.audit-tools/audit`) `` was invisible. The scan
 *     now takes a backtick literal too, and distinguishes it from the prompt
 *     PROSE that caused backticks to be excluded originally by stripping
 *     ESCAPED backticks first: a host-prompt body embeds its markdown code spans
 *     inside a template literal, so they arrive as `` \` `` (text), while a real
 *     construction's opening backtick is unescaped. DECLARED RESIDUAL: an
 *     unescaped backtick code span in prompt prose on a non-comment line still
 *     reads as a construction (false positive, no live occurrence — every
 *     in-template code span in src/ + wrapper/ is escaped). The remedy is the
 *     existing one: escape it, comment the line, or allowlist the file.
 *  2. **A substring-only allowlist honesty check.** The check that a stale
 *     allowlist entry gets removed asserted `text.includes(".audit-tools")`,
 *     which a bare COMMENT or prose mention satisfies — so an entry could keep
 *     its slot after its last real literal was cleaned up. It now requires the
 *     entry to still carry a path-construction literal ({@link pathLiteralIn}),
 *     the same shape the main scan flags.
 *
 * Deliberately excluded (and each exclusion is a claim about the text, not a
 * convenience):
 *   - comment lines (trimmed line starts with `//`, `*`, or `/*`) — doc prose;
 *   - mid-string prose mentions (not immediately after a quote);
 *   - `.audit-tools-visibility` (the committed repo-root pin FILE, a distinct
 *     literal owned by gitignoreArtifacts.ts — the lookahead requires a
 *     quote/backtick/`/`/`\` right after `.audit-tools`, so the `-visibility`
 *     suffix never matches).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

/**
 * Files allowed to carry the literal, each with the reason it is NOT a
 * hand-constructed artifact-tree path. Repo-relative, forward-slash keys.
 * If an entry's file drops its last literal occurrence, the honesty check below
 * fails so the stale entry gets removed instead of quietly widening the gate.
 */
const ALLOWLIST = new Map<string, string>([
  [
    "src/shared/io/auditToolsPaths.ts",
    "the single-source module itself — the one place the literal may live",
  ],
  [
    "src/shared/io/gitignoreArtifacts.ts",
    ".gitignore PATTERN content (glob text written into ignore files) plus the " +
      ".audit-tools-visibility pin filename — gitignore semantics, not fs joins",
  ],
  [
    "src/shared/tooling/analyzerDeps.ts",
    "~/.audit-tools/analyzer-cache — the HOME-dir analyzer cache root, a " +
      "different tree than the per-repo artifact root this guard protects",
  ],
  [
    "src/shared/analyzerPolicy.ts",
    "canonical analyzer-policy artifact and lock relative-path definitions",
  ],
  [
    "src/shared/sessionConfig.ts",
    "canonical repository session-intent relative-path definition",
  ],
  [
    "src/audit/extractors/fsIntake.ts",
    "intake exclusion dirname list — matches/skips directory NAMES during repo " +
      "walk, does not construct artifact paths",
  ],
  [
    "src/audit/extractors/pathPatterns.ts",
    "hasSegment() dirname matcher for classifying audited-repo paths, not a join",
  ],
  [
    "src/remediate/phases/plan.ts",
    "skip-dir name list for input discovery over the audited repo, not a join",
  ],
  [
    "src/audit/cli/args.ts",
    "commander default SENTINEL '.audit-tools/audit' — equality-compared then " +
      "routed through the shared helper (see resolver comment there), not joined",
  ],
  [
    "src/remediate/index.ts",
    "commander default SENTINEL '.audit-tools/remediation' — equality-compared " +
      "then routed through the shared helper, not joined",
  ],
  [
    "wrapper/audit-code-wrapper-lib.mjs",
    "pre-dist bootstrap: wrappers run before dist/ exists, cannot import the " +
      "compiled shared path module",
  ],
  [
    "wrapper/repo-root.mjs",
    "pre-dist bootstrap: the pinned wrapper-side MIRROR of " +
      "src/shared/io/repoRoot.ts's root discovery — the installer verbs answer " +
      "before any build, so the dirname literal cannot be imported. Divergence " +
      "from the shared copy is caught by " +
      "tests/shared/wrapper-repo-root-parity.test.ts, not by this allowlist",
  ],
  [
    "wrapper/audit-code-wrapper-opencode.mjs",
    "pre-dist bootstrap + opencode permission GLOB patterns ('.audit-tools/**')",
  ],
  [
    "wrapper/remediate-code-wrapper-opencode.mjs",
    "pre-dist bootstrap + opencode permission GLOB patterns ('.audit-tools/**')",
  ],
]);

const SCAN_DIRS: string[] = ["src", "wrapper"];
const CODE_FILE_RE = /\.(?:[cm]?[jt]s)$/;
const SKIP_DIR_NAMES = new Set<string>(["node_modules", "dist"]);

/**
 * A string literal beginning with `.audit-tools` followed by a path separator or
 * a quote end — the path-construction shape. Covers all three quote characters
 * (blind spot 1): a backtick literal qualifies only when a separator or the
 * closing backtick follows, which is what separates `` `.audit-tools/audit` ``
 * (a construction) from `` `.audit-tools/` tree `` (prompt prose).
 *
 * `-visibility` stays excluded by the lookahead, as before.
 */
const VIOLATION_RE = /(?<!\\)["'`]\.audit-tools(?=["'`/\\])/;

/**
 * Whether a file's text contains a `.audit-tools` PATH-CONSTRUCTION literal —
 * the honesty check's real requirement (blind spot 2). A comment or prose
 * mention does NOT satisfy it, so a stale allowlist entry is removed rather
 * than left holding a slot with nothing behind it.
 */
function pathLiteralIn(text: string): boolean {
  return text.split(/\r?\n/).some(
    (line) => !isCommentLine(line) && VIOLATION_RE.test(stripEscapedBackticks(line)),
  );
}

/**
 * A backtick preceded by `\` is an ESCAPED backtick inside a template literal —
 * text, not a delimiter. Stripping those pairs before scanning keeps a
 * host-prompt line such as `` … in \`.audit-tools/\`, which … `` (a markdown
 * code span written inside a template literal) from reading as a construction,
 * while an interpolation like `` `${root}/.audit-tools` `` keeps its closing
 * backtick and is still caught.
 */
function stripEscapedBackticks(line: string): string {
  return line.replace(/\\`/g, "");
}

/** A comment-only line (block-comment bodies start with `*` in this codebase). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

/** Recursively collect code files under `dir`, as repo-relative "/" paths. */
function listCodeFiles(dir: string, rel: string, out: string[]): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listCodeFiles(abs, r, out);
    else if (CODE_FILE_RE.test(ent.name)) out.push(r);
  }
  return out;
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const dirName of SCAN_DIRS) {
    listCodeFiles(join(repoRoot, dirName), dirName, files);
  }
  return files;
}

/** All violating `file:line` hits in one file (empty array = clean). */
function violationsIn(relPath: string): string[] {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  const hits: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(".audit-tools")) continue;
    if (isCommentLine(line)) continue;
    if (VIOLATION_RE.test(stripEscapedBackticks(line))) {
      hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

describe(".audit-tools path-literal guard — layout single-sourced in auditToolsPaths.ts", () => {
  const files = collectFiles();

  it("scans a plausible tree (sanity: sources found in src/ and wrapper/)", () => {
    expect(files.some((f) => f.startsWith("src/"))).toBe(true);
    expect(files.some((f) => f.startsWith("wrapper/"))).toBe(true);
  });

  it("no non-allowlisted source hand-constructs a `.audit-tools` path", () => {
    const violations = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      violations.push(...violationsIn(file));
    }
    expect(
      violations,
      "hand-constructed `.audit-tools` path literal(s) found — route them " +
        "through src/shared/io/auditToolsPaths.ts (helpers or " +
        "AUDIT_TOOLS_DIRNAME / *_FILENAME constants) or, if genuinely not " +
        "path construction, add a documented allowlist entry here:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });

  it.each([...ALLOWLIST.keys()])(
    "allowlist entry %s still exists and still carries a path-construction literal (honesty check)",
    (file) => {
      // A stale entry (file deleted, or its occurrences cleaned up) must be
      // removed rather than sit as a silent hole in the gate. The requirement
      // is a path-CONSTRUCTION literal, not merely the substring: a comment or
      // prose mention must not keep a slot alive (blind spot 2).
      expect(existsSync(join(repoRoot, file))).toBe(true);
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(
        pathLiteralIn(text),
        `${file} is allowlisted for a \`.audit-tools\` path literal but no longer carries one ` +
          `(a comment or prose mention does not count) — drop the allowlist entry.`,
      ).toBe(true);
    },
  );
});

// ── Blind-spot closure (V5 residuals) ────────────────────────────────────────
//
// These pin the SCANNER itself, not the tree: the two residuals were declared
// blind spots, so a regression that re-opens either must fail here even if the
// tree happens to be clean at the time.

describe(".audit-tools path-literal guard — the two V5 residual blind spots are closed", () => {
  it("sees a TEMPLATE-LITERAL path construction (blind spot 1)", () => {
    expect(VIOLATION_RE.test("const p = join(root, `.audit-tools/audit`, x);")).toBe(true);
    expect(VIOLATION_RE.test("const p = `.audit-tools`;")).toBe(true);
    expect(pathLiteralIn("const p = join(root, `.audit-tools/audit`);")).toBe(true);
    expect(pathLiteralIn("const p = `.audit-tools/audit/`;")).toBe(true);
  });

  it("ignores ESCAPED-backtick prose — how host prompts quote paths inside a template literal", () => {
    // A host-prompt body embeds markdown code spans inside template literals, so
    // they arrive as ESCAPED backticks: text, not delimiters. This is the real
    // shape in the tree (src/remediate/steps/nextStep.ts prompt bodies).
    const escaped = "in \\`.audit-tools/\\`, which would otherwise be overwritten";
    expect(VIOLATION_RE.test(stripEscapedBackticks(escaped))).toBe(false);
    expect(pathLiteralIn(escaped)).toBe(false);
    const escapedPath = "at \\`.audit-tools/remediation/intake\\` (and the report).";
    expect(pathLiteralIn(escapedPath)).toBe(false);
  });

  it("is scoped to literals that BEGIN with `.audit-tools` — an interpolation is out of scope by design", () => {
    // `${root}/.audit-tools/...` does not START a literal with the segment, so it
    // is not the hand-constructed-join shape this guard exists to catch (the
    // root prefix means the caller is already composing from a root variable).
    // Pinned so the scope is a stated decision, not an accident of the regex.
    expect(VIOLATION_RE.test("const p = `${root}/.audit-tools/remediation`;")).toBe(false);
  });

  // DECLARED RESIDUAL (blind spot 1's uncovered half): an UNESCAPED backtick
  // code span in prompt prose on a non-comment line would be read as a
  // construction — a false positive. No live occurrence exists (grep: every
  // in-template code span in src/ + wrapper/ is escaped), and the remedy is the
  // existing one: escape it, comment the line, or allowlist the file with a
  // reason. Stated here rather than papered over, per the partly-enforced rule.
  it("the residual — an unescaped backtick code span IS flagged (remedy: escape it or allowlist)", () => {
    expect(
      VIOLATION_RE.test("see the `.audit-tools/` tree for details"),
      "unescaped backtick prose on a non-comment line reads as a construction — declared residual",
    ).toBe(true);
  });

  it("requires a real path literal for the allowlist honesty check (blind spot 2)", () => {
    // A comment or plain-prose mention must NOT satisfy it…
    expect(pathLiteralIn("// see .audit-tools docs")).toBe(false);
    expect(pathLiteralIn("the .audit-tools dir")).toBe(false);
    expect(pathLiteralIn("* `.audit-tools/` is documented here")).toBe(false);
    expect(pathLiteralIn("// `.audit-tools/` is documented here")).toBe(false);
    // …but any real construction must, in every quote form.
    expect(pathLiteralIn('const p = ".audit-tools/audit";')).toBe(true);
    expect(pathLiteralIn("const p = '.audit-tools/audit';")).toBe(true);
    expect(pathLiteralIn("const p = join(root, `.audit-tools/audit`);")).toBe(true);
  });

  it("the committed tree still passes with the widened scanner", () => {
    // Guards against 'tightening' the scanner into a false-positive machine:
    // whatever it now flags must still be genuinely allowlistable, so the main
    // scan over the real tree stays clean.
    for (const file of collectFiles()) {
      if (ALLOWLIST.has(file)) continue;
      expect(
        violationsIn(file),
        `${file} must not hand-construct a \`.audit-tools\` path (any quote form)`,
      ).toEqual([]);
    }
  });
});
