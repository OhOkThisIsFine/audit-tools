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
import { execFileSync } from 'node:child_process';

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
  for (const ref of refs) {
    try {
      body = git(['show', `${ref}:${FILE}`], 5000);
      if (body) break;
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

  process.stdout.write(
    '# Open doc-review items (nightly routine)\n\n' +
      'The doc-review routine left items that need you. Review and tell me to ' +
      'apply or reject; resolved items drop off after the next nightly run.\n\n' +
      open +
      '\n',
  );
} catch {
  /* never block session start on a notification */
}
process.exit(0);
