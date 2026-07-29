#!/usr/bin/env node
// Backticked repo-path citation gate for tracked markdown.
//
// Docs here cite code overwhelmingly as a path in backticks (`src/foo/bar.ts`),
// not as a markdown link — and until this gate only the link form was checked
// (`check:doc-links`), so a rename/delete left every backtick citation pointing
// at nothing. The `.mjs`→`.ts` test conversion alone stranded 31 such citations
// across 9 docs, found a week later by a nightly review instead of at the commit
// that renamed the files.
//
// Resolution is against the GIT-TRACKED file set, never `existsSync`: a gate
// that asks the local disk is green on the machine that has the artifact and
// red in a fresh CI clone (the exact false-green/false-red split the doc-links
// gate had to fix). A citation into a gitignored/runtime path never matches a
// tracked top-level dir prefix in the first place, so it is out of scope by
// construction.
//
// What counts as a citation (all conditions):
//   • an inline backtick span with no whitespace inside;
//   • contains a `/` and its first segment is a top-level dir that actually
//     holds tracked files (derived from the tracked set — never a hand list);
//   • its last segment carries an extension;
//   • carries no pattern/placeholder characters (`*`, `{`, `<`, `>`) — those
//     are globs or templates, not citations.
// A trailing `:123` / `:12-34` / `:~653` line suffix is stripped before
// resolution (line-anchored citations are the repo's normal citation form).
//
// EXEMPTION is explicit and inline, never inferred from prose (the manifest's
// data-not-prose principle): an HTML comment
//     <!-- doc-citation-exempt: <reason> -->
// on the line above (or on the same line as) the citation exempts that line's
// citations. Two legitimate classes need it: third-party repo paths, and
// deliberate "this file does not exist" narrative.
//
// Files matching the doc-manifest `excluded` row (dated review records, runtime
// artifacts, the guidelines file itself) are skipped — same single-sourced set,
// imported from scripts/doc-manifest-data.mjs, never restated here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DOC_MANIFEST } from "./doc-manifest-data.mjs";
import { globToRegExp, isGlob } from "./check-doc-manifest.mjs";

const root = resolve(process.argv[2] ?? process.cwd());

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

/** All tracked files (forward-slashed) — the resolution universe. */
function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

const EXEMPT_MARKER = /<!--\s*doc-citation-exempt:.*?-->/;

/** Paths the doc-manifest `excluded` row names (exact or pattern). */
function excludedMatchers() {
  const row = DOC_MANIFEST.find((r) => r.type === "excluded");
  if (!row) return [];
  return row.files.map(([pattern]) =>
    isGlob(pattern)
      ? globToRegExp(pattern)
      : new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
}

/** Strip a trailing line-anchor suffix (`:123`, `:12-34`, `:~653`, `:1,2`). */
function stripLineSuffix(token) {
  return token.replace(/:[~\d][\d,~–-]*$/, "");
}

const PATTERN_CHARS = /[*{<>]/;
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

// The runtime STATE dirs (`.audit-tools` path-module contract). Docs cite paths
// under them constantly as the run-artifact LAYOUT (`.audit-tools/audit/steps/…`)
// — those name files a run writes, never repo files, even though the dir itself
// carries two tracked report artifacts. Layout citations are out of this gate's
// scope by contract, not by hand-listing.
const RUNTIME_STATE_PREFIXES = [".audit-tools/", ".audit-tools-visibility/"];

function main() {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const topDirs = new Set(
    tracked.filter((p) => p.includes("/")).map((p) => p.split("/", 1)[0]),
  );
  const excluded = excludedMatchers();
  const markdown = tracked.filter(
    (p) => p.endsWith(".md") && !excluded.some((re) => re.test(p)),
  );

  let checked = 0;
  const failures = [];

  for (const relPath of markdown) {
    const lines = readFileSync(join(root, relPath), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const token = match[1];
        if (/\s/.test(token) || PATTERN_CHARS.test(token)) continue;
        if (!token.includes("/")) continue;
        const path = stripLineSuffix(token).replace(/^\.\//, "");
        if (RUNTIME_STATE_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (!topDirs.has(path.split("/", 1)[0])) continue;
        if (!HAS_EXTENSION.test(path)) continue;
        checked += 1;
        if (trackedSet.has(path)) continue;
        const exempt =
          EXEMPT_MARKER.test(line) || (i > 0 && EXEMPT_MARKER.test(lines[i - 1]));
        if (exempt) continue;
        failures.push({ relPath, line: i + 1, token });
      }
    });
  }

  if (failures.length > 0) {
    console.error(
      `check-doc-code-citations: ${failures.length} backticked repo path(s) do not name a tracked file:`,
    );
    for (const f of failures) {
      console.error(`  ${f.relPath}:${f.line}  \`${f.token}\``);
    }
    console.error(
      "\nFix the citation (the file moved/renamed/was deleted), or — for a third-party path or " +
        "deliberate does-not-exist narrative — put `<!-- doc-citation-exempt: <reason> -->` on the " +
        "line above it.",
    );
    process.exit(1);
  }

  console.log(
    `check-doc-code-citations: ${checked} backticked repo-path citation(s) across ` +
      `${markdown.length} tracked docs — every one names a tracked file.`,
  );
}

main();
