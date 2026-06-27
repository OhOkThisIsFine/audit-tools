#!/usr/bin/env node
//
// SessionStart hook — surface open doc-review escalations.
//
// The nightly doc-review cloud routine pushes its findings to the `doc-review`
// branch. The part that needs Ethan (proposed instruction-file edits + design
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

  process.stdout.write(
    '# Open doc-review items (nightly routine)\n\n' +
      'The doc-review routine left items that need you. Review, then have me run ' +
      '`node .claude/hooks/doc-review-resolve.mjs <ID>...` once applied/rejected ' +
      'so they stop re-surfacing.\n\n' +
      filtered +
      '\n',
  );
} catch {
  /* never block session start on a notification */
}
process.exit(0);
