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
// The git ref-discovery + block parse are single-sourced in docReviewFindings.mjs
// (shared with the resolve command's `--list` / id-validation).
// Contract: docs/doc-review-guidelines.md → "Output contract".
//
// Already-applied items are suppressed via the clear-on-apply ledger
// (docReviewLedger.mjs): the host records dispositioned IDs against the
// findings.md commit SHA, and this hook filters them out so a fix that already
// landed on main stops re-surfacing every session — without waiting for the next
// nightly to regenerate the branch.
import { resolvedIdsFor } from './docReviewLedger.mjs';
import {
  makeGit,
  discoverRemotes,
  fetchDocReview,
  readFindings,
  extractOpenText,
  parseOpenItems,
  BRANCH,
  FILE,
} from './docReviewFindings.mjs';

try {
  const git = makeGit();
  const remotes = discoverRemotes(git);
  // Refresh the remote ref before reading so a fix that just landed is reflected.
  fetchDocReview(git, remotes);

  const found = readFindings(git, remotes);
  if (!found) process.exit(0);

  const openText = extractOpenText(found.body);
  if (!openText) process.exit(0);

  // Filter items the host already dispositioned against THIS findings.md SHA.
  // No SHA → resolvedIdsFor('') is empty → nothing filtered (pre-ledger behaviour).
  const resolved = resolvedIdsFor(found.sha);
  const items = parseOpenItems(openText).filter((it) => !resolved.has(it.id));
  if (items.length === 0) process.exit(0);

  // Group into sections, preserving first-occurrence order.
  const sections = [];
  for (const it of items) {
    let section = sections.find((s) => s.title === it.section);
    if (!section) {
      section = { title: it.section, items: [] };
      sections.push(section);
    }
    section.items.push(it);
  }

  // Emit a BOUNDED digest, never the full verbatim block. Each open item's prose
  // can run to a paragraph (design questions especially), so a growing backlog
  // balloons past the harness's SessionStart inline threshold — it then truncates
  // to a ~2KB preview + a persisted file, so everything past the first couple of
  // items silently stops reaching context (the 13.8KB regression this fixes).
  // Render one-line summaries while the backlog is small, a compact grouped-ID
  // list once it grows past SUMMARY_BUDGET. Either way the full text is one
  // `git show` away, named in the header.
  const SUMMARY_BUDGET = 12; // above this many items, drop to IDs-only so it stays inline
  const itemCount = items.length;
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
      `\`git show ${found.usedRef || BRANCH}:${FILE}\` (between the \`DOC-REVIEW-OPEN\` ` +
      'markers). Once each is applied/rejected, have me run ' +
      '`node .claude/hooks/doc-review-resolve.mjs <ID>...` so it stops re-surfacing.\n' +
      digest.join('\n') +
      '\n',
  );
} catch {
  /* never block session start on a notification */
}
process.exit(0);
