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

// Parse the OPEN block into item-keyed (section, id, summary) triples in document
// order. A `## header` line opens a section; blank/continuation lines are dropped
// (the digest is item-keyed). Items before any header get the "Open items" section.
export function parseOpenItems(openText) {
  const items = [];
  let section = 'Open items';
  for (const raw of (openText || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{2,}\s/.test(line)) {
      section = line.replace(/^#+\s*/, '');
      continue;
    }
    const id = parseItemId(line);
    if (!id) continue;
    let summary = line
      .replace(/^\s*[-*]\s*\[[^\]]+\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
    items.push({ section, id, summary });
  }
  return items;
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
