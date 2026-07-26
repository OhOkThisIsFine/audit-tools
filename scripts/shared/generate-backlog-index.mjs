#!/usr/bin/env node
// Regenerate the SEEK INDEX in `docs/backlog.md` from the split backlog
// (`docs/backlog/*.md`).
//
// WHY THIS EXISTS. `open-bugs.md` is past what one Read call returns, so every
// pass over it navigated blind: paged reads plus grep-by-anchor, with line
// numbers shifting under every edit. That is how ~21% of entries silently went
// stale between classification passes — nobody could hold the file at once.
//
// The obvious fix — split the file — was REFUSED by the owner (2026-07-25), and
// the refusal is the documentation philosophy's own: `docs/documentation-philosophy.md`
// §*The condensation bias* says split only when one doc genuinely carries two
// unrelated durable concepts, and splitting for SIZE is the thing it argues
// against. Every file a split created would also have to earn a routing row in
// `docs/doc-review-guidelines.md`.
//
// So the file stays whole and becomes SEEKABLE instead. This index gives every
// entry a `file:line` anchor, so a reader spends one bounded read here and then
// jumps straight to the entry with an offset read. The property the backlog
// entry asked for — "the open-work record is navigable in bounded reads" — is
// satisfied without creating a second home for anything: every line is the
// entry's own bold title, verbatim, exactly as the roadmap generator does it.
//
// It lives in `docs/backlog.md` (the index file that already exists) rather than
// in a new file, for two reasons: a new file needs a manifest row, and
// `docs/backlog.md` is outside `check-backlog-budget.mjs`'s scope
// (`docs/backlog/*.md`), so the index cannot push an over-budget file further
// over its shrink-only ceiling.
//
// UNLIKE the roadmap, this index includes `durable-traps.md`. The roadmap
// excludes it because a QUEUE that lists reference material stops being a queue;
// an index that omits a file you still have to navigate is just a worse index.
//
//   node scripts/shared/generate-backlog-index.mjs           # write
//   node scripts/shared/generate-backlog-index.mjs --check    # verify only
//
// `--check` is wired into BOTH `verify:checks` and `.claude/hooks/pre-commit-gate.mjs`
// — the pre-commit hook does NOT run `verify:checks`, so a gate wired only there
// fails first in RELEASE CI and burns a tag.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseBulletEntries, parseTrackEntries, sectionText } from "./generate-handoff-roadmap.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backlogDir = join(repoRoot, "docs", "backlog");
const indexPath = join(repoRoot, "docs", "backlog.md");

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED SEEK INDEX — scripts/shared/generate-backlog-index.mjs — DO NOT EDIT BY HAND -->";
export const END_MARKER = "<!-- END GENERATED SEEK INDEX -->";

/**
 * Every backlog file, in index order. `forward-tracks.md` appears twice because
 * its two sections use different entry grammars — `## Open tracks` writes
 * `**Track N — …**` paragraphs, everything else writes `- **…**` bullets. Both
 * readers are imported from the roadmap generator so "what counts as an entry"
 * has ONE definition across the roadmap, the budget gate and this index.
 */
export const INDEX_SOURCES = [
  { file: "open-bugs.md", kind: "bullets" },
  { file: "forward-tracks.md", kind: "tracks", section: "Open tracks" },
  { file: "forward-tracks.md", kind: "bullets", section: "Forward tracks" },
  { file: "deferred.md", kind: "bullets" },
  { file: "durable-traps.md", kind: "bullets" },
];

/**
 * Collect every entry with the line it starts on.
 *
 * A section-scoped source is parsed from the section's own text, so the line
 * numbers it yields are relative to that slice — they are re-based onto the
 * whole file here. An index whose anchors are off by a section header is worse
 * than no index: it sends the reader to confidently wrong prose.
 *
 * @param {Map<string, string>} sources filename → full file text
 */
export function collectIndex(sources) {
  const groups = [];
  for (const src of INDEX_SOURCES) {
    const whole = sources.get(src.file);
    if (whole === undefined) {
      throw new Error(`backlog index source docs/backlog/${src.file} was not supplied`);
    }
    let scope = whole;
    let lineOffset = 0;
    if (src.section) {
      scope = sectionText(whole, src.section);
      const lines = whole.split(/\r?\n/);
      // `sectionText` returns the lines AFTER the heading, so the first line of
      // the slice is (heading index + 1) in the whole file, 1-indexed.
      lineOffset = lines.findIndex((l) => l.trim() === `## ${src.section}`) + 1;
    }
    const parse = src.kind === "tracks" ? parseTrackEntries : parseBulletEntries;
    const items = parse(scope, `docs/backlog/${src.file}`).map((e) => ({
      title: e.title,
      line: e.line + lineOffset,
      file: src.file,
    }));
    groups.push({ file: src.file, section: src.section, items });
  }
  return groups;
}

const heading = (g) => (g.section ? `${g.file} — ${g.section}` : g.file);

/** Render the whole generated block, markers included. */
export function renderIndex(groups) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const body = groups
    .map(
      (g) =>
        `### [\`${heading(g)}\`](backlog/${g.file})\n\n` +
        (g.items.length === 0
          ? `*(none)*\n`
          : g.items
              .map((i) => `- \`${i.file}:${i.line}\` — ${i.title}\n`)
              .join("")),
    )
    .join("\n");

  return (
    `${BEGIN_MARKER}\n` +
    `\n` +
    `> **Seek index — GENERATED from [\`docs/backlog/\`](backlog/); do not hand-edit it.**\n` +
    `> \`open-bugs.md\` is past what one read call returns. Read THIS list once, then jump straight to\n` +
    `> an entry with an offset read at its \`file:line\` anchor — that is what makes the open-work\n` +
    `> record navigable in bounded reads without splitting it.\n` +
    `> Titles are each entry's own bold lead-in, verbatim, so this index restates nothing and cannot\n` +
    `> drift. **Line numbers move under every edit** — regenerate rather than hand-patching them:\n` +
    `> \`node scripts/shared/generate-backlog-index.mjs\` (\`--check\` gates it in \`verify:checks\`\n` +
    `> and at commit). ${total} entr(y/ies) indexed.\n` +
    `\n` +
    body +
    `\n${END_MARKER}`
  );
}

/** Replace the delimited block, leaving every hand-written line byte-identical. */
export function spliceIndex(indexText, block) {
  const begin = indexText.indexOf(BEGIN_MARKER);
  const end = indexText.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `docs/backlog.md is missing the generated seek-index markers (or they are out of order).\n` +
        `Restore this pair around the index:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`,
    );
  }
  return indexText.slice(0, begin) + block + indexText.slice(end + END_MARKER.length);
}

function readSources() {
  const files = [...new Set(INDEX_SOURCES.map((s) => s.file))];
  return new Map(files.map((f) => [f, readFileSync(join(backlogDir, f), "utf8")]));
}

function main() {
  const block = renderIndex(collectIndex(readSources()));
  const current = readFileSync(indexPath, "utf8");
  const rendered = spliceIndex(current, block);

  if (process.argv.includes("--check")) {
    if (current !== rendered) {
      process.stderr.write(
        `\ndocs/backlog.md's generated seek index is STALE — its anchors no longer match docs/backlog/.\n` +
          `A stale anchor is worse than no anchor: it sends the reader to confidently wrong prose.\n` +
          `Fix: node scripts/shared/generate-backlog-index.mjs\n\n`,
      );
      process.exit(1);
    }
    const count = (rendered.match(/^- `[^`]+:\d+` — /gm) ?? []).length;
    process.stdout.write(`✓ backlog-index: docs/backlog.md matches the backlog (${count} anchor(s))\n`);
    process.exit(0);
  }

  writeFileSync(indexPath, rendered, "utf8");
  process.stdout.write(`wrote ${indexPath}\n`);
}

// Importable as a library (the contract test drives the pure functions with
// synthetic text), so the CLI body runs ONLY on direct invocation — importing
// this module must never write to the tree as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
