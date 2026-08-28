# P48 — a full-suite green leaves tree-bound evidence, so a late edit cannot inherit it

**Leg 3 · nightly 2026-08-28 · HEAD `6e2f902d` · propose-only**

## The trap

A green suite run is evidence about the tree it ran on. Every later edit — source,
doc, ledger — makes that evidence describe a tree that no longer exists. Nothing at
HEAD notices. The pre-commit gate runs typecheck legs plus a doc subset, never the
full suite, so a late source edit after a green run reaches CI unseen, and the
closeout hand-back can truthfully say "verified green" about the wrong content.

## Recurrence — counted, not asserted

Five records across four distinct dates, on two independent surfaces.

1. **`docs/backlog/durable-traps.md`, the suite-run entry (2026-08-27).** Records
   the original occurrence — a closeout edited `docs/HANDOFF.md` after the suite
   went green, then committed and pushed on that earlier run; CI failed the same
   minute and **two commits shipped red** before the challenge gate surfaced it.
2. **The same entry's second half (2026-08-27).** "It recurred the same day,
   identically" — a closeout re-introduced hand-written text and both mechanical
   guards passed. Same trap, same date, second occurrence.
3. **The same entry's closing paragraph, verbatim:** *"a late SOURCE edit after a
   green run is still caught only by CI. That half is discipline, not a mechanism,
   which is why this entry stays open rather than being deleted."* The repo has
   already judged this trap live and unenforced; it is not this proposal's claim.
4. **`docs/reviews/closeout-generation-failure-2026-08-26.md` (2026-08-26),** cited
   inside `closeout-challenge-gate.mjs` itself: 19 of 29 challenged sessions
   hand-wrote the report and only 3 were caught. The same class — a closeout
   asserting a verification whose evidence nobody could check.
5. **The `/insights` pass of 2026-08-28,** measured from session history across 241
   sessions and independent of anything written in this repo. It names
   *"Verification run before the last edits"* as one of three top friction sites:
   *"The closeout hook fires twice in many sessions because you verify green, then
   make documentation or ledger edits after."* Its evidence line cites **at least
   four nightly maintenance sessions**. `buggy_code` is the dominant friction
   category at 138 occurrences.

Project memory carries the same lesson twice — `lap-green-must-match-ci-evidence.md`
and `false-red-is-as-corrosive-as-false-green.md`.

Item 5 matters most: it is the outside measurement. Items 1 to 4 are what happened
to get written down; item 5 counts the same failure where nobody was writing.

## Why a guard, when the rule is "prefer removing the trap"

Removing the trap means making the evidence impossible to stale — running the full
suite at commit time. That is deliberately not done: the pre-commit gate is kept to
typecheck legs plus a doc subset so a commit stays fast, and forcing a full suite on
every commit would trade this defect for a much larger one. So the trap cannot be
designed away here, and a guard is the correct instrument. **This proposal adds no
new refusal.** It adds one line of mechanical evidence to a challenge that already
fires, which is the cheapest possible shape.

## The mechanism

Reuse the identity the repo already proved: `worktreeTree()`, the tree object of the
worktree as it would be committed. The closeout record is already bound to it, for
exactly this reason — committing what the record described keeps it valid, and any
further edit invalidates it. `.claude/hooks/.state/` is gitignored, so writing the
stamp cannot change the tree it just described.

- `scripts/shared/run-vitest-gate.mjs` is the ONE entrypoint every gate-context
  vitest run goes through. On a **full-suite** green it writes
  `.claude/hooks/.state/suite-green/latest.json` = `{ tree, ran_at, session_id }`.
- `.claude/hooks/closeout-challenge-gate.mjs` adds one finding when there is no
  stamp, or when the stamp's tree differs from the tree being handed off.

**Full-suite is `argv.length === 0`, not an allowlist.** `npm test` and
`verify:release` invoke the gate bare; every narrower caller passes at least one
argument (`test:doc-contract` passes file paths, `verify:guards` passes
`--retry`/`--exclude`). There is no list to maintain, and a new filtered caller
cannot accidentally mint whole-tree evidence.

The patch is in [`PATCH.md`](PATCH.md); the module is `suiteGreenStamp.mjs` in this
directory, verbatim.

## What it would have caught

The 2026-08-27 closeout, both times. The suite went green, `docs/HANDOFF.md` was
edited after, and the stamp's tree would no longer have matched the tree being
handed off — so the challenge that fired anyway would have carried the reason
instead of leaving it to CI. It does not catch the second occurrence's root cause
(that is now closed by `053c4a28` putting `handoff-roadmap.test.ts` in the
pre-commit doc leg); it catches the class both belong to.

## False-positive surface — stated honestly

- **It fires on a first run in a fresh clone or worktree**, where no stamp exists.
  That reading is correct, not false: no full suite has passed there.
- **It fires on any closeout that edits after its green run** — which is the whole
  point, and is exactly the case the owner's own closeout step 1 already forbids.
  It is not a refusal: the challenge is answerable, and it is capped at 2 per
  session by the existing gate.
- **It does NOT fire on committing what the green run covered.** The tree identity
  is content, not HEAD, so the closeout's own commit leaves the stamp valid.
- **`worktreeTree()` returning null is "cannot tell".** `writeSuiteGreenStamp`
  refuses to stamp on null, and the read side treats a missing stamp as missing
  evidence. Neither direction fabricates a match.
- **The stamp is repo-wide, not per-session.** A second session's full-suite green
  satisfies the first session's closeout if the tree matches. That is intended —
  the claim is about the TREE, not about who ran it.

## Cost

One new 82-line module, two small wiring hunks, one new test file, one guard-registry
row. No new gate, no new refusal, no change to any existing exit code.

## Red-green

RED at HEAD is recorded verbatim in [`RED-AT.txt`](RED-AT.txt) — 4 of 4 tests fail,
each for its intended reason. GREEN after the patch is the same command.
