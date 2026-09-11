#!/usr/bin/env node
// Refuse a `friction:` tag in docs/backlog/ that is not drawn from the canonical
// category vocabulary.
//
// WHY. Every backlog entry states the friction CATEGORY it belongs to —
// `(2026-08-30, low, friction: tool_should_decide)` — and that tag is the one field a
// closeout walk or a triage sweep would GROUP BY. Nothing read it. So while
// `check:friction-categories` held the generated module in step with its TypeScript
// source (`FRICTION_CATEGORIES`, src/shared/friction/frictionRecord.ts), the tags
// written INTO the backlog drifted freely: `false_red`, `false_green`, `hermeticity`,
// `tooling_gap`, `missing_affordance`, `tool`, `inefficient` — several of them
// synonyms of each other, five of them outside the vocabulary entirely. A grouping
// over an unchecked vocabulary is silently incomplete, and silent incompleteness is
// the failure mode this repo refuses to leave to a reader's memory.
//
// THE ONE VOCABULARY IS IMPORTED, NEVER RESTATED. The canonical three live in
// TypeScript (`FRICTION_CATEGORIES` in src/shared/friction/frictionRecord.ts); the
// closeout renderer chain reads the generated sibling
// (`scripts/shared/friction-categories.generated.mjs`) because it must run in a
// checkout that has never been built — and so does this gate. A hand copy here would
// be the fourth home for a three-item list.
//
// WHAT IS ACCEPTED. A tag is a single whitespace-free word, so a category id is
// written with its own underscore (`tool_should_decide`) or, in the drift the corpus
// actually produced, hyphenated (`tool-should-decide`). Both are accepted, and the
// hyphen form is DERIVED from the canonical id rather than listed: a new canonical
// category accepts its own hyphen spelling with no edit here.
//
// AN UNTAGGED ENTRY IS NOT A VIOLATION. The tag is a grouping aid, not a required
// field: plenty of entries legitimately carry none, and refusing those would make
// this gate a tax on writing a smaller entry than the tag's line allows. What is
// refused is a tag that names a category nothing else in the pipeline knows.
//
//   node scripts/check-backlog-friction-tags.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitBacklogEntries } from "./shared/backlog-entry-grammar.mjs";
import { FRICTION_CATEGORIES } from "./shared/friction-categories.generated.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backlogDir = join(repoRoot, "docs", "backlog");

/**
 * `friction:` followed by the single word that names the category — CLOSED, not
 * merely started.
 *
 * What is refused is the tag FORM, never the bare word, and the closing is what
 * separates the two. A tag is the last member of an entry's parenthetical
 * (`…, friction: tool_should_decide).**`) or the end of its line
 * (`friction: tool_should_decide.`); prose that merely contains the phrase
 * (`Our friction: the analyzer re-runs npx every time`) has neither, so it stays
 * quiet. Detection on the left is the same shape: `no friction:` is a statement
 * about friction, not a tag.
 *
 * The cost of requiring a closing is a MISS, not a false red: a tag written in some
 * third form is not seen. That is the direction this repo always prefers — a gate
 * that cries wolf gets disabled, and then nothing is guarded at all.
 */
export const FRICTION_TAG = /(?<![\w-])friction:\s*([A-Za-z][A-Za-z0-9_-]*)(?![\w-])(?=[*.\s]*\)|[*.\s]*$)/g;

/**
 * Every spelling of a canonical category a tag may use: the id itself, and the
 * hyphenated family the corpus drifted into. Derived, never enumerated.
 */
export const ACCEPTED_TAG_FORMS = new Map(
  FRICTION_CATEGORIES.flatMap((category) => [
    [category, category],
    [category.replace(/_/g, "-"), category],
  ]),
);

/**
 * Every `friction:` tag in one backlog file, in reading order.
 *
 * The entry each tag sits in is attributed through the SHARED entry grammar
 * (`splitBacklogEntries`) — the same segmentation the budget gate and the seek-index
 * generator use — so a tag's owner is never a second, drifting notion of "entry".
 *
 * `(file, text)` rather than an options object: it is the repo's scanner signature
 * (`scanFile(path, content)`), and the guard-form harness drives exactly that shape
 * (`call: 'file-content'`), so the declared form exercises the real recognizer.
 *
 * @param {string} file the backlog file name (only used to label the findings)
 * @param {string} text
 * @returns {{file: string, line: number, column: number, tag: string, entry: string}[]}
 */
export function findFrictionTags(file, text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  // Entry line ranges, in 1-indexed line numbers, from the one grammar.
  const entries = splitBacklogEntries(text);
  const entryAt = (line) => {
    const owner = entries.filter((entry) => entry.line <= line).at(-1) ?? null;
    return owner === null ? "(no entry)" : owner.headline.replace(/^- \*\*/, "").replace(/\*\*/g, "").slice(0, 78);
  };

  lines.forEach((raw, i) => {
    // A fenced block is QUOTED text — a tag shown there is a citation of the
    // vocabulary, not a use of it (same rule the line-number and status gates apply).
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    FRICTION_TAG.lastIndex = 0;
    let match;
    while ((match = FRICTION_TAG.exec(raw)) !== null) {
      found.push({
        file,
        line: i + 1,
        column: match.index + 1,
        tag: match[1],
        entry: entryAt(i + 1),
      });
    }
  });
  return found;
}

/**
 * Evaluate the whole backlog. Pure — takes file contents, returns findings — so the
 * gate's behavior is testable against synthetic corpora instead of by editing the
 * real backlog.
 *
 * @param {{file: string, text: string}[]} files
 * @returns {{violations: string[], tags: number, files: number}}
 */
export function evaluateFrictionTags(files) {
  const violations = [];
  let tags = 0;
  for (const source of files) {
    for (const hit of findFrictionTags(source.file, source.text)) {
      tags += 1;
      if (ACCEPTED_TAG_FORMS.has(hit.tag)) continue;
      violations.push(
        `docs/backlog/${hit.file}:${hit.line}:${hit.column} — \`friction: ${hit.tag}\` is not a ` +
          `friction category\n` +
          `      entry: ${hit.entry}\n` +
          `      canonical: ${FRICTION_CATEGORIES.join(", ")}`,
      );
    }
  }
  return { violations, tags, files: files.length };
}

function main() {
  const files = readdirSync(backlogDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(backlogDir, file), "utf8") }));

  const result = evaluateFrictionTags(files);

  if (result.violations.length === 0) {
    process.stdout.write(
      `✓ backlog-friction-tags: ${result.tags} tag(s) across ${result.files} file(s) all name a ` +
        `canonical friction category\n`,
    );
    return;
  }

  process.stderr.write(
    `\ncheck-backlog-friction-tags: ${result.violations.length} off-vocabulary friction tag(s)\n\n` +
      result.violations.map((v) => `  ${v}`).join("\n") +
      `\n\nThe tag is the field a closeout walk or a triage sweep groups by, so a tag outside the\n` +
      `vocabulary makes every such grouping silently incomplete. Map the tag onto the canonical\n` +
      `category whose DEFINITION it fits — the three are:\n` +
      `  ambiguous_direction  the tool or prompt left a decision to the host that it should have resolved\n` +
      `  tool_should_decide   the host had to remember / notice / enforce something the tool should guarantee\n` +
      `  inefficient_feeding  redundant or wasteful work, poor context feeding, or a tool inefficiency\n` +
      `Do NOT add a category for a tag: the vocabulary is single-sourced in\n` +
      `src/shared/friction/frictionRecord.ts and consumed by the close-out gate, which counts\n` +
      `coverage per category — a fourth category here would be one the renderer never asks for.\n\n` +
      `If the tag is not a category at all but a bare descriptor that reads that way, reword the\n` +
      `line so it is not in ` +
      "`friction: <word>` form.\n\n",
  );
  process.exit(1);
}

// Run only when invoked as a CLI — importing this module must not scan or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
