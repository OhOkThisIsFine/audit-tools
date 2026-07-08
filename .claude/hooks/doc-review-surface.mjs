#!/usr/bin/env node
//
// SessionStart hook — surface open doc-review escalations.
//
// The nightly doc-review cloud routine pushes its findings to the `doc-review`
// branch. The part that needs the owner (proposed instruction-file edits + design
// decisions) lives between DOC-REVIEW-OPEN markers in doc-review-findings.md.
// This hook reads that block and prints it so it lands in session context.
//
// Read-only and best-effort: any failure (offline, no branch, no git) exits 0
// silently. The fetch is time-boxed so it never blocks session start for long.
// Contract: docs/doc-review-guidelines.md → "Output contract".
//
// Already-applied items are suppressed via the clear-on-apply ledger
// (docReviewLedger.mjs): the host records dispositioned IDs against the
// findings.md commit SHA, and this hook filters them out so a fix that already
// landed on main stops re-surfacing every session — without waiting for the next
// nightly to regenerate the branch.
import { execFileSync } from 'node:child_process';
import { parseItemId, resolvedIdsFor } from './docReviewLedger.mjs';

const BRANCH = 'doc-review';
const FILE = 'doc-review-findings.md';
const START = '<!-- DOC-REVIEW-OPEN:START -->';
const END = '<!-- DOC-REVIEW-OPEN:END -->';

function git(args, timeout) {
  return execFileSync('git', args, {
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
    // win32: a windowless hook parent spawning a console child (git) pops a
    // console window unless suppressed. This hook fires at every SessionStart
    // (and runs `git fetch`), so it flashes a window on each start — hide it.
    windowsHide: true,
  });
}

try {
  // Discover the configured remote(s) — never hardcode a remote name (this repo's
  // is `audit-tools`, not `origin`; hardcoding `origin` silently killed this hook).
  let remotes = [];
  try {
    remotes = git(['remote'], 3000).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  } catch {
    /* no git / no remotes — fall back to local refs below */
  }

  // Refresh the remote ref, time-boxed so an unreachable remote can't stall the
  // session. If it fails we fall back to whatever ref is already local.
  for (const remote of remotes) {
    try {
      git(['fetch', '--quiet', '--depth=1', remote, BRANCH], 5000);
      break;
    } catch {
      /* offline / no such branch on this remote — try the next */
    }
  }

  const refs = [
    ...remotes.map((r) => `refs/remotes/${r}/${BRANCH}`),
    BRANCH,
    'FETCH_HEAD',
  ];
  let body = '';
  let usedRef = '';
  for (const ref of refs) {
    try {
      body = git(['show', `${ref}:${FILE}`], 5000);
      if (body) {
        usedRef = ref;
        break;
      }
    } catch {
      /* try next ref */
    }
  }
  if (!body) process.exit(0);

  const i = body.indexOf(START);
  const j = body.indexOf(END);
  if (i === -1 || j === -1 || j <= i) process.exit(0);

  const open = body.slice(i + START.length, j).trim();
  // Empty block = nothing open. Bullets present = something to surface. Treat a
  // block with only headers (no list items) as empty.
  if (!open || !/^\s*[-*]\s/m.test(open)) process.exit(0);

  // Resolve the findings.md commit SHA so we can filter items the host already
  // dispositioned against THIS generation of the block. Failure → don't filter
  // (surface everything, the pre-ledger behaviour).
  let sha = '';
  try {
    sha = git(['rev-parse', usedRef], 3000).trim();
  } catch {
    /* no SHA → resolvedIdsFor('') returns empty set → nothing filtered */
  }
  const resolved = resolvedIdsFor(sha);

  // Drop bullet lines whose [ID] is already resolved for this SHA. Non-item
  // lines (headers, blank lines, continuations) pass through untouched.
  const filtered = open
    .split(/\r?\n/)
    .filter((line) => {
      const id = parseItemId(line);
      return !(id && resolved.has(id));
    })
    .join('\n')
    .trim();

  // After filtering, if no list items remain, there's nothing live to surface.
  if (!filtered || !/^\s*[-*]\s/m.test(filtered)) process.exit(0);

  // Emit a BOUNDED digest, never the full verbatim block. Each open item's prose
  // can run to a paragraph (design questions especially), so a growing backlog
  // balloons past the harness's SessionStart inline threshold — it then truncates
  // to a ~2KB preview + a persisted file, so everything past the first couple of
  // items silently stops reaching context (the 13.8KB regression this fixes). Parse
  // the block into (section, id, summary) triples, then render at a verbosity that
  // stays inline: one-line summaries while the backlog is small, a compact
  // grouped-ID list once it grows past SUMMARY_BUDGET. Either way the full text is
  // one `git show` away, named in the header.
  const SUMMARY_MAX = 150;
  const SUMMARY_BUDGET = 12; // above this many items, drop to IDs-only so it stays inline
  const sections = [];
  let itemCount = 0;
  for (const raw of filtered.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{2,}\s/.test(line)) {
      sections.push({ title: line.replace(/^#+\s*/, ''), items: [] });
      continue;
    }
    const id = parseItemId(line);
    if (!id) continue; // drop continuation/blank lines — the digest is item-keyed
    itemCount += 1;
    let summary = line
      .replace(/^\s*[-*]\s*\[[^\]]+\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
    if (sections.length === 0) sections.push({ title: 'Open items', items: [] });
    sections[sections.length - 1].items.push({ id, summary });
  }

  const verbose = itemCount <= SUMMARY_BUDGET;
  const digest = [];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    digest.push('\n### ' + section.title + ` (${section.items.length})`);
    if (verbose) {
      for (const it of section.items) digest.push(`- [${it.id}] ${it.summary}`);
    } else {
      // Compact: just the IDs on one line — the alert survives inline; details via git show.
      digest.push(section.items.map((it) => it.id).join(', '));
    }
  }

  process.stdout.write(
    `# Open doc-review items (nightly routine) — ${itemCount} open\n\n` +
      'The nightly doc-review routine left items that need you. Full text: ' +
      `\`git show ${usedRef || BRANCH}:${FILE}\` (between the \`DOC-REVIEW-OPEN\` ` +
      'markers). Once each is applied/rejected, have me run ' +
      '`node .claude/hooks/doc-review-resolve.mjs <ID>...` so it stops re-surfacing.\n' +
      digest.join('\n') +
      '\n',
  );
} catch {
  /* never block session start on a notification */
}
process.exit(0);
