# P19 — an attestation binds to a staged tree the gate has not yet judged, so every gate-demanded fix voids it

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**Recurrence: four separate records across three distinct dates, and the remedy the most recent
record prescribes is FALSIFIED at HEAD — the legs it says to reorder are already in that order.**

## The recurrence

One trap: an agent writes a tree-bound attestation, then the pre-commit gate refuses the commit and
demands a fix that edits a tracked file. Fixing it changes the staged tree, which invalidates the
attestation that was just written, so the same review is attested twice.

| Date | Record | What it says |
|---|---|---|
| 2026-07-25 | `docs/backlog/durable-traps.md:54-60` | "the natural `add && attest && commit` chain can never work, since staging after attesting invalidates the override" |
| (undated) | memory `constitutional-override-binds-to-final-staged-tree` | "stage everything, THEN attest" |
| 2026-08-09 | `docs/backlog/durable-traps.md:650-660` | "the gate can tell you to regenerate a file AFTER you have already attested… You then attest a second time for the same review" |
| 2026-08-09 | `docs/HANDOFF.md:85-87` | S1 (`100b9117`): "Its attestation had to be written TWICE: the pre-commit gate rejected the first because regenerating the backlog seek index changed the staged tree afterwards" |

Three of the four are advice to *remember an ordering*. `CLAUDE.md`'s auditor-agnostic-robustness rule
says that is a latent failure mode by definition: the ordering is enforceable, so it must be enforced.

## The prescribed remedy does not work — verified at HEAD

`durable-traps.md:657-660` states the fix as:

> ⚠ Enforceable and NOT yet enforced: the gate evaluates the attestation before the derived-index
> check, so it fails in the order that maximises rework. Reordering those legs — index regeneration
> checks before attestation binding — removes the trap entirely, at which point this entry goes.

**Its premise is false.** In `.claude/hooks/pre-commit-gate.mjs` → `runGate()` the legs already run
in the prescribed order:

| Leg | Line | What |
|---|---|---|
| 2b   | 517 | `check:doc-manifest` |
| 2b-i | 561 | `check:guard-reach` |
| 2b-ii | 642 | `check:handoff-roadmap` |
| 2b-iii | 693 | `check:backlog-index` |
| 2c | 841 | constitutional-doc override |
| **3** | **910** | **loop-core attestation** |

Every derived-index leg already precedes both attestation legs. Reordering removes nothing, because
**leg order inside the gate is not the mechanism**. The gate runs at `git commit` time; the agent
attested *before* it ever ran. No arrangement of the gate's own legs can inform a decision that was
already taken in a previous tool call.

That matters beyond this entry: a backlog remedy that would have been implemented as written, and
would have shipped a no-op while deleting the entry that records the real trap.

## The actual mechanism

`.claude/hooks/attest-loop-core-review.mjs:142` binds unconditionally:

```js
const wt = git(['write-tree']);
if (!wt.ok || !wt.stdout.trim()) {
  fail(`\`git write-tree\` failed — nothing staged, or not a git repo. ${wt.stderr}`);
}
const sha = wt.stdout.trim();
```

It writes `.claude/loop-core-review/<sha>.json` for whatever tree happens to be staged. It never asks
whether that tree is one the gate would accept. So the attestation is valid-by-construction and
useless-in-practice whenever a derived file is stale.

The same hole exists in `scripts/attest-constitutional-doc-change.mjs`, which binds the same way.

## Proposed fix — refuse to bind to a tree the gate would reject

Prefer the fix that removes the trap over the guard that catches it. This removes it: make binding
conditional on the derived-file checks the gate will run, so a stale index is reported **before** any
attestation exists rather than after.

In both attest scripts, before `write-tree` binds:

1. Determine which derived-file checks the *staged set* would trigger — the same predicates the gate
   uses (`pinsRoadmap`, `pinsBacklogIndex`, and the doc-manifest / guard-reach triggers).
2. Run exactly those checks.
3. On failure: **refuse to write the attestation**, printing the regenerator command. Nothing is
   bound, so nothing is wasted.

Cost: the attest call gets slower by the checks it would have paid for at commit time anyway. It never
adds work — it moves work earlier, which is the whole point.

**The single-source obligation.** The trigger predicates must not be copied into the attest scripts —
five copies of a guard hid two bugs once already ([[five-copies-of-a-guard-hid-two-bugs]]). Extract
them from `pre-commit-gate.mjs` into one module both the gate and both attest scripts import, in the
same commit. If that extraction is rejected, the whole proposal should be, because a hand-kept second
copy of the trigger list is a worse trap than the one being fixed.

## What it would have caught

`100b9117` (S1, 2026-08-09) — the attestation written twice, verbatim in HANDOFF. Under this fix the
first attest call fails with "docs/backlog.md seek index is stale — run
`node scripts/shared/generate-backlog-index.mjs`", and the review is attested once.

## False-positive surface

- **An attest run with nothing staged that triggers a derived check** — unchanged behavior; no check
  runs, binding proceeds. The predicates are staged-set-gated exactly as in the gate.
- **A check that is not wired in this repo** — the gate already fails open with an announcement
  (`noteFailOpen`). The attest scripts must fail open the same way and say so, or a missing script
  becomes an un-attestable repo.
- **Slower attest.** ~60s worst case if all four checks trigger. This is the honest cost, and it is
  strictly less than the rework it replaces.
- **Not a total fix.** Binding still cannot anticipate the doc-contract test leg (leg 2, `test:doc-contract`,
  up to 240s) — including that would make attest cost as much as the gate. This proposal covers the
  four *derived-file* legs, whose failures are the ones that force a tracked-file edit. State that
  bound in the entry rather than deleting it as fully closed.

## Backlog consequence

`durable-traps.md:650-660` must be **corrected either way** — its stated remedy is falsified at HEAD
and would ship a no-op. If this proposal is declined, the entry keeps its trap but its "reorder the
legs" sentence has to go.

## Tests (red-green), under `tests/`

Vitest excludes `.claude/**`, so these live at `tests/shared/attest-derived-file-preflight.test.ts`
beside the existing hook contract tests, and the file must be registered in
`scripts/guard-reach-data.mjs` in the same commit.

1. **RED before / GREEN after** — stage a loop-core file plus a `docs/backlog/*.md` edit without
   regenerating the seek index, run `attest-loop-core-review.mjs`, assert it exits non-zero, that
   `.claude/loop-core-review/` gains no file, and that the message names
   `generate-backlog-index.mjs`. Red today: the attestation is written and the exit is 0.
2. **No false refusal** — stage a loop-core file only (no backlog/HANDOFF path). Assert the
   attestation is written and no derived check ran.
3. **Fail-open is announced** — with the check script unwired, assert binding proceeds AND the output
   says which check was skipped. Guards the `noteFailOpen` parity above.
4. **Single-source** — assert the trigger predicates resolve to one shared module, i.e. that
   `pre-commit-gate.mjs` and both attest scripts import the same file. This is the test that keeps
   the extraction from silently regressing into copies.

Validate by INVERTING the production edit, never by checkout ([[redgreen-restore-by-inverting-never-checkout]]).
