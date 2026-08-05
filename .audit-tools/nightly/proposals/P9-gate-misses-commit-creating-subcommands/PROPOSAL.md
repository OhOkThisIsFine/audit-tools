# P9 — the pre-commit gate fires only on `git commit`; every other commit-creating subcommand lands ungated

## Status of the trap

This is **not a new discovery** — it is a durable-traps entry that has been standing since
2026-07-22, states its own real fix, and has not been built. The nightly's job here is to close it
rather than to re-observe it: the repo's own rule is that *a trap that can be enforced is enforced,
and its backlog entry is DELETED rather than restated*.

`docs/backlog/durable-traps.md:384` already carries the full analysis, including a corrected
false remedy. Its closing sentence names the work:

> Real fix: widen the gate's detection to the commit-creating subcommand set — then delete this
> entry per the hook-enforcement policy.

## Verified at HEAD tonight

```
$ grep -n "isGitSubcommand" .claude/hooks/pre-commit-gate.mjs
204:const isGitSubcommand = (name) => (s) => gitSubcommandRe(name).test(collapseQuoted(s));
205:const commitSubCmds = subCmds.filter(isGitSubcommand('commit'));
245:  subCmds.some(isGitSubcommand('add')) ||
```

`commit` is the only commit-creating subcommand matched. `runGate` returns early on
`commitSubCmds.length === 0`, so `git merge`, `git rebase --continue`, `git cherry-pick`,
`git revert` and `git am` skip **every** leg: `npm run check`, the doc-contract subset,
`check:doc-manifest`, `check:guard-reach`, and the loop-core review attestation.

## Recurrence — counted

| Date | Evidence |
|---|---|
| 2026-07-22 | trap filed; observed as stray-doc failures on all three merge commits of the v0.34.7 queue (main red until `0c6a5a6d`) |
| 2026-07-24 | entry corrected — the original remedy ("also run doc-manifest in CI") shown to be a no-op, since `ci.yml`'s gate job already runs `verify:checks` and `docs/**` has been a trigger path since `214f601e` |
| 2026-08-05 | re-verified unbuilt at HEAD (grep above) |

Two distinct incident dates plus a correction pass, and fourteen days open with the fix already
written down. The blast radius is the whole gate: a merge can land anything.

Note the asymmetry that keeps this alive — CI *reports* the red after the fact; the gate that is
missing is the **local** one, which is the only one that prevents the bad commit existing.

## The mechanism — widen the subcommand set

The gate already has the predicate factory. The change is the set it is applied to:

```diff
-const commitSubCmds = subCmds.filter(isGitSubcommand('commit'));
+// Every subcommand that can CREATE a commit, not just the one named "commit".
+// A merge, a rebase continuation, a cherry-pick, a revert or an `am` all write
+// history, and every one of them skipped all four legs of this gate.
+const COMMIT_CREATING_SUBCOMMANDS = ['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'];
+const commitSubCmds = subCmds.filter((s) =>
+  COMMIT_CREATING_SUBCOMMANDS.some((name) => isGitSubcommand(name)(s)),
+);
```

Then **delete `docs/backlog/durable-traps.md:384` in the same commit** — the mechanism states the
trap and the fix when it fires, and two copies decay independently.

## Red-green tests

`tests/shared/hook-pre-commit-gate.test.ts` is the existing home (contract tests live under `tests/`;
vitest excludes `.claude/**`, so a test beside the hook never runs). One case per subcommand:

```ts
it.each(["merge", "rebase --continue", "cherry-pick abc123", "revert abc123", "am patch.mbox"])(
  "gates `git %s`, which creates a commit", (sub) => {
    // RED at HEAD: runGate returns early, verdict is "allow".
    expect(runGate(`git ${sub}`).decision).not.toBe("allow");
  },
);

it("still allows a git subcommand that cannot create a commit", () => {
  expect(runGate("git status").decision).toBe("allow");   // green before AND after
});

it("still does not fire on a path merely NAMING a commit-creating word", () => {
  // The existing collapseQuoted/gitSubcommandRe protection must survive the widening.
  expect(runGate('git status -- src/merge-results.ts').decision).toBe("allow");
});
```

Validate by inverting: run against unpatched `pre-commit-gate.mjs` and confirm the five parameterised
cases FAIL and the two guards PASS, then apply and confirm all seven pass.

## False-positive surface

The real cost is a conflict-resolution loop: `git rebase --continue` and `git cherry-pick --continue`
are run repeatedly mid-conflict, and each would now pay the gate's cost. Two mitigations, in order of
preference:

1. **Scope the expensive legs by staged set**, exactly as `commit` already does — the doc-contract
   subset and `check:doc-manifest` only run when the staged set touches them. A rebase step touching
   no docs pays nothing extra.
2. If the `npm run check` leg is still too slow inside a rebase loop, gate on the *final* commit of
   the operation rather than each step — but prefer (1), since "skip the gate when it is
   inconvenient" is the shape that created this trap.

A `--no-verify` escape already exists and is already scanned for; widening does not change that
surface.
