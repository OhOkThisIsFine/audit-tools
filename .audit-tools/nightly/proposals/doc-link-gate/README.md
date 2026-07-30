# Proposal — `check:doc-links`, a resolution gate for relative markdown links

**Leg 3, propose-only.** Nothing here is applied. Two files are ready to copy.

## Recurrence evidence

| Date | Record | Count |
|---|---|---|
| 2026-07-25 | `b48bbe98` "doc-review: 27 dead backlog links, six skill link depths, and eleven drifted citations" | 27 links under `docs/backlog/` pointing at `docs/backlog/reviews/` and `docs/spec/`, neither of which exists |
| 2026-07-25 | same commit | 6 link depths in the `.claude/skills/` SKILL bodies resolving into `.claude/` instead of the repo root |
| 2026-07-26 | `aa270971` "three homes moved" | the doc-move rebased every **inbound** link and left three **outbound** links behind |
| 2026-07-28 (this run) | HEAD scan | **5 broken links still present** — see below |

Four separate records, three distinct dates, one underlying property. The 2026-07-26
entry is the decisive one: the lap that fixed 27 broken links **created three more in
the same session**. A hand-audited property that regresses inside one lap is the
signature of a missing gate, not of carelessness.

## The 5 defects at HEAD

```
docs/HANDOFF.md                     ../../spec/backend-identity-axes.md  -> ../spec/... (above repo root)
docs/backlog.md                     ../../spec/backend-identity-axes.md  -> ../spec/... (above repo root)
spec/backlog-remediation-design.md  backlog.md                           -> spec/backlog.md
spec/backlog-remediation-design.md  HANDOFF.md                           -> spec/HANDOFF.md
spec/backlog-remediation-design.md  backlog/deferred.md                  -> spec/backlog/deferred.md
```

The first two predate this run (verified with `git show HEAD:docs/HANDOFF.md`) — they are
not working-tree artifacts. The last three are the `aa270971` move fallout.

## Mechanism

A **gate**, not a design-away. The trap cannot be made unrepresentable: markdown link
syntax is inherently a free-text relative path, and the repo's docs must keep
cross-referencing each other. So the honest choice is the cheap mechanical check —
which is exactly the precedent `scripts/check-memory-citations.mjs` already set, and
whose header says in as many words: *"A dangling citation is not a broken link."* This
closes the half that sentence excludes.

## What it would have caught

**All four incidents, completely.** 27/27 backlog links, 6/6 skill depths, 3/3 move
fallout, 5/5 present-day. Unlike the citation-checker proposal rejected on 2026-07-26
for catching 0 of 3 incidents, this one is a total-coverage check because link
resolution is decidable — there is no judgment step to get wrong.

## False-positive surface

Measured, not asserted: **zero across 120 tracked docs**. Three exclusion classes carry
that result, each one earned by a real pattern in this corpus:

- absolute URLs (`http`/`https`/`mailto`) and bare `#anchors` — not checkable from the repo.
- `~`-rooted host paths (`~/.claude/CLAUDE.md`) — outside the repo by construction.
- this repo's `:<line>` citation idiom (`[foo.ts](../../src/foo.ts:247)`) — the suffix is
  stripped before the existence test. Without this, `docs/reviews/` alone produces three
  false positives. The **file** is still checked, so a citation whose target was deleted
  is still caught (test: *"a :<line> citation whose FILE is gone is still reported"*).

Anchor *targets* are deliberately not validated — heading slugs are a rendering judgment,
and a wrong-but-resolving anchor is not the failure mode that recurs.

The failure mode of this gate is a **blocked release**, not a blocked tool call: it runs
in `verify:checks`, not as a PreToolUse hook, so a misfire cannot wedge a session.

## Files

- `check-doc-links.mjs` → `scripts/check-doc-links.mjs`
- `doc-link-gate.test.mjs` → `tests/shared/doc-link-gate.test.mjs`
  (under `tests/`, not beside the script — Vitest excludes `.claude/**`, and a test that
  never runs is not coverage)

## Wiring — three edits

1. `package.json` scripts: `"check:doc-links": "node scripts/check-doc-links.mjs"`
2. `package.json` `verify:checks`: add `check:doc-links` to the profiled list, next to
   `check:memory-citations`.
3. Fix the 5 links above in the same commit, or the gate lands RED.

## Validation performed this run

- Gate run against HEAD: **exit 1, 5 findings, 0 false positives / 120 docs.**
- Test suite: **9/9 pass** under `npx vitest run` (temporarily staged into `scripts/` and
  `tests/shared/`, then removed — the working tree was left exactly as found).
- The tests are red-green paired: each RED case asserts a real HEAD defect shape, and the
  GREEN case asserts the same links pass once rebased.
