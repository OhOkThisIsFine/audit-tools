# P6 — the `verify:checks` step list is hand-maintained in two docs, and went stale twice in two nights

## Recurrence — counted, on consecutive dates

The gate's step list is restated in prose in two places. Both are hand-maintained. Both have now
drifted from `package.json` on two consecutive nightly runs:

| Date | What the nightly had to fix | Where |
|---|---|---|
| 2026-07-29 | added the missing `check:doc-links` row | `docs/audit-pkg/release.md` |
| 2026-07-29 | added the missing `doc-links` **and** `nightly-routine-prompt` rows | `.claude/skills/ship/SKILL.md` |
| 2026-07-30 | added the missing `check:guard-reach` row | `docs/audit-pkg/release.md` |
| 2026-07-30 | added the missing `guard-reach` row | `.claude/skills/ship/SKILL.md` |

Four omissions, two files, two nights. Last night's fix explicitly recorded that the ship-skill list
"now matches package.json in exact order" — and it stopped matching the moment `check:guard-reach`
landed in `3cd3dbc1`, a commit that had no reason to know two prose lists existed.

That is the signature of a restatement kept honest by memory: every new gate step silently invalidates
both copies, and nothing fails until a doc reviewer happens to diff them by hand.

## The mechanism — the repo already solved this exact problem once

`CLAUDE.md` states the rule: **"One brief, two consumers — never a second copy."** It was written for
the README's Philosophy section, which used to be a hand-maintained restatement of
`docs/project-philosophy.md` "kept honest by an instruction to *remember* to update it — a drift test
made of memory, which is the thing this project bans." That block is now **generated**, gated by
`npm run check:philosophy-brief` in `verify:release`.

The gate enumeration is the same shape with the same failure mode, and `package.json`'s `verify:checks`
script is already the single source of truth. So:

1. Mark the step list in each doc with begin/end markers, exactly as the doc-manifest table and the
   README philosophy block already do.
2. Render the list from `package.json`'s `verify:checks` (and `verify:release`) step order.
3. Gate byte parity with a `check:gate-enumeration` script wired into `verify:checks`, and support
   `--write` to regenerate — the same contract as `check:doc-manifest` and `check:philosophy-brief`.

A new gate step then updates both docs by regeneration, and a hand-edited list fails the build.

### What it would have caught

All four omissions above, at the commit that introduced them, instead of one night later — and it
would have caught them in CI rather than costing a nightly reviewer a manual diff of `package.json`
against two prose lists.

### False-positive surface

Low, and the precedent is load-bearing evidence: `check:philosophy-brief` and `check:doc-manifest`
already do exactly this and neither is a known source of false failures. The one real design question
is **prose fidelity** — `docs/audit-pkg/release.md` gives each step a human gloss
("guard wiring/reach reconciliation (`check:guard-reach`)"), and a generator must not flatten those to
bare script names. That argues for generating from a small data module mapping step → gloss (the same
shape as `scripts/doc-manifest-data.mjs`), with the gate failing when `package.json` contains a step
the data module has no gloss for. That failure mode is the desirable one: adding a gate step forces
you to name it once, in one place, and both docs follow.

## Scope note

`.claude/skills/ship/SKILL.md` renders the list as a `+`-joined inline sentence while
`docs/audit-pkg/release.md` renders a bulleted list with glosses. One generator, two render shapes —
which is normal for this repo (the doc-manifest table and the philosophy brief already render one
source two ways) but is the part worth the owner's design call before implementation.

## Bound on this proposal

Leg 3 is propose-only; nothing here was applied. Tonight's four drift instances were fixed as leg-1
stale-factual edits, which is precisely the manual work this proposal is meant to end.
