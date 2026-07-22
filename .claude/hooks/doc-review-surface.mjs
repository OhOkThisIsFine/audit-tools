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
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvedIdsFor } from './docReviewLedger.mjs';
import {
  makeGit,
  discoverRemotes,
  fetchDocReview,
  readFindings,
  extractOpenText,
  parseOpenItems,
  buildSurfaceOutput,
  BRANCH,
  FILE,
} from './docReviewFindings.mjs';

// The full decision table is ALSO written here (gitignored — `.audit-tools/*`),
// so if the harness ever clips the inline hook output to a preview (the old
// 13.8KB regression), recovery is one Read of a named local file, not git
// plumbing. Overwritten on every surface; stale-on-resolve is fine because the
// inline table is the primary and this is only the truncation fallback.
// Forward-slash literal (never path.join) so the DISPLAYED path is identical on
// every platform; the write below joins it onto the project dir natively.
const FALLBACK_RELPATH = '.audit-tools/doc-review-open.md';

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

  // Render the LARGEST per-section decision tables that fit the harness's inline
  // hook-output budget (the owner-requested zero-roundtrip contract, 2026-07-17):
  // full item text when it fits; per-item clipped text (never dropped items or
  // IDs) with a loud clip note when it doesn't. An over-budget render is worse
  // than a clipped one — the harness persists it to a side file and the session
  // sees only a one-line preview, which is exactly the "single unexplained line"
  // failure this budget exists to prevent. The uncapped tables always land in
  // the on-disk fallback copy below.
  const { output, fullOutput } = buildSurfaceOutput(items, {
    fallbackRelPath: FALLBACK_RELPATH,
    sourceNote: `Source of truth: \`git show ${found.usedRef || BRANCH}:${FILE}\`.`,
  });

  // Best-effort fallback write (always the FULL, uncapped tables) — a failure
  // here must never block the surface.
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    mkdirSync(join(projectDir, '.audit-tools'), { recursive: true });
    writeFileSync(join(projectDir, FALLBACK_RELPATH), fullOutput, 'utf8');
  } catch {
    /* fallback copy is optional */
  }

  process.stdout.write(output);
} catch {
  /* never block session start on a notification */
}
process.exit(0);
