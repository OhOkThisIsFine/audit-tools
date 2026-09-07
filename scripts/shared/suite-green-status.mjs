#!/usr/bin/env node
// Fast answer for the repository-owned green mechanism. The full suite writes
// a worktree-tree-bound stamp; this command only checks that evidence. It is
// intentionally cheap so /start-lap and other machine-wide callers can ask the
// owning mechanism without creating a second ledger or re-running the suite.
import { readSuiteGreenStamp, suiteGreenVerdict } from './suiteGreenStamp.mjs';
import { worktreeTree } from './worktree-tree.mjs';

const root = process.cwd();
const verdict = suiteGreenVerdict(readSuiteGreenStamp(root), worktreeTree(root));

if (!verdict.ok) {
  console.error(`[suite-green] FAIL — ${verdict.reason}. Run npm test on the current tree.`);
  process.exit(1);
}

console.log(
  `[suite-green] PASS — tree ${verdict.tree.slice(0, 12)} was certified${
    verdict.ranAt ? ` at ${verdict.ranAt}` : ''
  }.`,
);
