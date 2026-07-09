/**
 * `.audit-tools` path-literal guard (V5). `src/shared/io/auditToolsPaths.ts` is
 * the single source of truth for the on-disk `.audit-tools/` layout — every
 * runtime path join must route through its helpers/constants, never re-spell the
 * literal. This guard scans all source under `src/` + `wrapper/` for the literal
 * `.audit-tools` used in a path-construction context and fails loud on any
 * occurrence outside a documented allowlist, so a new hand-constructed join can't
 * silently reintroduce the drift the V5 sweep removed.
 *
 * Heuristic for "path-construction context": a single- or double-quoted string
 * literal that BEGINS with `.audit-tools` followed by a quote end or a path
 * separator (e.g. `join(root, ".audit-tools", ...)`, `const X = ".audit-tools"`,
 * `".audit-tools/audit"`). Deliberately excluded:
 *   - comment lines (trimmed line starts with `//`, `*`, or `/*`) — doc prose;
 *   - backtick contexts — template-literal PROSE in host prompts quotes paths as
 *     markdown code spans (\`.audit-tools/...\`), which is display text;
 *   - mid-string prose mentions (not immediately after a quote);
 *   - `.audit-tools-visibility` (the committed repo-root pin FILE, a distinct
 *     literal owned by gitignoreArtifacts.ts — the lookahead requires `"`/`'`/
 *     `/`/`\` right after `.audit-tools`, so the `-visibility` suffix never
 *     matches).
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
const ALLOWLIST = new Map([
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
    "src/remediate/steps/dispatch/implementPrompt.ts",
    "skip-dir name list embedded in the worker prompt text, not a join",
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
    "src/audit/providers/claudeCodeProvider.ts",
    "repo-relative session-config path quoted in the nested-session guard " +
      "MESSAGE shown to the host — display text, not path construction",
  ],
  [
    "src/remediate/providers/claudeCodeProvider.ts",
    "repo-relative session-config path quoted in the nested-session guard " +
      "MESSAGE shown to the host — display text, not path construction",
  ],
  [
    "wrapper/audit-code-wrapper-install-hosts.mjs",
    "pre-dist bootstrap: wrappers run before dist/ exists (fresh install / " +
      "global bin), so they cannot import the compiled shared path module",
  ],
  [
    "wrapper/audit-code-wrapper-lib.mjs",
    "pre-dist bootstrap: wrappers run before dist/ exists, cannot import the " +
      "compiled shared path module",
  ],
  [
    "wrapper/audit-code-wrapper-opencode.mjs",
    "pre-dist bootstrap + opencode permission GLOB patterns ('.audit-tools/**')",
  ],
  [
    "wrapper/remediate-code-wrapper-install-hosts.mjs",
    "pre-dist bootstrap: wrappers run before dist/ exists, cannot import the " +
      "compiled shared path module",
  ],
  [
    "wrapper/remediate-code-wrapper-opencode.mjs",
    "pre-dist bootstrap + opencode permission GLOB patterns ('.audit-tools/**')",
  ],
]);

const SCAN_DIRS = ["src", "wrapper"];
const CODE_FILE_RE = /\.(?:[cm]?[jt]s)$/;
const SKIP_DIR_NAMES = new Set(["node_modules", "dist"]);

/**
 * A quoted string literal beginning with `.audit-tools` followed by a quote end
 * or a path separator — the path-construction shape. Backticks intentionally
 * omitted (template-literal prose in prompts), `-visibility` intentionally
 * excluded by the lookahead.
 */
const VIOLATION_RE = /["']\.audit-tools(?=["'/\\])/;

/** A comment-only line (block-comment bodies start with `*` in this codebase). */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

/** Recursively collect code files under `dir`, as repo-relative "/" paths. */
function listCodeFiles(dir, rel, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listCodeFiles(abs, r, out);
    else if (CODE_FILE_RE.test(ent.name)) out.push(r);
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const dirName of SCAN_DIRS) {
    listCodeFiles(join(repoRoot, dirName), dirName, files);
  }
  return files;
}

/** All violating `file:line` hits in one file (empty array = clean). */
function violationsIn(relPath) {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(".audit-tools")) continue;
    if (isCommentLine(line)) continue;
    if (VIOLATION_RE.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
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
    "allowlist entry %s still exists and still carries the literal (honesty check)",
    (file) => {
      // A stale entry (file deleted, or its occurrences cleaned up) must be
      // removed rather than sit as a silent hole in the gate.
      expect(existsSync(join(repoRoot, file))).toBe(true);
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(text.includes(".audit-tools")).toBe(true);
    },
  );
});
