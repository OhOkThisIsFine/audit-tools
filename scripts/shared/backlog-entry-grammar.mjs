// The ONE definition of "a backlog entry", shared by the budget gate
// (scripts/check-backlog-budget.mjs) and the roadmap/seek-index generators
// (scripts/shared/generate-handoff-roadmap.mjs). Both files previously carried a
// byte-identical copy of this segmentation loop, kept honest by a drift test that
// compared their entry COUNTS — one grammar removes the need for either.
//
// What is deliberately NOT shared: how each consumer derives an entry's title.
// The budget gate's title is a PERSISTED identity — `entryKey()` writes it into
// docs/backlog/.size-baseline.json, where the recorded keys carry its 78-char
// truncation. The roadmap needs the verbatim multi-line bold run instead. Making
// those one function would silently invalidate every grandfathered baseline key.

/**
 * Split backlog text into its top-level entries. An entry opens with a column-0
 * `- **` bullet and runs to the next one (nested bullets and continuation lines
 * belong to the entry above them).
 *
 * @param {string} text
 * @returns {{line: number, headline: string, body: string}[]}
 *   `line` is 1-indexed; `headline` is the opening line alone; `body` is the
 *   entry's full text including its continuation lines.
 */
export function splitBacklogEntries(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    if (/^- \*\*/.test(l)) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return {
      line: start + 1,
      headline: lines[start],
      body: lines.slice(start, end).join("\n"),
    };
  });
}

// ── entry-boundary damage ────────────────────────────────────────────────────
//
// THE INCIDENT. A lap deleted a backlog entry by LINE INDEX, and the count ate
// the NEXT entry's opening marker with it: the neighbour's body survived with no
// bullet opener of its own, so it absorbed into the entry above. Nothing refused
// that. `check:backlog-index` reported green *by construction* — the generator
// counts entries from the same damaged bytes, so it regenerated an index that
// agreed with the damage, and the now-invisible entry was silently absent from
// the seek index, the size budget, and the HANDOFF roadmap at once. The measured
// rule the incident produced: anchor a deletion on the next entry opener, never
// on a line count.
//
// The property the entry states is the one enforced here: an entry that lost its
// opener, or a stray continuation line belonging to no entry, is a RED —
// independent of the index generator, because the index generator cannot see it.

/** A top-level entry opener: a column-0 `- **` bullet. */
const ENTRY_OPENER = /^- \*\*/;
/** A section heading, which resets the paragraph-entry grammar below it. */
const SECTION_HEADING = /^## /;
/**
 * A bullet that opens a bold run at an INDENT — the same shape a top-level entry
 * has, one level in. The residue a lost opener leaves behind.
 */
const INDENTED_BULLET_OPENER = /^[ \t]+- \*\*/;
/**
 * A column-0 bold turn with no bullet in front: the other residue of the same
 * deletion, where only the `- ` was eaten and the bold title was left as prose.
 */
const COLUMN_ZERO_BOLD = /^\*\*/;
/** An indented line carrying text — the shape of a continuation. */
const INDENTED_TEXT = /^[ \t]+\S/;

/**
 * Is this indented bullet a TITLE, or a nested bullet with inline emphasis?
 *
 * The distinction the check rests on, and the only one available from the line
 * alone: an entry's bold run is its whole headline and closes at the end of the
 * line, while a nested bullet's bold is emphasis inside its own prose, which
 * continues past it. Both open the same way, so the CLOSING is what separates
 * them.
 */
function isTitleShapedIndentedBullet(line) {
  const m = /^[ \t]+- \*\*(.+)$/.exec(line);
  if (!m) return false;
  return /\*\*[ \t]*$/.test(m[1]);
}

/**
 * The paragraph-entry grammar an `## Open tracks` section uses: its entries are
 * bold paragraphs at column 0 rather than bullets.
 *
 * This is a DECLARED property of the document, not a guess —
 * `generate-handoff-roadmap.mjs` reads that one section with `parseTrackEntries`
 * under the same rule for the same reason. Restating the heading here rather
 * than importing that parser keeps this module free of an import cycle (the
 * roadmap generator already imports THIS one), and the two are pinned together
 * by the seek-index contract test.
 */
const PARAGRAPH_ENTRY_SECTION = /^## Open tracks\b/;

/**
 * Find the entry-boundary damage that {@link splitBacklogEntries} silently
 * absorbs.
 *
 * WHY THIS IS AN EXPORT AND NOT A THROWER. The grammar function's contract is
 * "split whatever bytes you are given"; every consumer of it is a READER (budget
 * gate, roadmap title lift, seek index), and a reader that refuses to read is
 * useless in exactly the situation that needs it. The detector therefore stands
 * beside it, and the ONE gate that must refuse — the seek-index check, whose
 * whole subject is "which entries exist" — calls it before rendering. Throwing
 * inside {@link splitBacklogEntries} would have fired the same refusal from the
 * budget gate and the roadmap lift as well, surfacing one edit as three reds at
 * three boundaries and blurring which one owns the defect.
 *
 * WHAT IS DETECTED. Two residues, both from the same deletion incident:
 *   1. `lost_opener` — a title-shaped indented bullet (bold run, nothing after
 *      it). A real top-level entry is at column 0, and a real nested bullet
 *      carries prose past its bold. This is an entry that lost its opener and is
 *      now nested inside its neighbour.
 *   2. `stray_continuation` — text that continues an entry which does not exist
 *      above it. Three shapes, and the THIRD is the one with no other tell:
 *        (a) a column-0 bold turn with no bullet in front — the `- ` was eaten
 *            and the title is now a paragraph inside its neighbour;
 *        (b) an indented line before the file's first entry — front matter is
 *            unindented throughout, so this line has no owner at all;
 *        (c) a PARAGRAPH that opens indented, i.e. an indented prose line
 *            immediately after a blank one. Within one entry an indented line
 *            always follows another indented line (the continuation-paragraph
 *            form), so a paragraph that OPENS indented is a paragraph of an
 *            entry whose `- **Title**` line is gone. Measured on the 2026-08-30
 *            incident replayed against the live `open-bugs.md`: the splitter's
 *            entry count drops 77 → 76, the surviving text is perfectly valid
 *            Markdown, and this is the ONLY thing that sees it — which is why
 *            the leg exists rather than trusting a structural reader.
 *      All three mean text belonging to no entry, so it is unreachable from the
 *      seek index, the budget meter, and the roadmap at once.
 *
 * THE UNCOVERED HALF, stated because a partly-enforced trap is not deletable:
 * this is a SHAPE catch. An entry deleted together with its opener leaves no
 * residue to find — the text is simply gone, and no reader can detect an absence
 * it was never shown. What it catches is damage that LEAVES something behind.
 * The semantic half — "these lines still belong to the entry they were written
 * for" — is not available at this boundary (it would need the intended entry
 * boundaries, which is the thing that was destroyed) and is not claimed.
 *
 * SCOPE. An `## Open tracks` section is exempt from the column-0-bold rule,
 * because that section legitimately writes its entries as bare bold paragraphs;
 * the `lost_opener` rule applies in both. Feeding this a section SLICE is
 * therefore wrong for `forward-tracks.md` — pass the whole file.
 *
 * @param {string} text
 * @returns {{kind: 'lost_opener' | 'stray_continuation', line: number, text: string}[]}
 *   1-indexed `line` into `text`; `text` is the offending line, trimmed.
 */
export function findEntryBoundaryDamage(text) {
  const lines = text.split(/\r?\n/);
  const damaged = [];
  let seenEntry = false;
  let paragraphEntries = false;
  /** Was the PREVIOUS line blank? See the paragraph-start rule below. */
  let afterBlank = false;
  lines.forEach((line, i) => {
    if (SECTION_HEADING.test(line)) {
      paragraphEntries = PARAGRAPH_ENTRY_SECTION.test(line);
      // A section heading ends the previous section's entry run: whatever
      // follows opens a fresh one, and a `**Bold` paragraph here is the
      // declared grammar rather than a stray continuation.
      seenEntry = seenEntry || paragraphEntries;
      afterBlank = false;
      return;
    }
    if (ENTRY_OPENER.test(line)) {
      seenEntry = true;
      afterBlank = false;
      return;
    }
    if (INDENTED_BULLET_OPENER.test(line)) {
      // A nested bullet's bold is inline emphasis; a TITLE-shaped one closes at
      // end of line, which is the shape an entry opener has — at the wrong indent.
      if (isTitleShapedIndentedBullet(line)) {
        damaged.push({ kind: "lost_opener", line: i + 1, text: line.trim() });
      }
      afterBlank = false;
      return;
    }
    if (COLUMN_ZERO_BOLD.test(line) && !paragraphEntries) {
      // A `**Bold` paragraph at column 0 outside the paragraph-entry section is
      // a continuation line whose opener is gone: it continues an entry while
      // opening a new one's shape.
      damaged.push({ kind: "stray_continuation", line: i + 1, text: line.trim() });
      afterBlank = false;
      return;
    }
    if (line.trim() === "") {
      afterBlank = true;
      return;
    }
    // THE PARAGRAPH-START RULE — the shape the deletion incident actually leaves.
    //
    // An entry written `- **Title** …` runs `\n\n  <paragraph>` for each
    // continuation paragraph, so within ONE entry an indented line always
    // follows ANOTHER INDENTED line. A paragraph that OPENS indented — the line
    // right after a blank one — is therefore a paragraph of an entry whose
    // opener is not there: the body survived, the `- **Title**` line was
    // deleted, and the text has been absorbed into whichever entry precedes it.
    // This is the residue with no other tell (measured on the 2026-08-30
    // incident replayed against the live file: the splitter's entry count drops
    // 77 → 76 and NOTHING looks malformed — the swallowed text is simply
    // indented, which every continuation line is).
    //
    // Before the file's first entry the same reasoning is stronger: front matter
    // (`# Title`, the `>` preamble, a `##` heading) is unindented throughout, so
    // the first indented line has no owner at all.
    //
    // LISTS ARE EXCLUDED, deliberately. An indented BULLET is a list item, and a
    // list may legally open after a blank line inside an entry — that is the
    // indent of a list, not the indent of a paragraph whose title was eaten. The
    // rule is about PROSE that opens indented, which is the only shape a
    // surviving body can have.
    if (INDENTED_TEXT.test(line) && !/^[ \t]+[-*+]/.test(line) && (!seenEntry || afterBlank)) {
      damaged.push({ kind: "stray_continuation", line: i + 1, text: line.trim() });
    }
    afterBlank = false;
  });
  return damaged;
}

const DAMAGE_LABEL = {
  lost_opener:
    "an entry opener at an INDENT — this entry lost its column-0 `- **`, so it is " +
    "now a nested bullet of the entry above and no longer an entry at all",
  stray_continuation:
    "a continuation line belonging to NO entry — nothing above it opens an entry, " +
    "so this text is unreachable from the seek index, the size budget and the roadmap",
};

/**
 * The refusal text for entry-boundary damage. Shared by every caller that must
 * refuse it, so no two boundaries can phrase the same defect differently.
 *
 * @param {{kind: 'lost_opener' | 'stray_continuation', line: number, text: string}[]} damaged
 * @param {string} where the file the damage was found in, repo-relative
 */
export function renderEntryBoundaryDamage(damaged, where) {
  return (
    `${where} carries ${damaged.length} entry-boundary defect(s):\n` +
    damaged
      .map((d) => `  ${where}:${d.line}: ${DAMAGE_LABEL[d.kind]}\n      ${d.text}`)
      .join("\n") +
    `\nAn entry that lost its opener is still valid Markdown, so nothing else refuses it — but\n` +
    `it has stopped BEING an entry: it is no longer indexed, budgeted, or lifted into the\n` +
    `roadmap. Restore the column-0 \`- **\`. When deleting an entry, anchor the deletion on the\n` +
    `next \`- **\` rather than on a line count — a count is what ate the neighbour's opener.\n`
  );
}
