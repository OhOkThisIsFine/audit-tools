#!/usr/bin/env node
// Regenerate the ordered ROADMAP section of `docs/HANDOFF.md` from the split
// backlog (`docs/backlog/*.md`).
//
// WHY THIS EXISTS. `docs/HANDOFF.md` is the ordered roadmap — its own header,
// `docs/documentation-philosophy.md` and `docs/doc-review-guidelines.md` all say
// so, and that framing stays. The defect was DUPLICATION: an open item was
// written out as a full SPEC in HANDOFF *and* in `docs/backlog/open-bugs.md`, so
// the two drifted — and version-by-version changelog narration regrew in HANDOFF
// one lap after ~107 lines of it were cut. Fixing the instance has already
// failed once, which is why the fix has to be mechanical rather than a rule
// somebody remembers.
//
// So: HANDOFF keeps the ORDER, the backlog keeps the TEXT. Every generated line
// is a POINTER — the backlog entry's own bold title, verbatim, plus a link to
// the file that holds its spec. Nothing in the generated block restates a spec,
// so there is no second copy left to drift.
//
// ORDER SIGNAL — deliberately derived, not declared. An entry's rank is
// (source rank, position in its file): the source order is the fixed
// `ROADMAP_SOURCES` list below, and within a source the entries appear in
// document order. Re-prioritising therefore means MOVING the entry inside its
// backlog file — a single-home edit in the doc that already owns the item. The
// one optional override is `PIN_MARKER`: an entry whose bold title begins with
// `▶` is hoisted into a "Next up" group ahead of everything else, preserving
// document order among the pinned. Zero entries carry it today; it exists so the
// curated head this doc used to hand-maintain can be restored with a
// one-character edit per item rather than a marker on all ~110.
//
//   node scripts/shared/generate-handoff-roadmap.mjs           # write
//   node scripts/shared/generate-handoff-roadmap.mjs --check    # verify only
//
// `--check` is wired into BOTH `verify:checks` and `.claude/hooks/pre-commit-gate.mjs`.
// Both, on purpose: the pre-commit hook does NOT run `verify:checks`, so a gate
// wired only there fails first in RELEASE CI — the class that burned v0.34.17.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backlogDir = join(repoRoot, "docs", "backlog");
const handoffPath = join(repoRoot, "docs", "HANDOFF.md");

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->";
export const END_MARKER = "<!-- END GENERATED ROADMAP -->";

/** A bold title starting with this is hoisted to the top of the roadmap. */
export const PIN_MARKER = "▶";

/**
 * The sources, in roadmap order. `durable-traps.md` is deliberately absent — it
 * is standing environment reference, not work (both `CLAUDE.md` and
 * `docs/backlog.md` classify it that way), and a roadmap that lists reference
 * material stops being a queue. The exclusion is STATED in the rendered block so
 * it is visible rather than silent.
 */
export const ROADMAP_SOURCES = [
  {
    file: "open-bugs.md",
    kind: "bullets",
    heading: "Open bugs & frictions — the working queue",
  },
  {
    file: "forward-tracks.md",
    section: "Open tracks",
    kind: "tracks",
    heading: "Open tracks — in flight",
  },
  {
    file: "forward-tracks.md",
    section: "Forward tracks",
    kind: "bullets",
    heading: "Forward tracks — design-level directions",
  },
  {
    file: "deferred.md",
    kind: "bullets",
    heading: "Deferred / waiting — blocked on data, a live run, credentials or a toolchain",
  },
];

const collapse = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Pull the bold lead-in title out of an entry body. Entries in this backlog are
 * written `- **Title …**  body…`, and the bold run may span several lines. The
 * title is taken VERBATIM: a pointer that paraphrases is a second copy, which is
 * the whole defect this generator removes.
 */
function boldTitle(body, { where, opener }) {
  const m = body.match(new RegExp(`^${opener}\\*\\*([\\s\\S]*?)\\*\\*`));
  if (!m) {
    throw new Error(
      `${where}: entry has an UNTERMINATED bold title — the roadmap pointer cannot be derived.\n` +
        `Every backlog entry must open \`- **Title …**\`. Close the bold run and re-run the generator.`,
    );
  }
  return collapse(m[1]);
}

/**
 * Split backlog text into its top-level `- **…` entries. Same entry grammar as
 * `scripts/check-backlog-budget.mjs` — one definition of "an entry" for the
 * budget gate and the roadmap alike; `tests/shared/handoff-roadmap.test.mjs`
 * pins the two against each other so they cannot diverge.
 */
export function parseBulletEntries(text, file = "<text>") {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    if (/^- \*\*/.test(l)) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(start, end).join("\n");
    return {
      title: boldTitle(body, { where: `${file}:${start + 1}`, opener: "- " }),
      line: start + 1,
    };
  });
}

/**
 * `forward-tracks.md`'s *Open tracks* section writes its entries as `**Track N —
 * …**` paragraphs rather than bullets, so it needs its own reader. The track
 * NUMBER is already an explicit order signal in the prose; document order
 * reproduces it without a new marker.
 */
export function parseTrackEntries(text, file = "<text>") {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    if (/^\*\*Track \d+\b/.test(l)) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(start, end).join("\n");
    return {
      title: boldTitle(body, { where: `${file}:${start + 1}`, opener: "" }),
      line: start + 1,
    };
  });
}

/** The text of one `## <heading>` section, up to the next `## ` heading. */
export function sectionText(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) {
    throw new Error(
      `backlog section "## ${heading}" not found — the roadmap generator reads it by name. ` +
        `Either restore the heading or update ROADMAP_SOURCES in ` +
        `scripts/shared/generate-handoff-roadmap.mjs.`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/**
 * Build the ordered roadmap. `sources` maps a backlog filename to its text, so
 * callers (and tests) can drive this without touching disk.
 */
export function collectRoadmap(sources) {
  const groups = [];
  const pinned = [];
  for (const src of ROADMAP_SOURCES) {
    const whole = sources.get(src.file);
    if (whole === undefined) {
      throw new Error(`roadmap source docs/backlog/${src.file} was not supplied`);
    }
    const scope = src.section ? sectionText(whole, src.section) : whole;
    const parse = src.kind === "tracks" ? parseTrackEntries : parseBulletEntries;
    const items = parse(scope, `docs/backlog/${src.file}`).map((e) => ({
      title: e.title,
      file: src.file,
    }));
    const kept = [];
    for (const item of items) {
      if (item.title.startsWith(PIN_MARKER)) pinned.push(item);
      else kept.push(item);
    }
    groups.push({ heading: src.heading, items: kept });
  }
  // The pinned group leads; it is omitted entirely when nothing is pinned, so an
  // empty head never reads as "nothing is next".
  return pinned.length > 0
    ? [{ heading: `${PIN_MARKER} Next up — pinned in the backlog`, items: pinned }, ...groups]
    : groups;
}

const linkFor = (file) => `[\`${file}\`](backlog/${file})`;

/** Render the whole generated block, markers included. */
export function renderRoadmap(groups) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const body = groups
    .map(
      (g) =>
        `### ${g.heading}\n\n` +
        (g.items.length === 0
          ? `*(none open)*\n`
          : g.items.map((i) => `- ${i.title} · ${linkFor(i.file)}\n`).join("")),
    )
    .join("\n");

  return (
    `${BEGIN_MARKER}\n` +
    `\n` +
    `> **This list is GENERATED from [\`docs/backlog/\`](backlog/) — do not hand-edit it.**\n` +
    `> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that\n` +
    `> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.\n` +
    `> **Order = the entry's position in its backlog file.** Re-prioritise by MOVING the entry, never\n` +
    `> by re-wording this list; prefix a title with \`${PIN_MARKER}\` in the backlog to pin it to *Next up*.\n` +
    `> [\`durable-traps.md\`](backlog/durable-traps.md) is excluded on purpose — standing reference, not work.\n` +
    `> Regenerate: \`node scripts/shared/generate-handoff-roadmap.mjs\` (\`--check\` gates it in\n` +
    `> \`verify:checks\` and at commit). ${total} open item(s).\n` +
    `\n` +
    body +
    `\n${END_MARKER}`
  );
}

/** Replace the delimited block in HANDOFF, leaving every hand-written line byte-identical. */
export function spliceRoadmap(handoffText, block) {
  const begin = handoffText.indexOf(BEGIN_MARKER);
  const end = handoffText.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `docs/HANDOFF.md is missing the generated-roadmap markers (or they are out of order).\n` +
        `Restore this pair around the ordered list:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`,
    );
  }
  return handoffText.slice(0, begin) + block + handoffText.slice(end + END_MARKER.length);
}

function readSources() {
  const files = [...new Set(ROADMAP_SOURCES.map((s) => s.file))];
  return new Map(files.map((f) => [f, readFileSync(join(backlogDir, f), "utf8")]));
}

function main() {
  const block = renderRoadmap(collectRoadmap(readSources()));
  const current = readFileSync(handoffPath, "utf8");
  const rendered = spliceRoadmap(current, block);

  if (process.argv.includes("--check")) {
    if (current !== rendered) {
      process.stderr.write(
        `\ndocs/HANDOFF.md's generated roadmap is STALE — it no longer matches docs/backlog/.\n` +
          `The roadmap is the sequencing view of the backlog; a stale copy is a second, drifting\n` +
          `home for the same items, which is exactly what generating it removes.\n` +
          `Fix: node scripts/shared/generate-handoff-roadmap.mjs\n\n`,
      );
      process.exit(1);
    }
    const count = (rendered.match(/^- .+ · \[`/gm) ?? []).length;
    process.stdout.write(`✓ handoff-roadmap: docs/HANDOFF.md matches the backlog (${count} pointer(s))\n`);
    process.exit(0);
  }

  writeFileSync(handoffPath, rendered, "utf8");
  process.stdout.write(`wrote ${handoffPath}\n`);
}

// Importable as a library (the contract test drives the pure functions with
// synthetic text), so the CLI body runs ONLY on direct invocation — importing
// this module must never write to the tree as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
