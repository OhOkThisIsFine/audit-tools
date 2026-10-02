#!/usr/bin/env node
// sites-pinned: tests/shared/loop-core-attestation-ledger.test.ts
// Writes the loop-core attestation ledger's one BASELINE: the loop-core content
// of a commit, recorded as exactly that and nothing more — no reviewer, no
// verdict. A baseline entry passes `check:loop-core-attestations` only while the
// file is unchanged; any change needs a real review through
// `.claude/hooks/attest-loop-core-review.mjs`, which cannot write a baseline.
//
// Run once, when the ledger starts. It refuses when the ledger (staged or on
// disk) already has a baseline or any entry.
//
//   node scripts/seed-loop-core-baseline.mjs --commit <rev> [--notes "<context>"]
//
// It writes the ledger and does not stage it; stage and commit it yourself.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LEDGER_PATH,
  loopCoreBlobs,
  parseLedger,
  readLedger,
  seedBaseline,
  serializeLedger,
} from './shared/loopCoreAttestationLedger.mjs';
import { guardArgv } from './shared/argvGuard.mjs';

const root = process.cwd();

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`seed-loop-core-baseline: ${msg}`);
  process.exit(1);
}

const args = guardArgv(process.argv.slice(2), {
  name: 'seed-loop-core-baseline',
  usage: 'node scripts/seed-loop-core-baseline.mjs --commit <rev> [--notes "<context>"]',
  values: ['--commit', '--notes'],
});
/** @type {{ commit?: string, notes?: string }} */
const flags = { commit: args.get('--commit'), notes: args.get('--notes') };
if (!flags.commit) fail('--commit <rev> is required');

/** @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: Infinity });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

const resolved = git(['rev-parse', '--verify', `${flags.commit}^{commit}`]);
if (!resolved.ok) fail(`cannot resolve ${flags.commit} to a commit. ${resolved.stderr}`);
const commit = resolved.stdout.trim();

// Both copies are checked: a baseline must not overwrite one that is only on
// disk, nor one that is only staged.
const ledgerFile = join(root, ...LEDGER_PATH.split('/'));
const staged = readLedger(git);
if (staged.kind === 'corrupt') fail(`the staged ${LEDGER_PATH} is unreadable (${staged.reason})`);
const onDisk = existsSync(ledgerFile)
  ? parseLedger(readFileSync(ledgerFile, 'utf8'))
  : /** @type {{ kind: 'missing' }} */ ({ kind: 'missing' });
if (onDisk.kind === 'corrupt') fail(`${LEDGER_PATH} on disk is unreadable (${onDisk.reason})`);

const commitBlobs = loopCoreBlobs(git, commit);
const blobs = loopCoreBlobs(git);
if (commitBlobs === null || blobs === null) fail('git could not list the tree');

let result;
for (const copy of [staged, onDisk]) {
  result = seedBaseline(copy.kind === 'ok' ? copy.ledger : null, { commit, commitBlobs, blobs, notes: flags.notes });
  if ('error' in result) fail(`refusing: ${result.error}.`);
}
const { ledger } = /** @type {{ ledger: import('./shared/loopCoreAttestationLedger.mjs').Ledger }} */ (result);
mkdirSync(dirname(ledgerFile), { recursive: true });
writeFileSync(ledgerFile, serializeLedger(ledger), 'utf8');
console.log(
  `seed-loop-core-baseline: wrote ${LEDGER_PATH} with a baseline of ${commitBlobs.size} loop-core path(s) at ` +
    `${commit.slice(0, 12)} (${Object.keys(ledger.entries).length} still tracked). Not staged.`,
);
