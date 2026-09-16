#!/usr/bin/env node
// sites-pinned: tests/shared/backlog-index.test.ts
//   The seek index (anchors, pointers, splice) and the live-run watch matrix (which entries
//   become rows, the first-sentence lift, the render, the splice) are pinned by that suite.
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseBulletEntries, parseTrackEntries, sectionText } from "./generate-handoff-roadmap.mjs";
import { runGeneratedArtifactCli, spliceGeneratedBlock } from "./generatedArtifacts.mjs";
import { rebaseRelativeLinks } from "./rebase-relative-links.mjs";
import { findEntryBoundaryDamage, renderEntryBoundaryDamage } from "./backlog-entry-grammar.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backlogDir = join(repoRoot, "docs", "backlog");
const indexPath = join(repoRoot, "docs", "backlog.md");

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED SEEK INDEX — scripts/shared/generate-backlog-index.mjs — DO NOT EDIT BY HAND -->";
export const END_MARKER = "<!-- END GENERATED SEEK INDEX -->";

// The live-validation watch matrix, in the SAME file and the SAME generator run
// as the seek index — but its own marker pair, because the two blocks answer
// different questions and are spliced independently.
//
// WHY GENERATED. The hand-written matrix named eight items per run config while
// only four entries in the whole backlog carried a `Live-run watch` line: six of
// the eight names resolved to no entry at all, so an operator following the guide
// was sent looking for items that do not exist. It had drifted twice and nothing
// could catch it, because nothing joined the guide to the corpus it described. A
// generated block cannot name an item the backlog does not hold — the same
// property the seek index has, and for the same reason.
export const WATCH_BEGIN_MARKER =
  "<!-- BEGIN GENERATED LIVE-RUN WATCH — scripts/shared/generate-backlog-index.mjs — DO NOT EDIT BY HAND -->";
export const WATCH_END_MARKER = "<!-- END GENERATED LIVE-RUN WATCH -->";

/** The marker whose PRESENCE in an entry makes it a live-run watch row. */
const WATCH_TOKEN = "Live-run watch";

/**
 * Every backlog file, in index order. `forward-tracks.md` appears twice because
 * its two sections use different entry grammars — `## Open tracks` writes
 * `**Track N — …**` paragraphs, everything else writes `- **…**` bullets. Both
 * readers are imported from the roadmap generator so "what counts as an entry"
 * has ONE definition across the roadmap, the budget gate and this index.
 */
export const INDEX_SOURCES = [
  { file: "open-bugs.md", kind: "bullets" },
  // The LOW-severity tail, split out of open-bugs.md when that file hit its
  // 120,000-byte ceiling. Indexed identically: the split bounds the READ, and
  // must not bound the sweep — an entry that leaves the index is an entry that
  // goes stale unseen, which is the failure the budget gate exists to prevent.
  { file: "minor-bugs.md", kind: "bullets" },
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
    // `body` is carried but never rendered by `renderIndex`: the live-run watch
    // matrix reads it, and reading the corpus twice would be a second definition
    // of "which entries exist" — the drift this generator exists to remove.
    const items = parse(scope, `docs/backlog/${src.file}`).map((e) => ({
      title: e.title,
      line: e.line + lineOffset,
      file: src.file,
      body: e.body,
    }));
    groups.push({ file: src.file, section: src.section, items });
  }
  return groups;
}

const heading = (g) => (g.section ? `${g.file} — ${g.section}` : g.file);

/**
 * The `Live-run watch` line(s) of one entry BODY, as a single collapsed string —
 * or null when the entry carries none.
 *
 * WHAT IS LIFTED, AND WHY IT IS BOUNDED. An entry may carry its watch line at
 * the head of the entry (so the bold TITLE is the watch line) or as its own
 * `- **⬇ Live-run watch …**` bullet further down. In both cases the matrix needs
 * a POINTER, not the entry: the row already links to the entry, and pasting the
 * whole body would make the generated block a second copy of the backlog — the
 * exact drift the seek index avoids by lifting titles alone.
 *
 * So the extracted line stops at the first sentence-ending period followed by
 * whitespace or end-of-text, which is where every watch line in this corpus
 * states its observation before proceeding to supporting detail. Text before
 * that point is lifted VERBATIM (decoration stripped, whitespace collapsed).
 */
export function extractWatchLine(body) {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.toLowerCase().includes(WATCH_TOKEN.toLowerCase()));
  if (at === -1) return null;
  // The watch paragraph runs to the next blank line — a wrapped watch is
  // carried whole rather than truncated at the wrap.
  const collected = [lines[at]];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") break;
    collected.push(lines[i]);
  }
  const prose = collected
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    // The entry's own lead-in decoration: the bullet, the `⬇` marker, and any
    // run of emphasis before the words, so the row reads as a sentence rather
    // than as a fragment of markdown.
    .replace(/^[-*\s]*⬇?\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  if (prose === "") return null;
  // First sentence, at most — a pointer, not the entry.
  const stop = prose.search(/\.\s|\.$/);
  const first = stop === -1 ? prose : prose.slice(0, stop + 1);
  return first.trim();
}

/**
 * Every entry in the corpus that carries a `Live-run watch` line, in index
 * order — the whole input to the generated matrix.
 *
 * Reads the SAME parsed entries the seek index uses, so "which entries exist"
 * has one definition across both blocks and a newly-filed watch entry appears in
 * the matrix on the next generation with no edit to this file.
 *
 * @param {Map<string, string>} sources filename → full file text
 */
export function collectWatchRows(sources) {
  const rows = [];
  for (const src of INDEX_SOURCES) {
    const whole = sources.get(src.file);
    if (whole === undefined) continue;
    let scope = whole;
    if (src.section) scope = sectionText(whole, src.section);
    const parse = src.kind === "tracks" ? parseTrackEntries : parseBulletEntries;
    for (const e of parse(scope, `docs/backlog/${src.file}`)) {
      const watch = extractWatchLine(e.body ?? "");
      if (watch !== null) rows.push({ file: src.file, title: e.title, watch });
    }
  }
  return rows;
}

/** Render the live-run watch matrix block, markers included. */
export function renderWatchMatrix(rows) {
  const head =
    `> **Live-validation watch matrix — GENERATED from the entries that carry a ` +
    `\`Live-run watch\` line; do not hand-edit it.**\n` +
    `> Each row below IS an entry in this backlog, linked to where it lives, with that ` +
    `entry's own watch line lifted verbatim — so a row can never name an item the ` +
    `backlog does not hold. File an entry with a **⬇ Live-run watch** line and it ` +
    `appears here on the next generation.\n`;
  if (rows.length === 0) {
    return (
      `${WATCH_BEGIN_MARKER}\n\n${head}\n` +
      `No entry in \`docs/backlog/\` currently carries a \`Live-run watch\` line, so there ` +
      `is nothing to watch for on a live run.\n\n${WATCH_END_MARKER}`
    );
  }
  const body = rows
    .map(
      (r) =>
        `- **${rebaseRelativeLinks(r.title, `docs/backlog/${r.file}`, "docs/backlog.md")}** — ` +
        `[${r.file}](backlog/${r.file})\n  ${r.watch}\n`,
    )
    .join("");
  return `${WATCH_BEGIN_MARKER}\n\n${head}\n${body}\n${WATCH_END_MARKER}`;
}

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
              .map(
                // Lifted VERBATIM from `docs/backlog/<file>` into `docs/backlog.md`
                // — one directory up — so relative links inside the title must be
                // re-based, exactly as the roadmap generator does it.
                (i) =>
                  `- \`${i.file}:${i.line}\` — ${rebaseRelativeLinks(
                    i.title,
                    `docs/backlog/${i.file}`,
                    "docs/backlog.md",
                  )}\n`,
              )
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
  return spliceGeneratedBlock(indexText, block, {
    begin: BEGIN_MARKER,
    end: END_MARKER,
    target: "docs/backlog.md",
  });
}

/** Splice the live-run watch matrix, its own marker pair in the same file. */
export function spliceWatchMatrix(indexText, block) {
  return spliceGeneratedBlock(indexText, block, {
    begin: WATCH_BEGIN_MARKER,
    end: WATCH_END_MARKER,
    target: "docs/backlog.md",
  });
}

function readSources() {
  const files = [...new Set(INDEX_SOURCES.map((s) => s.file))];
  return new Map(files.map((f) => [f, readFileSync(join(backlogDir, f), "utf8")]));
}

/**
 * Entry-boundary damage across every indexed source, as `{ file, text }` pairs
 * ready for `renderEntryBoundaryDamage` — or null when the corpus is sound.
 *
 * WHY THIS GATE AND NOT THE BUDGET OR ROADMAP ONE. The seek index's whole
 * subject is "which entries exist", so damage to that question is damage to this
 * gate's own premise — and unlike the other two consumers, this one already
 * reads every indexed file in one pass. The budget gate reads the same bytes to
 * METER them (a merged entry is merely a bigger one) and the roadmap reads them
 * to lift titles (a merged entry is simply not pinned); neither is refuted by
 * the damage, while this index silently stops listing the entry. That is the
 * defect the incident produced, so this is the boundary that owns the refusal.
 *
 * Scanned from the WHOLE file, never the section slice `collectIndex` parses:
 * `findEntryBoundaryDamage` needs the section headings to know that
 * `## Open tracks` writes bold paragraphs, and a slice has lost them.
 */
export function findBoundaryDamage(sources) {
  const found = [];
  for (const file of new Set(INDEX_SOURCES.map((s) => s.file))) {
    const damaged = findEntryBoundaryDamage(sources.get(file) ?? "");
    if (damaged.length > 0) found.push({ file, damaged });
  }
  return found.length > 0 ? found : null;
}

/**
 * Both stale generators named in ONE refusal (2026-07-25 friction walk).
 *
 * A single backlog edit stales the seek index AND the HANDOFF roadmap — two
 * generators, each with its own commit-gate refusal — so the operator learned
 * the second was stale only after fixing and re-committing the first: two
 * blocked commits for one edit. The two gates cannot be merged (they own
 * different files and different triggers), but the refusal each prints travels
 * with the FIX, and naming both fix commands here makes one round-trip enough.
 * A new `regen:docs` script would be a third thing to keep in step with the two
 * it wraps; naming them costs nothing and cannot drift.
 */
export const BOTH_GENERATORS =
  `Both generators read docs/backlog/:\n` +
  `  node scripts/shared/generate-backlog-index.mjs     (docs/backlog.md)\n` +
  `  node scripts/shared/generate-handoff-roadmap.mjs   (docs/HANDOFF.md)\n` +
  `Run BOTH before re-staging — one backlog edit stales each, and fixing them one per\n` +
  `commit costs two blocked commits to learn what one message can say.\n`;

function main() {
  const sources = readSources();
  // Boundary damage FIRST, and return before the parity comparison: the parity
  // check would otherwise report a healthy-looking index, because the generator
  // counts entries from the same damaged bytes and so agrees with the damage.
  // Two refusals for one defect would also read as two defects.
  const damage = findBoundaryDamage(sources);
  if (damage !== null) {
    process.stderr.write(
      `\n` +
        damage.map(({ file, damaged }) => renderEntryBoundaryDamage(damaged, `docs/backlog/${file}`)).join("\n") +
        `\n` +
        BOTH_GENERATORS +
        `\n`,
    );
    process.exit(1);
  }
  const groups = collectIndex(sources);
  const watchRows = collectWatchRows(sources);
  // Both blocks live in docs/backlog.md and are spliced in one pass: the seek
  // index first (it is the marker pair near the top), then the watch matrix. A
  // second read-and-write would race the first and could not see its own splice.
  const withIndex = spliceIndex(readFileSync(indexPath, "utf8"), renderIndex(groups));
  const rendered = spliceWatchMatrix(withIndex, renderWatchMatrix(watchRows));
  const count = (rendered.match(/^- `[^`]+:\d+` — /gm) ?? []).length;
  runGeneratedArtifactCli({
    repoRoot,
    files: [{ target: "docs/backlog.md", next: rendered }],
    staleMessage:
      `The generated seek index's anchors no longer match docs/backlog/, or the generated ` +
      `live-run watch matrix no longer matches the entries carrying a \`Live-run watch\` line. ` +
      `A stale anchor is worse than no anchor: it sends the reader to confidently wrong prose.\n` +
      BOTH_GENERATORS,
    fixCommand: "node scripts/shared/generate-backlog-index.mjs",
    okMessage:
      `backlog-index: docs/backlog.md matches the backlog (${count} anchor(s), ` +
      `${watchRows.length} live-run watch row(s))`,
  });
}

// Importable as a library (the contract test drives the pure functions with
// synthetic text), so the CLI body runs ONLY on direct invocation — importing
// this module must never write to the tree as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
