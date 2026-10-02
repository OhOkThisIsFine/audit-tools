#!/usr/bin/env node
// sites-pinned: tests/shared/loop-core-attestation-ledger.test.ts
// Gate: every loop-core path in the tree carries the content its tracked
// attestation-ledger entry vouches for.
//
// The rule, and why it reads a TRACKED ledger rather than the local review
// record, live in `scripts/shared/loopCoreAttestationLedger.mjs`. This gate is in
// the verify:checks catalog, so the same rule runs at every boundary a landing
// path crosses: the pre-commit leg (when the staged set touches loop-core or the
// ledger), CI on every pull request into and push to `main`, the local pre-tag
// gate of the release script, and the publish workflow's gate.
//
//   npm run check:loop-core-attestations             # judge the index
//   npm run check:loop-core-attestations -- --rev HEAD
//
// Write an entry with `node .claude/hooks/attest-loop-core-review.mjs …`.
import { spawnSync } from 'node:child_process';
import { LEDGER_PATH, targetsMain, verifyLedger } from './shared/loopCoreAttestationLedger.mjs';
import { guardArgv } from './shared/argvGuard.mjs';

/** @type {string | undefined} */
const rev = guardArgv(process.argv.slice(2), {
  name: 'check:loop-core-attestations',
  usage: 'node scripts/check-loop-core-attestations.mjs [--rev <rev>]',
  values: ['--rev'],
}).get('--rev');

/** @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: Infinity });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

const concernsBlock = targetsMain(git, process.env);
const { fault, problems, reviewed, baselineOnly } = verifyLedger({ git, rev, concernsBlock });
if (fault) {
  // A check that cannot read the tree has judged nothing; passing would read as
  // "attested". Fail closed.
  console.error(`check:loop-core-attestations: ${fault} — no verdict.`);
  process.exit(1);
}
if (problems.length > 0) {
  console.error(
    `check:loop-core-attestations: ${problems.length} loop-core attestation problem(s) in ` +
      `${rev ? `tree ${rev}` : 'the index'} (ledger ${LEDGER_PATH}):\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      `\n\nLoop-core content lands only with a review that vouches for it, by whichever path it lands ` +
      `(a hook-less commit or a squash merge included). Review the change adversarially, stage it, then run:\n` +
      `  node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> --attester-class <agent|human> ` +
      `--checked "<what was adversarially checked>" [--include-unvouched <path>]...\n` +
      `A staged loop-core path is covered by the review. A listed path that is NOT in the staged change (content ` +
      `that already landed unreviewed) must be reviewed too and named, one --include-unvouched <path> each — the ` +
      `attest script refuses rather than vouch for it silently.\n` +
      `It records the reviewed content in ${LEDGER_PATH} and stages that file; commit both together.`,
  );
  process.exit(1);
}
console.log(
  `check:loop-core-attestations: every loop-core path in ${rev ? `tree ${rev}` : 'the index'} carries attested content.`,
);
// A report, not a verdict: baseline-only files have never been reviewed since
// the ledger began, and that count should only fall.
console.log(
  `check:loop-core-attestations: ${reviewed} loop-core file(s) reviewed; ${baselineOnly} still baseline-only ` +
    `(unchanged since the baseline commit, never reviewed).`,
);
