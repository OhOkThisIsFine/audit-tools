#!/usr/bin/env node
// Regenerate the generated sections of `docs/HANDOFF.md`:
//   1. live nightly decisions from `.audit-tools/nightly/open-items.json`; and
//   2. the ordered ROADMAP from the split backlog (`docs/backlog/*.md`).
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
// not semantics — prose that avoids the shapes passes, and the nightly doc leg
// stays the semantic backstop.
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
import {
  OPEN_ITEMS_RELPATH,
  partitionBySettled,
  readDecisions,
} from "../nightly/items.mjs";
import { rebaseRelativeLinks } from "./rebase-relative-links.mjs";
import { splitBacklogEntries } from "./backlog-entry-grammar.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->";
export const END_MARKER = "<!-- END GENERATED ROADMAP -->";
export const LIVE_STATUS_BEGIN_MARKER =
  "<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->";
export const LIVE_STATUS_END_MARKER = "<!-- END GENERATED LIVE STATUS -->";
const GENERATED_MARKERS = [
  BEGIN_MARKER,
  END_MARKER,
  LIVE_STATUS_BEGIN_MARKER,
  LIVE_STATUS_END_MARKER,
];

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
const NIGHTLY_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const escapeHtmlComments = (s) =>
  s.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");

/**
 * Read the unanswered persisted queue. Decisions are folded here because an
 * answer removes an item from the owner's queue immediately; waiting for the
 * next nightly run to rewrite open-items.json would leave HANDOFF falsely red.
 *
 * This uses the same presentation-time premise filtering as the inbox/session
 * surface, so HANDOFF never points at an item those surfaces have auto-closed.
 * The pre-commit gate derives the current probe-source paths from this same
 * persisted queue and runs parity when one changes.
 */
export function readOpenNightlyItems(root) {
  const queuePath = join(root, OPEN_ITEMS_RELPATH);
  let state;
  try {
    state = JSON.parse(readFileSync(queuePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${OPEN_ITEMS_RELPATH} is missing or invalid JSON; refusing to render an empty HANDOFF queue ` +
        `from unreadable state (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!state || typeof state !== "object" || !Array.isArray(state.items)) {
    throw new Error(`${OPEN_ITEMS_RELPATH}: expected an object with an items array.`);
  }
  const ids = new Set();
  const subjectKeys = new Set();
  state.items.forEach((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      item.id.trim() === "" ||
      item.id !== item.id.trim() ||
      !NIGHTLY_ITEM_ID.test(item.id) ||
      typeof item.title !== "string" ||
      item.title.trim() === "" ||
      typeof item.subject_key !== "string" ||
      item.subject_key.trim() === "" ||
      item.subject_key !== item.subject_key.trim()
    ) {
      throw new Error(
        `${OPEN_ITEMS_RELPATH}: items[${index}] must carry a canonical id ` +
          `([A-Za-z0-9._-]), plus non-empty string title and subject_key fields.`,
      );
    }
    const id = item.id.trim();
    const subjectKey = item.subject_key.trim();
    if (ids.has(id)) {
      throw new Error(`${OPEN_ITEMS_RELPATH}: duplicate item id "${id}".`);
    }
    if (subjectKeys.has(subjectKey)) {
      throw new Error(
        `${OPEN_ITEMS_RELPATH}: duplicate subject_key "${subjectKey}" would let one decision ` +
          `hide multiple items.`,
      );
    }
    ids.add(id);
    subjectKeys.add(subjectKey);
  });
  return partitionBySettled(state.items, readDecisions(root), root).open;
}

/**
 * Render generated POINTERS into the full answering surface. Empty means only
 * generic live-status delimiters: HANDOFF contains no visible nightly text and
 * no nightly-specific source marker.
 */
export function renderNightlyQueue(items) {
  if (!Array.isArray(items)) {
    throw new Error("renderNightlyQueue: items must be an array");
  }
  if (items.length === 0) {
    return `${LIVE_STATUS_BEGIN_MARKER}\n${LIVE_STATUS_END_MARKER}`;
  }

  const pointers = items.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      item.id.trim() === "" ||
      item.id !== item.id.trim() ||
      !NIGHTLY_ITEM_ID.test(item.id) ||
      typeof item.title !== "string" ||
      item.title.trim() === ""
    ) {
      throw new Error(
        `${OPEN_ITEMS_RELPATH}: items[${index}] must carry a canonical id ` +
          `([A-Za-z0-9._-]) and a non-empty string title.`,
      );
    }
    return `  - \`${item.id}\` — ${escapeHtmlComments(collapse(item.title))}`;
  });
  const count = items.length;
  const waiting = count === 1 ? "decision is" : "decisions are";
  return (
    `${LIVE_STATUS_BEGIN_MARKER}\n\n` +
    `- **${count} nightly ${waiting} waiting.** Answer in ` +
    `[\`nightly-inbox.md\`](nightly-inbox.md); settled items disappear from this generated block.\n` +
    `${pointers.join("\n")}\n\n` +
    `${LIVE_STATUS_END_MARKER}`
  );
}

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
  return splitBacklogEntries(text).map(({ line, body }) => ({
    title: boldTitle(body, { where: `${file}:${line}`, opener: "- " }),
    line,
  }));
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
  // IMMEDIATE-NEXT-ONLY. `CLAUDE.md` and this doc's own header scope HANDOFF to the
  // immediate next step; an exhaustive 100+ item list is a second index competing
  // with `docs/backlog.md`'s seek index, and it re-created the "read HANDOFF to see
  // everything" habit the split backlog exists to end. `groups` is therefore
  // DISCARDED: only pinned entries are emitted.
  //
  // The unpinned set is not lost — it is in the backlog, which is its one home, and
  // reachable by the seek index. Pinning is a one-character edit on the entry's bold
  // title in the backlog file that owns it, so promoting the next item never means
  // editing HANDOFF.
  //
  // Always ONE group, even when empty: an absent section reads as "the generator did
  // not run", while an explicit empty one states that nothing is pinned. That is the
  // affirmation half — a success-shaped empty must say so.
  void groups;
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

/** Replace one delimited block in HANDOFF, leaving all other bytes untouched. */
function spliceGeneratedBlock(handoffText, block, beginMarker, endMarker, label) {
  const blockBegin = block.indexOf(beginMarker);
  const blockEnd = block.indexOf(endMarker);
  if (
    blockBegin !== 0 ||
    blockEnd === -1 ||
    blockEnd + endMarker.length !== block.length ||
    block.indexOf(beginMarker, beginMarker.length) !== -1 ||
    block.indexOf(endMarker, blockEnd + endMarker.length) !== -1
  ) {
    throw new Error(
      `replacement generated-${label} block must contain exactly one outer marker pair; ` +
        `refusing marker-shaped generated content.`,
    );
  }
  for (const marker of GENERATED_MARKERS) {
    if (marker !== beginMarker && marker !== endMarker && block.includes(marker)) {
      throw new Error(
        `replacement generated-${label} block contains a marker owned by another generated slot; ` +
          `refusing marker-shaped generated content.`,
      );
    }
  }
  const begin = handoffText.indexOf(beginMarker);
  const end = handoffText.indexOf(endMarker);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `docs/HANDOFF.md is missing the generated-${label} markers (or they are out of order).\n` +
        `Restore this pair around the generated block:\n  ${beginMarker}\n  ${endMarker}`,
    );
  }
  const anotherBegin = handoffText.indexOf(beginMarker, begin + beginMarker.length);
  const anotherEnd = handoffText.indexOf(endMarker, end + endMarker.length);
  if (anotherBegin !== -1 || anotherEnd !== -1) {
    throw new Error(
      `docs/HANDOFF.md contains multiple generated-${label} markers; refusing to choose one block.`,
    );
  }
  return handoffText.slice(0, begin) + block + handoffText.slice(end + endMarker.length);
}

/** Replace the live-status slot without touching the hand-written Live state. */
export function spliceLiveStatus(handoffText, block) {
  return spliceGeneratedBlock(
    handoffText,
    block,
    LIVE_STATUS_BEGIN_MARKER,
    LIVE_STATUS_END_MARKER,
    "live-status",
  );
}

/** Replace the roadmap slot without touching the hand-written HANDOFF text. */
export function spliceRoadmap(handoffText, block) {
  return spliceGeneratedBlock(handoffText, block, BEGIN_MARKER, END_MARKER, "roadmap");
}

/** Assert that the two generated slots occur once each and never nest/overlap. */
export function assertGeneratedTopology(handoffText) {
  const pairs = [
    [LIVE_STATUS_BEGIN_MARKER, LIVE_STATUS_END_MARKER, "live-status"],
    [BEGIN_MARKER, END_MARKER, "roadmap"],
  ];
  const ranges = pairs.map(([beginMarker, endMarker, label]) => {
    const begin = handoffText.indexOf(beginMarker);
    const end = handoffText.indexOf(endMarker);
    if (
      begin === -1 ||
      end < begin ||
      handoffText.indexOf(beginMarker, begin + beginMarker.length) !== -1 ||
      handoffText.indexOf(endMarker, end + endMarker.length) !== -1
    ) {
      throw new Error(
        `docs/HANDOFF.md must contain exactly one ordered generated-${label} marker pair.`,
      );
    }
    return { begin, end: end + endMarker.length, label };
  });
  const [first, second] = ranges.sort((a, b) => a.begin - b.begin);
  if (first.end > second.begin) {
    throw new Error(
      `docs/HANDOFF.md generated slots overlap (${first.label} contains ${second.label}); ` +
        `restore two disjoint blocks.`,
    );
  }
  return handoffText;
}

// ── hand-written creep heuristics (sol-5 / P30) ──────────────────────────────
//
// The hand-written region is everything OUTSIDE the two generated marker
// ranges. The exclusion is mandatory, not tidy: nightly pointer titles and
// lifted backlog titles legitimately carry dates and landing words (the
// 2026-08-13 creep sat INSIDE the live-status block), so scanning generated
// text would turn the gate red on its own output.
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

const GENERATED_RANGE_PAIRS = [
  [LIVE_STATUS_BEGIN_MARKER, LIVE_STATUS_END_MARKER],
  [BEGIN_MARKER, END_MARKER],
];

/**
 * Scan the HAND-WRITTEN region for the banned creep shapes. Returns one
 * violation per matching (line, rule) with 1-based line numbers into the
 * ORIGINAL text: generated ranges are blanked line-preserving, never removed,
 * so a violation after a generated block still names its real line. Split is
 * `/\r?\n/` and every rule matches per-line — a CRLF working copy must behave
 * exactly like the LF one in CI.
 *
 * Marker validation is not this function's job: callers splice/assert topology
 * first (the clearer error). An unterminated range is blanked to end-of-file —
 * conservative, and unreachable from the CLI, which throws on broken markers
 * before this runs.
 */
export function findHandwrittenCreep(text) {
  const lines = text.split(/\r?\n/);
  for (const [beginMarker, endMarker] of GENERATED_RANGE_PAIRS) {
    const begin = lines.findIndex((l) => l.includes(beginMarker));
    if (begin === -1) continue;
    const end = lines.findIndex((l, i) => i >= begin && l.includes(endMarker));
    const stop = end === -1 ? lines.length - 1 : end;
    for (let i = begin; i <= stop; i++) lines[i] = "";
  }
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
  const nightlyItems = readOpenNightlyItems(root);
  const liveStatusBlock = renderNightlyQueue(nightlyItems);
  const roadmapBlock = renderRoadmap(collectRoadmap(readSources(join(root, "docs", "backlog"))));
  const current = readFileSync(handoffPath, "utf8");
  const rendered = assertGeneratedTopology(
    spliceRoadmap(
      spliceLiveStatus(current, liveStatusBlock),
      roadmapBlock,
    ),
  );
  // Splicing above has validated the marker topology, so the creep scan's
  // range blanking cannot misfire on broken markers.
  const creep = findHandwrittenCreep(current);

  if (check) {
    // Creep is reported FIRST but never masks staleness — both halves print,
    // so one fix-and-retry lap surfaces every problem.
    if (creep.length > 0) err(creepReport(creep));
    if (current !== rendered) {
      err(
        `\ndocs/HANDOFF.md's generated state is STALE — it no longer matches the nightly queue,\n` +
          `decision ledger, and/or docs/backlog/. A stale generated block is a second, drifting\n` +
          `home for state that already has an authoritative source.\n` +
          `Fix: node scripts/shared/generate-handoff-roadmap.mjs\n\n`,
      );
      return 1;
    }
    if (creep.length > 0) return 1;
    const roadmapCount = (rendered.match(/^- .+ · \[`/gm) ?? []).length;
    out(
      `✓ handoff-roadmap: generated HANDOFF state matches its sources ` +
        `(${nightlyItems.length} nightly pointer(s), ${roadmapCount} roadmap pointer(s)); ` +
        `hand-written region carries no changelog creep\n`,
    );
    return 0;
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
