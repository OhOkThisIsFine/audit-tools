#!/usr/bin/env node
// sites-pinned: tests/shared/run-staged-legs.test.ts
// Run the commit gate's derived legs for the STAGED set, without committing.
//
//   npm run staged:legs        # exit 1 when a leg judged the staged tree red
//
// The leg set is the one `.claude/hooks/commit-gate.mjs` runs at a commit,
// derived from the guard registry by `buildPreCommitLegs`; this runner adds no
// leg and drops none. Before it existed only a commit invoked the legs, so an
// agent that cannot commit had no way to prove the gate would pass (2026-10-01).
//
// The legs read the WORKING tree. A verdict is reported only when the working
// tree IS the staged tree before and after the legs run; otherwise the run
// ABSTAINS and says which side moved — the same rule `runDerivedFilePreflight`
// applies for the attest scripts. Stage everything (or stash the rest) for a
// verdict. The commit gate's typecheck and doc-contract run are not legs; a
// commit still runs them.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDerivedFilePreflight } from './shared/derived-file-preflight.mjs';

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** @param {{ root: string }} options @returns {number} the exit code */
export function runStagedLegs({ root }) {
  const tree = git(root, ['write-tree']);
  if (!tree.ok || !tree.stdout.trim()) {
    console.error(`staged:legs: \`git write-tree\` failed — not a git repository? ${tree.stderr.trim()}`);
    return 2;
  }
  const cached = git(root, ['diff', '--cached', '--name-only']);
  if (!cached.ok) {
    console.error(`staged:legs: could not list the staged set. ${cached.stderr.trim()}`);
    return 2;
  }
  const staged = cached.stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  if (staged.length === 0) {
    console.log('staged:legs: nothing is staged — no leg is triggered.');
    return 0;
  }
  const result = runDerivedFilePreflight({ root, staged, stagedTree: tree.stdout.trim() });
  for (const s of result.skipped) console.log(`staged:legs: note — ${s}`);
  if (result.failures.length > 0) {
    for (const f of result.failures) console.error(`\n✗ ${f.script} FAILED — fix: ${f.fix}\n${f.tail}`);
    console.error(`\nstaged:legs: ${result.failures.length} leg(s) would refuse a commit of the staged tree.`);
    return 1;
  }
  if (result.abstention) {
    console.error(`staged:legs: ABSTAINED — not a verdict about the staged tree: ${result.abstention.reason}`);
    for (const u of result.unattributed) {
      console.error(`  · ${u.script} ${u.outcome.toUpperCase()} — judged the WORKTREE` + (u.tail ? `\n${u.tail}` : ''));
    }
    return 3;
  }
  console.log(`staged:legs: every triggered leg passed on the staged tree ${result.stagedTree.slice(0, 12)}.`);
  return 0;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runStagedLegs({ root: process.cwd() }));
}
