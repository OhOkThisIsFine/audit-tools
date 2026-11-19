#!/usr/bin/env node
// sites-pinned: tests/shared/handoff-roadmap.test.ts
//   The entry parsers' title/line/body shape and the generated blocks are pinned there.
// Regenerate the generated section of `docs/HANDOFF.md`: the ordered ROADMAP
// from the split backlog (`docs/backlog/*.md`).
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
// SCOPE — IMMEDIATE NEXT ONLY. The generated block carries the entries PINNED
// with `PIN_MARKER` (`▶`) and nothing else. It once emitted every open item, ~110
// of them, which made HANDOFF a second index competing with `docs/backlog.md`'s
// seek index and rebuilt the "read HANDOFF to see everything" habit the split
// backlog exists to end. `CLAUDE.md` scopes this doc to the immediate next step;
// the exhaustive list contradicted its own header.
//
// Selection is therefore DECLARED, not derived: prefix an entry's bold title with
// `▶` in the backlog file that owns it. That is a one-character single-home edit
// in the doc that already holds the item, so promoting the next piece of work
// never means editing HANDOFF. Order among the pinned stays document order
// (source rank from `ROADMAP_SOURCES`, then position in file), so a pinned set
// larger than one still has a stable sequence.
//
// An EMPTY block is a valid, meaningful state — "nothing is pinned" — and says so
// in words rather than rendering as an absent section, which would be
// indistinguishable from a generator that never ran.
//
// HAND-WRITTEN HYGIENE (sol-5 / P30). The generated blocks stopped SPEC drift,
// but changelog narration regrew in the HAND-WRITTEN region too — a dated
// bullet, "P25 … is LANDED" paragraphs, a "## Verification state" section. So
// `--check` also refuses the OBSERVED creep shapes in the hand-written region
// (`HANDWRITTEN_CREEP_RULES` below), and write mode refuses to regenerate
// around them: trim the hand-written line first, then rerun. A shape-catch,
// not semantics — prose that avoids the shapes passes.
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
import { rebaseRelativeLinks } from "./rebase-relative-links.mjs";
import { parseBacklogDocument } from "./backlog-entry-grammar.mjs";
import { spliceGeneratedBlock as sharedSpliceGeneratedBlock } from "./generatedArtifacts.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  { file: "open-bugs.md", kind: "bullets" },
  { file: "forward-tracks.md", section: "Open tracks", kind: "tracks" },
  { file: "forward-tracks.md", section: "Forward tracks", kind: "bullets" },
  { file: "deferred.md", kind: "bullets" },
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
 * Split backlog text into its top-level `- **…` entries. Entry boundaries come
 * from the shared grammar in `./backlog-entry-grammar.mjs`, so this and the
 * budget gate cannot disagree on what an entry is; only the title derivation is
 * local (the roadmap needs the verbatim bold run).
 */
export function parseBulletEntries(text, file = "<text>") {
  return parseBacklogDocument(text).entries.map(({ line, body }) => ({
    title: boldTitle(body, { where: `${file}:${line}`, opener: "- " }),
    line,
    // The entry's own text, carried for consumers that need more than the
    // title (the backlog index's live-run watch matrix lifts each entry's
    // `Live-run watch` line). The roadmap itself never reads it — a pointer
    // that restates an entry is the defect it exists to remove.
    body,
  }));
}

/**
 * `forward-tracks.md`'s *Open tracks* section writes its entries as bold
 * paragraphs (`**Title …**`) rather than `- **…**` bullets, whatever their
 * lead-in, so it needs its own reader. Document order reproduces entry sequence.
 */
export function parseTrackEntries(text, file = "<text>") {
  return parseBacklogDocument(text).tracks.map(({ line, body }) => ({
    title: boldTitle(body, { where: `${file}:${line}`, opener: "" }), line, body,
  }));
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
  return sectionBody(lines, start).join("\n");
}

/** The lines after the heading at `start`, up to the next `## ` heading. */
function sectionBody(lines, start) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/**
 * Build the ordered roadmap. `sources` maps a backlog filename to its text, so
 * callers (and tests) can drive this without touching disk.
 */
export function collectRoadmap(sources) {
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
    for (const item of items) {
      if (item.title.startsWith(PIN_MARKER)) pinned.push(item);
    }
  }
  // IMMEDIATE-NEXT-ONLY. `CLAUDE.md` and this doc's own header scope HANDOFF to the
  // immediate next step; an exhaustive 100+ item list is a second index competing
  // with `docs/backlog.md`'s seek index, and it re-created the "read HANDOFF to see
  // everything" habit the split backlog exists to end. Only pinned entries are
  // emitted; every source is still parsed, so a malformed entry still refuses.
  //
  // The unpinned set is not lost — it is in the backlog, which is its one home, and
  // reachable by the seek index. Pinning is a one-character edit on the entry's bold
  // title in the backlog file that owns it, so promoting the next item never means
  // editing HANDOFF.
  //
  // Always ONE group, even when empty: an absent section reads as "the generator did
  // not run", while an explicit empty one states that nothing is pinned. That is the
  // affirmation half — a success-shaped empty must say so.
  return [{ heading: `${PIN_MARKER} Next up — pinned in the backlog`, items: pinned }];
}

const linkFor = (file) => `[\`${file}\`](backlog/${file})`;

/**
 * A title is lifted VERBATIM out of `docs/backlog/<file>` into `docs/HANDOFF.md`
 * — one directory up — so any relative link inside it must be re-based or it
 * dies at the destination. Fixing the generated file instead is overwritten by
 * the next regeneration.
 */
const liftTitle = (title, file) =>
  rebaseRelativeLinks(title, `docs/backlog/${file}`, "docs/HANDOFF.md");

/** Render the whole generated block, markers included. */
export function renderRoadmap(groups) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const body = groups
    .map(
      (g) =>
        `### ${g.heading}\n\n` +
        (g.items.length === 0
          ? `*(nothing pinned — no immediate next step is set. Every open item is in [\`docs/backlog/\`](backlog/).)*\n`
          : g.items
              .map((i) => `- ${liftTitle(i.title, i.file)} · ${linkFor(i.file)}\n`)
              .join("")),
    )
    .join("\n");

  return (
    `${BEGIN_MARKER}\n` +
    `\n` +
    `> **This list is GENERATED from [\`docs/backlog/\`](backlog/) — do not hand-edit it.**\n` +
    `> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with\n` +
    `> \`${PIN_MARKER}\` in the backlog file that owns it and it appears here; empty means nothing is\n` +
    `> pinned, which is a statement rather than an omission.\n` +
    `> **Every open item lives in [\`docs/backlog/\`](backlog/)**, reachable by the seek index in\n` +
    `> [\`backlog.md\`](backlog.md) — this block is not a second index of it.\n` +
    `> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that\n` +
    `> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.\n` +
    `> Regenerate: \`node scripts/shared/generate-handoff-roadmap.mjs\` (\`--check\` gates it in\n` +
    `> \`verify:checks\` and at commit). ${total} pinned item(s).\n` +
    `\n` +
    body +
    `\n${END_MARKER}`
  );
}

/** Replace the roadmap slot without touching the hand-written HANDOFF text. */
export function spliceRoadmap(handoffText, block) {
  return sharedSpliceGeneratedBlock(handoffText, block, {
    begin: BEGIN_MARKER,
    end: END_MARKER,
    target: "docs/HANDOFF.md (generated-roadmap)",
    validateBlock: true,
  });
}

// ── hand-written creep heuristics (sol-5 / P30) ──────────────────────────────
//
// The hand-written region is everything OUTSIDE the generated marker range.
// The exclusion is mandatory, not tidy: lifted backlog titles legitimately
// carry dates and landing words, so scanning generated text would turn the
// gate red on its own output.
//
// Every rule is grounded in an OBSERVED creep instance (removed in 03468b4a)
// and tuned against the live HANDOFF's legitimate lines so the tree is green
// at land time. Known uncovered halves, stated in the guard-reach registry
// note: mid-line dates ("decided 2026-08-18"), a date as the bullet's second
// word ("- The 2026-08-18 decision batch"), lowercase "are landed" context
// lines, "is COMPLETE", and any novel phrasing.
export const HANDWRITTEN_CREEP_RULES = [
  {
    id: "dated-bullet",
    // A bullet that OPENS with an ISO date is a changelog line by shape:
    // `- 2026-08-12: the day's decision queue was answered in full`. Anchored
    // to the bullet start ON PURPOSE — an anywhere-date form false-positives
    // the live-state context lines above.
    regex: /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\*\*)?\d{4}-\d{2}-\d{2}/,
    hint: "a bullet that opens with a date is a changelog line",
  },
  {
    id: "landed-narrative",
    // CASE-SENSITIVE: the observed creep shouted `is LANDED`; lowercase
    // "are landed" appears in legitimate live context, so /i would misfire.
    regex: /\b(?:is|are) LANDED\b/,
    hint: "past-tense landing narrative",
  },
  {
    id: "shipped-narrative",
    regex: /\bshipped in\b/i,
    hint: "version-attribution narrative — git log owns what shipped where",
  },
  {
    id: "built-first-narrative",
    // Grounded: `Built red-tests-first (7 contract tests)`. Capital B keeps
    // ordinary prose ("built …-first") out of scope.
    regex: /\bBuilt\b.*-first/,
    hint: "how-it-was-built narrative",
  },
  {
    id: "verification-state-heading",
    regex: /^#{1,6}[ \t]+Verification state\b/i,
    hint: "a verification-evidence section is a run record — CI and git log own it",
  },
];

// ── the hand-written Immediate-next length bound ─────────────────────────────
//
// `HANDWRITTEN_CREEP_RULES` catches NARRATIVE SHAPES, and its stated uncovered
// half is "any novel phrasing" — which is exactly how the section regrew as a
// run chronology: a lap paragraph naming P00, seven waves, the routing of each
// lane and the plan directory. None of those lines matched a creep rule, and
// every one of them was status the repository already holds (`git log` for what
// landed, `docs/backlog/` for what is open, the plan directory itself).
//
// A shape-catch cannot close that, and a semantic one is not available at this
// boundary. What IS mechanical is the LENGTH: the section is scoped by its own
// header to the single next action plus the live owner decision, and a
// chronology needs a paragraph where that needs a sentence. So the bound is a
// budget, not a phrasing test — any wording is legal and the section simply may
// not grow. That is the same trade the creep rules make, one level up: it
// cannot say WHICH sentence is the chronology, only that the section has
// stopped being an immediate-next statement.
//
// COUNTED IN WORDS, NOT LINES, and that is load-bearing rather than cosmetic.
// A line count is not invariant under REFLOW: the same paragraph wrapped at 90
// columns instead of 120 is fewer lines, so a line bound is satisfied by not
// wrapping the editor — it would measure the author's wrap width, not the
// section's content. A word count does not move when the text is rewrapped.
//
// TUNED AGAINST MEASURED TEXT, both directions. The legitimate shapes run 8-69
// words: a bare action (8); the live HANDOFF's action + "none" decision, the
// largest shape in the tree today (69); an action plus two open decisions (41).
// The chronology this bound exists to refuse — the 2026-09-10 lap paragraph,
// recoverable verbatim from the `git log` of the commit that cut it — is 105.
// Ninety therefore passes the largest legitimate shape with ~30% headroom while
// refusing the recurrence with ~15% margin, and NEITHER edge moves when the
// prose is rewrapped. Both measurements are pinned in
// `tests/shared/handoff-roadmap.test.ts`, so a bound that drifts into either
// the legitimate or the recurrence range fails there rather than silently
// stopping catching anything.
//
// Not counted, deliberately: HTML comments (the `doc-citation-exempt` marker is
// bookkeeping, not content) and everything inside the generated range (it is
// derived, and this bound is on the HAND-WRITTEN region — in the real HANDOFF
// and in every fixture tree the markers fall under this heading, since they
// carry no `##` of their own).
//
// STATED UNCOVERED HALF: this is a budget, not a semantic test. A chronology
// dense enough to fit inside ninety words passes, and so does a short section
// that names the wrong next action — the bound raises the cost of the
// recurrence and reds the common case, it does not make the section
// immediate-next by construction.
export const IMMEDIATE_NEXT_HEADING = "## Immediate next";

/** The bound, in hand-written words (reflow-invariant). */
export const IMMEDIATE_NEXT_MAX_WORDS = 90;

/**
 * Blank the generated range LINE-PRESERVINGLY, so 1-based line numbers still
 * refer to the original text. Shared by the creep scan and the Immediate-next
 * bound: both are contracts on the HAND-WRITTEN region, and a generated block
 * that happened to sit under the `## Immediate next` heading (which it does in
 * every fixture tree, since the markers carry no `##` of their own) must not be
 * counted as hand-written prose.
 */
function blankGeneratedRanges(lines) {
  const begin = lines.findIndex((l) => l.includes(BEGIN_MARKER));
  if (begin === -1) return lines;
  const end = lines.findIndex((l, i) => i >= begin && l.includes(END_MARKER));
  const stop = end === -1 ? lines.length - 1 : end;
  for (let i = begin; i <= stop; i++) lines[i] = "";
  return lines;
}

/**
 * The body of the hand-written `## Immediate next` section: from the heading to
 * the next `## ` heading. Returns null when the heading is absent — the section
 * is part of HANDOFF's contract, so its absence is itself a refusal.
 */
function immediateNextSection(lines) {
  const start = lines.findIndex((l) => l.trim() === IMMEDIATE_NEXT_HEADING);
  if (start === -1) return null;
  return sectionBody(lines, start);
}

/**
 * The hand-written text of the Immediate-next section, with HTML comments
 * (which may span lines) and the generated range removed. Returns null
 * when the section heading is absent — the section is part of HANDOFF's
 * contract, so its absence is itself a refusal.
 */
function immediateNextText(text) {
  const section = immediateNextSection(blankGeneratedRanges(text.split(/\r?\n/)));
  if (section === null) return null;
  let inComment = false;
  const visible = [];
  for (const line of section) {
    let rest = line;
    if (inComment) {
      const close = rest.indexOf("-->");
      if (close === -1) continue;
      rest = rest.slice(close + 3);
      inComment = false;
    }
    let open = rest.indexOf("<!--");
    while (open !== -1) {
      const close = rest.indexOf("-->", open + 4);
      if (close === -1) {
        inComment = true;
        rest = rest.slice(0, open);
        break;
      }
      rest = rest.slice(0, open) + rest.slice(close + 3);
      open = rest.indexOf("<!--");
    }
    visible.push(rest);
  }
  return visible.join("\n");
}

/**
 * Count the hand-written WORDS of the Immediate-next section. Words, not
 * lines, because a line count moves when the text is merely rewrapped (see
 * IMMEDIATE_NEXT_MAX_WORDS). Returns `{ count }`, or null when the section
 * heading is absent.
 */
export function measureImmediateNext(text) {
  const body = immediateNextText(text);
  if (body === null) return null;
  return { count: body.split(/\s+/).filter(Boolean).length };
}

/**
 * The Immediate-next overrun, or null when the section is within its bound.
 * A MISSING heading is reported as an overrun-shaped refusal of its own, so the
 * CLI has one branch rather than two.
 */
export function findImmediateNextOverrun(text) {
  const measured = measureImmediateNext(text);
  if (measured === null) {
    return { reason: "the section is MISSING", count: 0, bound: IMMEDIATE_NEXT_MAX_WORDS };
  }
  if (measured.count <= IMMEDIATE_NEXT_MAX_WORDS) return null;
  return { reason: "the section is over its bound", ...measured, bound: IMMEDIATE_NEXT_MAX_WORDS };
}

function overrunReport(overrun) {
  return (
    `\ndocs/HANDOFF.md's hand-written \`${IMMEDIATE_NEXT_HEADING}\` ${overrun.reason}: ` +
    `${overrun.count} word(s) against a bound of ${overrun.bound}.\n` +
    `HANDOFF is immediate state and next action only (its own header): that section states the\n` +
    `SINGLE next action plus the live owner decision. A paragraph that narrates a lap — which\n` +
    `packets ran, how each was routed, what already landed — is a chronology, and the repository\n` +
    `already holds it: \`git log\` for what landed, \`docs/backlog/\` for what is open.\n` +
    `Fix: cut the section back to the next action and the live owner decision (say "none" when\n` +
    `nothing is open), and put any detail in the document that owns it. Regenerating does NOT\n` +
    `help — the text is not generated. Rewrapping does not help either: the bound counts words.\n\n`
  );
}

/**
 * Scan the HAND-WRITTEN region for the banned creep shapes. Returns one
 * violation per matching (line, rule) with 1-based line numbers into the
 * ORIGINAL text: the generated range is blanked line-preserving, never removed,
 * so a violation after the generated block still names its real line. Split is
 * `/\r?\n/` and every rule matches per-line — a CRLF working copy must behave
 * exactly like the LF one in CI.
 *
 * Marker validation is not this function's job: callers splice first (the
 * clearer error). An unterminated range is blanked to end-of-file —
 * conservative, and unreachable from the CLI, which throws on broken markers
 * before this runs.
 */
export function findHandwrittenCreep(text) {
  const lines = blankGeneratedRanges(text.split(/\r?\n/));
  const violations = [];
  lines.forEach((line, i) => {
    for (const rule of HANDWRITTEN_CREEP_RULES) {
      if (rule.regex.test(line)) {
        violations.push({ line: i + 1, rule: rule.id, hint: rule.hint, text: line.trim() });
      }
    }
  });
  return violations;
}

function creepReport(violations) {
  const listed = violations
    .map((v) => `  docs/HANDOFF.md:${v.line}: ${v.rule} (${v.hint})\n      ${v.text}`)
    .join("\n");
  return (
    `\ndocs/HANDOFF.md's HAND-WRITTEN region carries changelog creep — ${violations.length} ` +
    `line(s) match a banned shape:\n${listed}\n` +
    `HANDOFF is immediate state and next action only (its own header): shipped-work narration\n` +
    `belongs in git log, the backlog, or project memory. Trim or reword the line — regenerating\n` +
    `does NOT fix hand-written creep.\n\n`
  );
}

function readSources(backlogDir) {
  const files = [...new Set(ROADMAP_SOURCES.map((s) => s.file))];
  return new Map(files.map((f) => [f, readFileSync(join(backlogDir, f), "utf8")]));
}

/**
 * The CLI body, root-parameterized so the contract test can drive it against a
 * throwaway tree in-process (the default root is baked from this file's
 * location, so the spawned CLI always targets the real repo). Returns the
 * process exit code; `out`/`err` receive what the CLI would print.
 */
export function runGenerator({
  root = repoRoot,
  check = false,
  out = (s) => {
    process.stdout.write(s);
  },
  err = (s) => {
    process.stderr.write(s);
  },
} = {}) {
  const handoffPath = join(root, "docs", "HANDOFF.md");
  const roadmapBlock = renderRoadmap(collectRoadmap(readSources(join(root, "docs", "backlog"))));
  const current = readFileSync(handoffPath, "utf8");
  const rendered = spliceRoadmap(current, roadmapBlock);
  // Splicing above has validated the marker topology, so the creep scan's
  // range blanking cannot misfire on broken markers.
  const creep = findHandwrittenCreep(current);
  // ...and the Immediate-next length bound — see IMMEDIATE_NEXT_MAX_WORDS.
  const overrun = findImmediateNextOverrun(current);

  if (check) {
    // Creep is reported FIRST but never masks staleness — both halves print,
    // so one fix-and-retry lap surfaces every problem.
    if (creep.length > 0) err(creepReport(creep));
    if (overrun) err(overrunReport(overrun));
    if (current !== rendered) {
      err(
        `\ndocs/HANDOFF.md's generated state is STALE — it no longer matches docs/backlog/.\n` +
          `A stale generated block is a second, drifting home for state that already has an\n` +
          `authoritative source.\n` +
          `Fix: node scripts/shared/generate-handoff-roadmap.mjs\n\n`,
      );
      return 1;
    }
    if (creep.length > 0 || overrun) return 1;
    const roadmapCount = (rendered.match(/^- .+ · \[`/gm) ?? []).length;
    out(
      `✓ handoff-roadmap: generated HANDOFF state matches its sources ` +
        `(${roadmapCount} roadmap pointer(s)); ` +
        `hand-written region carries no changelog creep, and an ` +
        `Immediate-next section within its ${IMMEDIATE_NEXT_MAX_WORDS}-word bound\n`,
    );
    return 0;
  }

  // The write path refuses on the same contract the check path does: a silent
  // regenerate would leave the offending hand-written line exactly where it was
  // while making the file otherwise green.
  if (overrun) {
    err(overrunReport(overrun));
    err(`refusing to write docs/HANDOFF.md until the section above is cut to its bound.\n`);
    return 1;
  }

  if (creep.length > 0) {
    // The generator must not regenerate AROUND hand-written creep — a silent
    // write would launder the changelog line into the next commit. Trim the
    // hand-written region first, then rerun.
    err(creepReport(creep));
    err(`refusing to write docs/HANDOFF.md until the hand-written creep above is trimmed.\n`);
    return 1;
  }

  writeFileSync(handoffPath, rendered, "utf8");
  out(`wrote ${handoffPath}\n`);
  return 0;
}

// Importable as a library (the contract test drives the pure functions with
// synthetic text), so the CLI body runs ONLY on direct invocation — importing
// this module must never write to the tree as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(runGenerator({ check: process.argv.includes("--check") }));
}
