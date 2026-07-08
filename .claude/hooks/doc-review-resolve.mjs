#!/usr/bin/env node
//
// Record doc-review items as dispositioned (applied OR rejected) so the
// SessionStart surface hook stops re-surfacing them.
//
// Usage:
//   node .claude/hooks/doc-review-resolve.mjs AF-1 D-5 D-6 D-7   # record
//   node .claude/hooks/doc-review-resolve.mjs --list             # show open ids
//   node .claude/hooks/doc-review-resolve.mjs --help
//
// Resolves the current doc-review findings.md commit SHA (same ref-discovery the
// surface hook uses, single-sourced in docReviewFindings.mjs) and records the
// given IDs against it in docReviewLedger. Keyed by SHA: when the nightly
// regenerates findings.md, these resolutions expire automatically and any
// genuinely-new item with a recycled ID surfaces.
//
// Ids are validated against the open findings block before recording — an id that
// matches no known finding is REJECTED, not silently recorded. This closes a
// foot-gun where a stray flag/typo (e.g. a bare `--list` before this affordance
// existed) was stored as a bogus resolution against the live SHA.
//
// No cross-branch push — this never touches the doc-review branch, so it can't
// race the cloud routine that owns it.
import { recordResolved, resolvedIdsFor } from './docReviewLedger.mjs';
import { makeGit, collectOpenItems } from './docReviewFindings.mjs';

const HELP =
  'usage:\n' +
  '  doc-review-resolve.mjs <ID>...   record ids as resolved (e.g. AF-1 D-5 D-6)\n' +
  '  doc-review-resolve.mjs --list    list the open doc-review ids\n' +
  '  doc-review-resolve.mjs --help    show this help\n';

const args = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
const wantsHelp = args.includes('--help') || args.includes('-h');
const wantsList = args.includes('--list');
// Ids are the non-flag args (a leading `-` is always a flag, never an id).
const ids = args.filter((a) => !a.startsWith('-'));

if (wantsHelp) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Read the current open findings once — reused for both --list and validation.
const open = collectOpenItems(makeGit());

if (wantsList) {
  if (!open) {
    process.stderr.write(
      'doc-review-resolve: could not resolve the doc-review findings ' +
        '(branch not fetched?). Nothing to list.\n',
    );
    process.exit(1);
  }
  // Match what the surface hook shows: hide items already dispositioned against
  // THIS findings SHA, so `--list` never diverges from the session-start digest.
  const resolved = resolvedIdsFor(open.sha);
  const live = open.items.filter((it) => !resolved.has(it.id));
  const hidden = open.items.length - live.length;
  const note = hidden > 0 ? ` (${hidden} already resolved, hidden)` : '';
  if (live.length === 0) {
    process.stdout.write(`No open doc-review items${note}.\n`);
    process.exit(0);
  }
  process.stdout.write(
    `Open doc-review items (${live.length})${note} @ ${open.sha.slice(0, 8) || '?'}:\n` +
      live.map((it) => `  [${it.id}] ${it.summary}`).join('\n') +
      '\n',
  );
  process.exit(0);
}

if (ids.length === 0) {
  process.stderr.write(HELP);
  process.exit(2);
}

if (!open) {
  process.stderr.write(
    'doc-review-resolve: could not resolve the doc-review findings SHA ' +
      '(branch not fetched?). Nothing recorded.\n',
  );
  process.exit(1);
}

// Validate against the known open ids — reject a typo/stray arg rather than
// silently storing it as a bogus resolution against the live SHA.
const knownIds = new Set(open.items.map((it) => it.id));
const unknown = ids.filter((id) => !knownIds.has(id));
if (unknown.length > 0) {
  const knownList = [...knownIds].sort().join(', ') || '(none open)';
  process.stderr.write(
    `doc-review-resolve: unknown doc-review id(s): ${unknown.join(', ')}. ` +
      `Nothing recorded.\nOpen ids: ${knownList}\nRun with --list for summaries.\n`,
  );
  process.exit(2);
}

recordResolved(open.sha, ids);
process.stdout.write(
  `doc-review-resolve: recorded ${ids.join(', ')} as resolved against ${open.sha.slice(0, 8)}.\n` +
    'These will no longer surface at session start.\n',
);
