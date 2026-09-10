#!/usr/bin/env node
//
// Configuration-time half of the SUBJECT-KEYED pin legs.
//
// `PINS` (scripts/shared/derived-file-preflight.mjs) binds a SUBJECT path to
// the test files that assert something ABOUT it; staging the subject obliges
// those tests at commit time. That obligation only means anything while the row
// RESOLVES, and the failure mode of a stale row is silent in the worst
// direction: it obliges a test that no longer pins the subject, or a test file
// that no longer exists, and the green build reads as coverage that was checked.
//
// So the row is reconciled against the TRACKED TREE here, not at commit time —
// the same split `check:guard-reach` uses for the guard registry. A row whose
// subject or test is not tracked, whose test cannot be read, or whose test
// imports the BUILT package (no `dist/` in a fresh worktree, so the leg would
// red for a reason unrelated to the pin) fails this check.
//
// What this does NOT prove, stated because a partly-enforced trap is not
// deletable: that the bound test still asserts a literal mirroring the subject.
// That is a reading, not a mechanism, and it is why each row is one line.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcilePinObligations } from './shared/derived-file-preflight.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// `git ls-files` — the TRACKED tree, never the filesystem: an untracked test
// file would satisfy an existsSync probe while being absent from every commit
// the obligation is supposed to guard. windowsHide: an unguarded spawn flashes
// a console window on win32 when this runs inside verify:checks (INV-WH).
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: repoRoot, windowsHide: true })
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

const errors = reconcilePinObligations(tracked, (rel) => readFileSync(join(repoRoot, rel), 'utf8'));

if (errors.length > 0) {
  console.error('✗ pin-obligations check failed:\n\n' + errors.join('\n\n') + '\n');
  process.exit(1);
}
console.log('✓ pin-obligations: every PINS row resolves against the tracked tree and is build-free');
