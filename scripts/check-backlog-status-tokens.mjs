#!/usr/bin/env node
// Refuse status MARKERS in docs/backlog/**.
//
// WHY. Every backlog file's own header says the same thing — "A living to-do list,
// not a status log. Remove an entry once it ships" — and `docs/doc-review-guidelines.md`
// spells the consequence out: a fully-shipped entry is deleted outright, never rewritten
// into a "this shipped" note; a partial entry is trimmed to its open remainder. The rule
// was written down and then not applied: one file accumulated five shipped-stage markers
// whose content was already the design of record in `spec/`, so the same fact was carried
// in two places that decay independently. A rule that lives only in a header is a rule
// the next pass re-litigates. This is the header, enforced.
//
// WHAT IS REFUSED — the marker FORM, never the bare word.
// A sentence may legitimately contain "shipped", "fixed", "done" or "resolved"; the
// backlog is full of them ("the IN-PROCESS half is SHIPPED; the HOST half is what
// remains"), and refusing those would make the gate a tax on writing accurately. What is
// refused is a status word used as a LABEL rather than as a word in a sentence:
//
//   1. a status GLYPH anywhere (U+2705 / U+274C) — decoration with no prose use at all;
//   2. an emphasis run whose text OPENS with an ALL-CAPS status word —
//      `**SHIPPED 2026-07-19.**`, `_FIXED_`;
//   3. a BLOCK-INITIAL line that opens with a status word — `- DONE: …`, or a status word
//      opening a paragraph after a blank line.
//
// Three discriminators do the work, and each was chosen against a measured false positive
// in this very corpus:
//   • POSITION, for rule 3. An earlier draft flagged any line opening with a status word
//     and produced five false REDs — every one a hard-WRAPPED continuation line whose
//     sentence began above it ("…That is what / shipped (`openAiCompatibleProvider.ts`)").
//     Requiring a block start (blank line above, or a list/heading marker) removes the
//     whole class, because prose wraps but a label never does.
//   • CASE, for rule 2. `are **shipped**.` and `a *shipped* file` are emphasis inside a
//     sentence; `**SHIPPED 2026-07-19.**` is a stamp. Sentence case in an emphasis run is
//     prose here, ALL CAPS is a label, and that split is exactly what the corpus shows.
//   • WORD SENSE. `fixed-kind transports` is an adjective; a trailing hyphen disqualifies.
//
// KNOWN RESIDUALS, stated rather than hidden. A sentence-case label that opens a wrapped
// continuation line (`**Fixed for the in-process rolling driver** (commit …)` mid-bullet)
// is NOT caught, and neither is a status word buried after a lead-in inside one emphasis
// run (`**Prerequisite SHIPPED 2026-07-20**`) unless it carries a glyph. Both need "is
// this a sentence?", which is not decidable here. The miss is deliberate: a false RED
// costs more than a false negative, because a gate that cries wolf gets disabled and then
// nothing is guarded at all. Widen only on evidence of the form actually recurring.
//
//   node scripts/check-backlog-status-tokens.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backlogDir = join(repoRoot, "docs", "backlog");

/** Status words refused in LABEL position. Deliberately short — every addition is false-RED surface. */
export const STATUS_WORDS = ["SHIPPED", "DONE", "FIXED", "RESOLVED"];

/** Status glyphs, refused wherever they appear — they have no prose use. */
export const STATUS_GLYPHS = ["✅", "❌"];

const WORD_ALTERNATION = STATUS_WORDS.join("|");
/** Opens with a status word. `(?![\w-])` rejects the compound-adjective sense (`fixed-kind`). */
const OPENS_UPPER = new RegExp(`^(?:${WORD_ALTERNATION})(?![\\w-])`);
const OPENS_ANY_CASE = new RegExp(`^(?:${WORD_ALTERNATION})(?![\\w-])`, "i");

/** Blank out inline code spans, preserving length so columns stay true. A marker QUOTED in
 *  backticks is a citation of the rule, not a violation of it — `docs/backlog.md` may need to
 *  name the forms it forbids. */
function maskCodeSpans(line) {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

/** Emphasis runs, with the offset of their inner text: `**bold**`, `__bold__`, `*em*`, `_em_`. */
function* emphasisRuns(line) {
  const re = /(\*\*|__|\*|_)((?:(?!\1)[\s\S])+?)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    yield { text: m[2], index: m.index + m[1].length };
  }
}

/** Strip blockquote/indent, then any list-item or heading marker, to reach a line's first word. */
const LINE_LEAD = /^[\s>]*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+)?/;
/** A line-opening marker is what makes a line BLOCK-INITIAL even without a blank line above. */
const HAS_BLOCK_MARKER = /^[\s>]*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+)/;

/**
 * Every status MARKER in one file's text.
 * @returns {{line:number, column:number, kind:string, snippet:string}[]}
 */
export function findStatusMarkers(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const line = maskCodeSpans(raw);
    const at = (index, kind, snippet) =>
      found.push({ line: i + 1, column: index + 1, kind, snippet: snippet.trim().slice(0, 78) });

    for (const glyph of STATUS_GLYPHS) {
      let from = 0;
      for (;;) {
        const index = line.indexOf(glyph, from);
        if (index === -1) break;
        at(index, "status glyph", raw);
        from = index + glyph.length;
      }
    }

    for (const run of emphasisRuns(line)) {
      const inner = run.text.replace(/^[\s✅❌️]+/, "");
      if (OPENS_UPPER.test(inner)) at(run.index, "emphasised status label", run.text);
    }

    // Block-initial only: prose WRAPS onto a continuation line, a label never does.
    const blockInitial = HAS_BLOCK_MARKER.test(raw) || (lines[i - 1] ?? "").trim() === "";
    if (!blockInitial) return;
    const lead = raw.match(LINE_LEAD)[0].length;
    const body = line.slice(lead).replace(/^[\s✅❌️*_]+/, "");
    if (OPENS_ANY_CASE.test(body)) at(lead, "leading status label", raw);
  });
  return found;
}

function main() {
  const files = readdirSync(backlogDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const violations = [];
  for (const file of files) {
    for (const hit of findStatusMarkers(readFileSync(join(backlogDir, file), "utf8"))) {
      violations.push(
        `docs/backlog/${file}:${hit.line}:${hit.column} — ${hit.kind}\n      ${hit.snippet}`,
      );
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`✓ backlog-status-tokens: no status markers across ${files.length} file(s)\n`);
    return;
  }

  process.stderr.write(
    `\ncheck-backlog-status-tokens: ${violations.length} status marker(s) in docs/backlog/\n\n` +
      violations.map((v) => `  ${v}`).join("\n") +
      `\n\nThe backlog is a living to-do list, not a status log — every file's header says so.\n` +
      `A fully-closed entry is DELETED, never relabelled; a partial entry is TRIMMED to its\n` +
      `open remainder. Move anything durable to its real home FIRST — design/rationale to the\n` +
      `relevant spec/ doc or project memory, a standing environment gotcha to\n` +
      `docs/backlog/durable-traps.md, a how-to to CLAUDE.md — then delete.\n\n` +
      `Only the LABEL form is refused. A status word inside a sentence is fine; move it out\n` +
      `of the leading position rather than reaching for a synonym.\n\n`,
  );
  process.exit(1);
}

// Run only when invoked as a CLI — importing this module must not scan or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
