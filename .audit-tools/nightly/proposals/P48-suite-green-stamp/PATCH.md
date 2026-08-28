# P48 — the patch, ready to apply

Four files. `suiteGreenStamp.mjs` in this directory is the new module, verbatim;
the two hunks below wire it in; the test moves to `tests/shared/`.

## 1. New file — `scripts/shared/suiteGreenStamp.mjs`

Copy `suiteGreenStamp.mjs` from this proposal directory unchanged.

## 2. `scripts/shared/run-vitest-gate.mjs` — write the stamp on a full-suite green

Add to the import block:

```js
import { worktreeTree } from "./worktree-tree.mjs";
import { isFullSuiteRun, writeSuiteGreenStamp } from "./suiteGreenStamp.mjs";
```

Replace the file's final line:

```js
process.exit(0);
```

with:

```js
// A full-suite green is the only run that is evidence about the WHOLE tree, so
// only that run mints a stamp. Best-effort by construction: a stamp that cannot
// be written leaves NO evidence, and no-evidence is the safe reading downstream.
if (isFullSuiteRun(vitestArgs)) writeSuiteGreenStamp(repoRoot, worktreeTree(repoRoot));

process.exit(0);
```

## 3. `.claude/hooks/closeout-challenge-gate.mjs` — read it as evidence

Add beside the existing `worktreeTree` import:

```js
import { readSuiteGreenStamp } from '../../scripts/shared/suiteGreenStamp.mjs';
```

Add one finding, after the closeout-render block that already computes
`currentTree` (reuse that value; do not take the tree twice):

```js
// The enforced half of the suite-run trap covers HANDOFF only. This is the
// general half: an edit of ANY kind after a green run invalidates that run, and
// no local gate re-runs the full suite, so a late SOURCE edit reaches CI unseen.
const green = readSuiteGreenStamp(ROOT);
if (!green?.tree) {
  findings.push(
    'no full-suite green on record for this repo — `npm test` has not passed since the stamp ' +
      'was last cleared. The closeout requires green on the FINAL tree, so run it after your ' +
      'last edit, not before.',
  );
} else if (currentTree && green.tree !== currentTree) {
  findings.push(
    `the last full-suite green ran on different content than the tree being handed off ` +
      `(green at ${String(green.tree).slice(0, 8)}, tree ${currentTree.slice(0, 8)}, ` +
      `${green.ran_at ?? 'unknown time'}). An edit after a green run is not evidence for the ` +
      'tree you are pushing — re-run `npm test`.',
  );
}
```

## 4. New test — `tests/shared/suite-green-stamp.test.ts`

Copy `suite-green-stamp.test.ts` from this proposal directory unchanged. It
resolves the module by absolute file URL, so it asserts the same property from
either location.

## 5. Guard registry

`scripts/guard-reach-data.mjs` must gain a row for the new module, or
`check:guard-reach` reds the build: a tracked file no reach row claims is a red
build by design. The natural home is the row that already claims
`.claude/hooks/closeout-challenge-gate.mjs`.

## Green after

```
node scripts/shared/run-vitest-gate.mjs tests/shared/suite-green-stamp.test.ts
```

Tests 3 and 4 pass on the wiring alone. Tests 1 and 2 pass on the module alone.
