// Shared reader for the doc-review findings block.
//
// Single-sources the git ref-discovery + OPEN-block extraction + item parse that
// BOTH the SessionStart surface hook (`doc-review-surface.mjs`, which renders the
// digest) and the resolve command (`doc-review-resolve.mjs`, which needs `--list`
// and a "known finding id" set to validate against) rely on. Keeping this in one
// place means the resolve command's notion of which ids are open can never drift
// from what the surface hook shows the operator.
//
// Read-only and best-effort by construction: the git runner is time-boxed and the
// callers swallow failures, so an offline/no-branch environment degrades to an
// empty findings set rather than throwing.
import { execFileSync } from 'node:child_process';
import { parseItemId } from './docReviewLedger.mjs';

export const BRANCH = 'doc-review';
export const FILE = 'doc-review-findings.md';
const START = '<!-- DOC-REVIEW-OPEN:START -->';
const END = '<!-- DOC-REVIEW-OPEN:END -->';
// A summary longer than this is truncated with an ellipsis in the digest/list.
export const SUMMARY_MAX = 150;

// A time-boxed git runner bound to the project dir. `windowsHide` so a windowless
// hook parent spawning a console child (git) never flashes a console window on
// win32 — the surface hook fires at every SessionStart.
export function makeGit(cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  return (args, timeout) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      windowsHide: true,
    });
}

// Discover the configured remote(s) — never hardcode a remote name (this repo's is
// `audit-tools`, not `origin`; hardcoding `origin` silently killed the surface hook).
export function discoverRemotes(git) {
  try {
    return git(['remote'], 3000).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  } catch {
    return []; // no git / no remotes — callers fall back to local refs
  }
}

// Refresh the remote doc-review ref, time-boxed so an unreachable remote can't
// stall session start. Best-effort: stops at the first remote that has the branch.
export function fetchDocReview(git, remotes) {
  for (const remote of remotes) {
    try {
      git(['fetch', '--quiet', '--depth=1', remote, BRANCH], 5000);
      return;
    } catch {
      /* offline / no such branch on this remote — try the next */
    }
  }
}

// Read findings.md from the newest ref that actually carries the file, newest
// first (remote tracking refs → local branch → FETCH_HEAD). Confirms the ref
// carries the file before trusting its SHA. Returns { body, usedRef, sha } or null.
export function readFindings(git, remotes) {
  const refs = [
    ...remotes.map((r) => `refs/remotes/${r}/${BRANCH}`),
    BRANCH,
    'FETCH_HEAD',
  ];
  for (const ref of refs) {
    try {
      const body = git(['show', `${ref}:${FILE}`], 5000);
      if (!body) continue;
      let sha = '';
      try {
        sha = git(['rev-parse', ref], 3000).trim();
      } catch {
        /* body but no SHA — resolvedIdsFor('') just filters nothing */
      }
      return { body, usedRef: ref, sha };
    } catch {
      /* try next ref */
    }
  }
  return null;
}

// Extract the text between the OPEN markers. Returns '' when the markers are
// absent/malformed, the block is empty, or it holds only headers (no list items).
export function extractOpenText(body) {
  if (!body) return '';
  const i = body.indexOf(START);
  const j = body.indexOf(END);
  if (i === -1 || j === -1 || j <= i) return '';
  const open = body.slice(i + START.length, j).trim();
  if (!open || !/^\s*[-*]\s/m.test(open)) return '';
  return open;
}

// Parse the OPEN block into item-keyed (section, id, summary, body) records in
// document order. A `## header` line opens a section; a `- [id] …` line opens an
// item; subsequent non-item, non-header, non-blank lines are the item's WRAPPED
// CONTINUATION prose (the contract writes one logical item per bullet, hard-wrapped)
// and are folded into `body` joined by single spaces. `summary` stays the
// first-line-only, SUMMARY_MAX-truncated form the resolve command's `--list`
// renders; `body` is the full item text the surface hook's decision table needs.
// Items before any header get the "Open items" section.
export function parseOpenItems(openText) {
  const items = [];
  let section = 'Open items';
  let current = null;
  for (const raw of (openText || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{2,}\s/.test(line)) {
      section = line.replace(/^#+\s*/, '');
      current = null;
      continue;
    }
    const id = parseItemId(line);
    if (id) {
      const firstLine = line
        .replace(/^\s*[-*]\s*\[[^\]]+\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      let summary = firstLine;
      if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
      current = { section, id, summary, body: firstLine };
      items.push(current);
      continue;
    }
    const continuation = line.replace(/\s+/g, ' ').trim();
    if (current && continuation.length > 0) {
      current.body += ' ' + continuation;
    } else if (continuation.length === 0) {
      // A blank line ends the current item's continuation run (contract items are
      // single bullets; a paragraph break means we're between items/prose).
      current = null;
    }
  }
  return items;
}

// Render the open items as per-section markdown TABLES carrying each item's FULL
// body, so the operator can decide every item from the surfaced text alone — no
// `git show` round-trip. Single-sourced here so the surface hook's rendering and
// any future consumer (e.g. a `--table` flag on the resolve command) cannot drift.
// Table cells cannot hold raw pipes or newlines: pipes are escaped and bodies are
// already single-line by the parse's continuation fold.
// `bodyCap` (chars) clips each item's cell text with an ellipsis — the budgeted
// surface path uses it; the default renders full bodies (fallback-file form).
export function renderOpenItemsMarkdown(items, bodyCap = Infinity) {
  const sections = [];
  for (const it of items) {
    let section = sections.find((s) => s.title === it.section);
    if (!section) {
      section = { title: it.section, items: [] };
      sections.push(section);
    }
    section.items.push(it);
  }
  const out = [];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    out.push('', `### ${section.title} (${section.items.length})`, '');
    out.push('| ID | Item |', '| --- | --- |');
    for (const it of section.items) {
      const cell = clipText(it.body || it.summary || '', bodyCap).replace(/\|/g, '\\|');
      out.push(`| ${it.id} | ${cell} |`);
    }
  }
  return out.join('\n');
}

function clipText(text, cap) {
  if (!Number.isFinite(cap) || text.length <= cap) return text;
  return text.slice(0, Math.max(1, cap - 1)).trimEnd() + '…';
}

// The harness inlines hook stdout only up to ~10KB; anything larger is persisted
// to a side file and the session sees a one-line preview instead of the tables
// (observed at 10.1KB; the older regression clipped at 13.8KB). Staying safely
// under the threshold is therefore part of the output contract: a render that
// exceeds it is INVISIBLE, which defeats the zero-roundtrip purpose entirely.
export const INLINE_BUDGET_BYTES = 9_000;

// Per-item body caps tried in order until the whole output fits the budget.
// Infinity first: when everything fits, full text surfaces (the ideal case).
const BODY_CAPS = [Infinity, 1600, 1200, 900, 700, 500, 350, 250, 180, 120];

// Build the surface hook's stdout: the largest rendering of the decision tables
// that fits `budgetBytes`, degrading per-item body text (never dropping items or
// IDs) and announcing the clip + where the full text lives. Returns
// { output, fullOutput, clipped, bodyCap } — `fullOutput` is the uncapped form
// for the on-disk fallback copy.
export function buildSurfaceOutput(items, {
  fallbackRelPath,
  sourceNote = '',
  budgetBytes = INLINE_BUDGET_BYTES,
} = {}) {
  const headerFor = (clipNote) =>
    `# Open doc-review items (nightly routine) — ${items.length} open\n\n` +
    'Decide each item from the tables below' +
    (clipNote ? '' : ' (full text — no need to open the findings file)') +
    '. Once each is applied/rejected, have me run ' +
    '`node .claude/hooks/doc-review-resolve.mjs <ID>...` so it stops re-surfacing.' +
    (clipNote ? ` ${clipNote}` : '') +
    (sourceNote ? ` ${sourceNote}` : '') +
    '\n';
  const assemble = (cap, clipNote) =>
    headerFor(clipNote) + renderOpenItemsMarkdown(items, cap) + '\n';

  const fullOutput = assemble(Infinity, '');
  let last = fullOutput;
  for (const cap of BODY_CAPS) {
    const clippedCount = Number.isFinite(cap)
      ? items.filter((it) => (it.body || it.summary || '').length > cap).length
      : 0;
    const clipNote =
      clippedCount > 0
        ? `⚠ ${clippedCount} of ${items.length} item texts are clipped to fit the inline size budget — ` +
          `the full tables are in \`${fallbackRelPath}\` (Read it before deciding a clipped item).`
        : '';
    const output = assemble(cap, clipNote);
    last = output;
    if (Buffer.byteLength(output, 'utf8') <= budgetBytes) {
      return { output, fullOutput, clipped: clippedCount > 0, bodyCap: cap };
    }
  }
  // Even the tightest cap is over budget (pathological item count) — emit it
  // anyway; a partially-inlined table still beats silence.
  return { output: last, fullOutput, clipped: true, bodyCap: BODY_CAPS[BODY_CAPS.length - 1] };
}

// Convenience: discover remotes, read findings (NO fetch — the surface hook already
// fetched at session start; the resolve command must stay fast + offline-tolerant),
// and parse the open items. Returns { sha, usedRef, items } or null when no
// findings ref is available. `git` is injectable for tests.
export function collectOpenItems(git = makeGit()) {
  const remotes = discoverRemotes(git);
  const found = readFindings(git, remotes);
  if (!found) return null;
  return {
    sha: found.sha,
    usedRef: found.usedRef,
    items: parseOpenItems(extractOpenText(found.body)),
  };
}
