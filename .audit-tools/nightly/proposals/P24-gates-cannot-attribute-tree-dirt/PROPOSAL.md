# P24 — every gate reads the whole live tree and cannot attribute dirt to the run it is gating

**Leg 3. Proposal only — nothing landed.** Nightly run 2026-08-12.

## Recurrence: 5 records, 4 distinct dates

| record | date | what happened |
|---|---|---|
| `docs/backlog/durable-traps.md` | 2026-07-23 | concurrent sessions share the one checkout. "No tooling fix proposed yet." |
| `docs/backlog/open-bugs.md` | 2026-07-24 | the backlog budget baseline binds to the LIVE file, so ratcheting mid-lap turns `backlog-budget-unit.test.ts` RED in a way that reads as a code regression |
| `docs/backlog/open-bugs.md` (**HIGH**) | 2026-07-30 | the phase-boundary gate ran on the live tree; driver-side dirt failed it twice and the backstop **abandoned all 13 items**. Its first stated property: "the gate attributed dirt it did not cause to the run." |
| `docs/backlog/open-bugs.md` | 2026-08-07 | the closeout gate "cannot attribute tree dirt, so a CONCURRENT session's uncommitted WIP re-fired the challenge… and spent the full cap on paths this session never touched" — itself flagged as "same attribution principle as the phase-boundary-gate entry above" |
| `docs/backlog/open-bugs.md` | 2026-08-07 | `ensureCleanWorktree` refuses a release on sibling *untracked* files |

## The shape at HEAD

Four independent hand-rolled whole-tree reads, verified present:
`closeout-challenge-gate.mjs:81`, `session-start-guards.mjs:197`,
`pre-commit-gate.mjs`, `release-and-publish.mjs:120`.

The repo already contains the **correct** pattern in two places —
`shell-trap-guard.mjs:172` scopes its porcelain call to a pathspec, and the
pre-commit gate's staged snapshot binds to the staged tree. So this generalizes an
in-repo solution rather than inventing one.

## Mechanism — a shared classifier plus a contract test

One `scripts/shared/treeDirt.mjs` partitioning porcelain rows into
tracked/untracked × attributable/foreign, with all four readers consuming it.
Same "declared data, single-sourced, reconciled" shape as `guard-reach-data.mjs`
and `liveSessionWork.mjs`.

**Contract test**, not a hook: the property is that no gate hand-rolls its own
whole-tree read, which is a property of the tree. Tests go under `tests/`.

## What it would have caught

The 2026-07-30 all-13-item abandonment; the 2026-08-07 cap burned on a sibling
session's WIP; the release refused on Codex analyzer droppings.

## False-positive surface — stated honestly, and it is the real cost

The dangerous failure here is a false **negative**. Attribution needs a source of
truth for "what this session touched," and any edit the journal does not see gets
classified *foreign* — so a gate that should have asked about real unfinished work
waves it through. **That is a worse failure than today's over-firing**, and it is
the tradeoff the owner should weigh before this is built at all.

Downgrading untracked files to a warning has its own cost: a genuinely-needed new
file can be forgotten at release.

## Relationship to P23

They overlap at the closeout gate but are distinct mechanisms: **P23 asks *who is
this session*, P24 asks *whose dirt is this*.** Neither subsumes the other, and
P23's leg (a) would fix the 2026-08-07 closeout case more cheaply than P24 does.
If only one is built, P23 is the smaller cut.
