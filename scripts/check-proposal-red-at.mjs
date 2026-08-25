#!/usr/bin/env node
// Proposal RED-AT reconciliation gate (P44 / sol-1, nightly 2026-08-25).
//
// A leg-3 proposal that ships a red-green test must also ship the MEASURED
// record of running that test at HEAD: `RED-AT.txt` beside it, carrying the
// exact command, the HEAD sha, and the verbatim failure — or a one-line
// statement of why the test is not runnable at HEAD (the declared-gap escape).
// A test asserted red that nobody observed is a false red presented as
// evidence; this gate makes the unrun-test state unrepresentable.
//
// Reconciles the TRACKED tree (git ls-files), so CI and a local run agree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PROPOSALS_PREFIX = '.audit-tools/nightly/proposals/';

const out = execFileSync('git', ['ls-files', '-z', PROPOSALS_PREFIX], {
  cwd: ROOT,
  encoding: 'utf8',
});
const tracked = out.split('\0').filter(Boolean);

/** proposal dir id for a tracked path under the proposals tree, or null. */
function proposalId(path) {
  if (!path.startsWith(PROPOSALS_PREFIX)) return null;
  const rest = path.slice(PROPOSALS_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? null : rest.slice(0, slash);
}

const dirsWithTests = new Set();
for (const path of tracked) {
  if (/\.test\.(ts|mjs)$/.test(path)) {
    const id = proposalId(path);
    if (id) dirsWithTests.add(id);
  }
}

const failures = [];
for (const id of [...dirsWithTests].sort()) {
  const recordPath = `${PROPOSALS_PREFIX}${id}/RED-AT.txt`;
  if (!tracked.includes(recordPath)) {
    failures.push(`${id}: no tracked ${recordPath}`);
    continue;
  }
  const body = readFileSync(join(ROOT, recordPath), 'utf8').trim();
  if (body.length === 0) {
    failures.push(`${id}: ${recordPath} is empty — a blank record is not a measurement`);
  }
}

if (failures.length > 0) {
  console.error(
    `✗ proposal-red-at: ${failures.length} proposal dir(s) ship a test with no measured record:`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nRun the test at HEAD and write RED-AT.txt beside it: the exact command, the HEAD sha, and ' +
      'the verbatim failure output — or one line stating why the test is not runnable at HEAD.',
  );
  process.exit(1);
}
console.log(
  `✓ proposal-red-at: ${dirsWithTests.size} proposal dir(s) ship tests; every one carries a non-empty RED-AT.txt`,
);
