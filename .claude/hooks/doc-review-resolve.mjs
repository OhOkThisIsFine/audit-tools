#!/usr/bin/env node
//
// Record doc-review items as dispositioned (applied OR rejected) so the
// SessionStart surface hook stops re-surfacing them.
//
// Usage:  node .claude/hooks/doc-review-resolve.mjs AF-1 D-5 D-6 D-7
//
// Resolves the current doc-review findings.md commit SHA (same ref-discovery the
// surface hook uses) and records the given IDs against it in docReviewLedger.
// Keyed by SHA: when the nightly regenerates findings.md, these resolutions
// expire automatically and any genuinely-new item with a recycled ID surfaces.
//
// No cross-branch push — this never touches the doc-review branch, so it can't
// race the cloud routine that owns it.
import { execFileSync } from 'node:child_process';
import { recordResolved } from './docReviewLedger.mjs';

const BRANCH = 'doc-review';
const FILE = 'doc-review-findings.md';

function git(args, timeout) {
  return execFileSync('git', args, {
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
  });
}

const ids = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (ids.length === 0) {
  process.stderr.write(
    'usage: doc-review-resolve.mjs <ID>...  (e.g. AF-1 D-5 D-6)\n',
  );
  process.exit(2);
}

// Discover the same refs the surface hook reads, newest-first.
let remotes = [];
try {
  remotes = git(['remote'], 3000).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
} catch {
  /* no git / no remotes */
}
const refs = [
  ...remotes.map((r) => `refs/remotes/${r}/${BRANCH}`),
  BRANCH,
  'FETCH_HEAD',
];

let sha = '';
for (const ref of refs) {
  try {
    // Confirm the ref actually carries the findings file before trusting its SHA.
    git(['show', `${ref}:${FILE}`], 5000);
    sha = git(['rev-parse', ref], 3000).trim();
    if (sha) break;
  } catch {
    /* try next ref */
  }
}

if (!sha) {
  process.stderr.write(
    'doc-review-resolve: could not resolve the doc-review findings SHA ' +
      '(branch not fetched?). Nothing recorded.\n',
  );
  process.exit(1);
}

recordResolved(sha, ids);
process.stdout.write(
  `doc-review-resolve: recorded ${ids.join(', ')} as resolved against ${sha.slice(0, 8)}.\n` +
    'These will no longer surface at session start.\n',
);
