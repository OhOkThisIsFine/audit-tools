#!/usr/bin/env node
// Developer-only proposal RED-AT companion presence check.
//
// This check reads the candidate from the Git index: both its tracked paths
// and staged bytes. It does not run tests or verify what a record claims.
import { execFileSync } from 'node:child_process';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PROPOSALS_PREFIX = '.audit-tools/nightly/proposals/';

const gitOptions = {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
};
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z', PROPOSALS_PREFIX], gitOptions).split('\0').filter(Boolean),
);

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
  if (!tracked.has(recordPath)) {
    failures.push(`${id}: no tracked ${recordPath}`);
    continue;
  }
  const body = execFileSync('git', ['cat-file', 'blob', `:${recordPath}`], gitOptions).trim();
  if (body.length === 0) {
    failures.push(`${id}: staged ${recordPath} is blank`);
  }
}

if (failures.length > 0) {
  console.error(
    `✗ proposal-red-at: ${failures.length} proposal dir(s) lack a non-empty staged RED-AT.txt companion:`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nStage a non-empty RED-AT.txt companion. This check verifies presence only, not test execution.',
  );
  process.exit(1);
}
console.log(
  `✓ proposal-red-at: ${dirsWithTests.size} proposal dir(s) with tests have a non-empty staged RED-AT.txt; test execution not verified`,
);
