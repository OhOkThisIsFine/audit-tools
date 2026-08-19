#!/usr/bin/env node
// Refuse bare LINE NUMBERS in citation position in docs/backlog/*.md.
//
// WHY. The durable-traps rule is explicit: "Cite a SYMBOL, never a bare line
// number — and when no good symbol exists, cite the file alone." Line numbers
// across the backlog drifted repo-wide while the symbol names beside them still
// resolved, so hand-bumping them was a treadmill that bought nothing — 77
// suffixes were dropped 2026-07-28, two wrong ones (`(defined `:21`, asserted
// `:505`)`) were deleted 2026-08-18, and two more were found the same day. A
// rule that was written down and then violated three times is a rule depending
// on the writer remembering it, which is the thing this project bans. This is
// the rule, enforced.
//
// WHAT IS REFUSED — the citation FORM, inside inline code spans only:
//   1. a backticked repo-path or file citation carrying a `:<digits>` suffix —
//      `src/foo/bar.ts:123`, `runtimeCommand.ts:48-55`, `x.mjs:21:7` (ranges
//      and line:col forms included);
//   2. a backticked BARE line number — the `(defined `:21`)` form, where the
//      path was cited beside it and the number rode along in its own span.
//
// WHAT STAYS QUIET, each against a surface measured in or named for this corpus:
//   • FENCED code blocks — quoted OUTPUT (a stack trace, an error line)
//     legitimately contains `file.ts:123:7`; the fence toggle skips them whole.
//   • host:port — `127.0.0.1:3001` is verbatim in durable-traps today. A
//     flagged suffix's prefix must LOOK like a repo path or file: contain a
//     path separator, or end in an ALPHABETIC extension. An IP's `.1` is
//     numeric and `localhost` has no extension, so neither ever qualifies.
//   • URLs — `http://127.0.0.1:3001` contains a slash, but a scheme
//     disqualifies the token outright.
//   • times, ratios, ISO timestamps — `12:30`, `4:1`, `2026-08-18T20:07:28`
//     all have prefixes that are neither path- nor extension-shaped.
//   • docs/backlog.md — the GENERATED seek index cites `file.md:<line>` on
//     purpose (regenerated on every edit, so its numbers cannot drift). It
//     lives OUTSIDE docs/backlog/, so scanning the entry directory excludes it
//     by construction; `check:backlog-index` owns its correctness.
//
// KNOWN RESIDUALS, stated rather than hidden. An UNBACKTICKED `src/foo.ts:123`
// in prose is not caught (this corpus cites in backticks — widen on evidence,
// not speculation), and neither is a slash-free `identifier:123` form
// (`localhost:3001` is the false RED that width would buy). A false RED costs
// more than a false negative — a gate that cries wolf gets disabled, and then
// nothing is guarded at all.
//
//   node scripts/check-backlog-line-numbers.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backlogDir = join(repoRoot, "docs", "backlog");

/** A line suffix at the end of a token: `:123`, `:48-55`, `:21:7`, `:12:1-14:3`. */
const LINE_SUFFIX = /:(\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/;

/** A whole token that IS a line suffix — the `(defined `:21`)` form. */
const BARE_CITATION = /^:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/;

/** `scheme://` — a URL's port or path is never a line-number citation. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Path-shaped: a separator, or an ALPHABETIC file extension (`.ts`, `.mjs` —
 *  not an IP octet's `.1`). This is the discriminator that keeps `127.0.0.1:3001`
 *  and `localhost:8787` quiet while `nextStep.ts:210` still fires. */
function looksLikeRepoPath(prefix) {
  if (URL_SCHEME.test(prefix)) return false;
  return /[\\/]/.test(prefix) || /\.[A-Za-z][A-Za-z0-9]*$/.test(prefix);
}

/**
 * Every line-number citation in one file's text.
 * @returns {{line:number, column:number, kind:string, span:string, source:string}[]}
 */
export function findLineNumberCitations(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const spanRe = /`([^`]+)`/g;
    let m;
    while ((m = spanRe.exec(raw)) !== null) {
      const span = m[1];
      // Tokenize on whitespace: a span conventionally holds exactly one
      // citation, but a multi-token span must not hide one.
      for (const rawToken of span.split(/\s+/)) {
        const token = rawToken.replace(/^[([{]+/, "").replace(/[)\]}…,;.]+$/, "");
        if (token === "") continue;
        const kind = BARE_CITATION.test(token)
          ? "bare line-number citation"
          : (() => {
              const suffix = token.match(LINE_SUFFIX);
              return suffix && looksLikeRepoPath(token.slice(0, suffix.index))
                ? "line-number suffix on a path citation"
                : null;
            })();
        if (kind === null) continue;
        found.push({ line: i + 1, column: m.index + 1, kind, span, source: raw });
        break; // one report per span — the fix rewrites the whole citation
      }
    }
  });
  return found;
}

function main() {
  const files = readdirSync(backlogDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const violations = [];
  for (const file of files) {
    for (const hit of findLineNumberCitations(readFileSync(join(backlogDir, file), "utf8"))) {
      violations.push(
        `docs/backlog/${file}:${hit.line}:${hit.column} — ${hit.kind} \`${hit.span}\`\n` +
          `      ${hit.source.trim().slice(0, 140)}`,
      );
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`✓ backlog-line-numbers: no bare line-number citations across ${files.length} file(s)\n`);
    return;
  }

  process.stderr.write(
    `\ncheck-backlog-line-numbers: ${violations.length} line-number citation(s) in docs/backlog/\n\n` +
      violations.map((v) => `  ${v}`).join("\n") +
      `\n\nCite a SYMBOL, never a bare line number — and when no good symbol exists, cite the\n` +
      `FILE alone (the durable-traps rule, docs/backlog/durable-traps.md). Line numbers\n` +
      `drift repo-wide while the symbol names beside them still resolve; hand-bumping them\n` +
      `is a treadmill that buys nothing.\n\n` +
      `Fix shape:\n` +
      `  \`src/foo/bar.ts:123\`   →  \`theSymbol\` (\`src/foo/bar.ts\`), or \`src/foo/bar.ts\` alone\n` +
      `  (defined \`:21\`)        →  name the symbol, or drop the parenthetical outright\n\n` +
      `Do NOT "repair" a drifted number by auto-resolving it to the nearest declaration —\n` +
      `that swaps an honest stale number for a confident wrong symbol. Output QUOTED in a\n` +
      `fenced code block is already exempt; so are host:port and URL forms (\`127.0.0.1:3001\`).\n\n`,
  );
  process.exit(1);
}

// Run only when invoked as a CLI — importing this module must not scan or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
