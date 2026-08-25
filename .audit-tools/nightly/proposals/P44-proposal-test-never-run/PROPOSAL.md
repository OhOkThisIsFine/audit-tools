# P44 — A leg-3 proposal ships a red-green test nobody ever ran

**Leg 3, nightly 2026-08-25. Proposal only — nothing landed.**

## The recurring problem

`docs/nightly-routine.md` requires a hook/gate proposal to carry "the full patch **and its
red-green tests**", so "the owner approves in one step rather than re-deriving the work". The
test is written from reading the code, never executed. So the proposal's stated RED reason is
an unverified claim, and the promise — approve in one step — does not hold.

## Recurrence evidence — two landed proposal tests needed correction before they could be trusted

| Date | Proposal | What the test needed before it could be trusted |
|---|---|---|
| earlier | `P40-prompt-renders-its-contract` | The landed `tests/shared/prompt-renders-its-contract.test.ts` differs from the proposal copy by 66 diff lines: two missing imports (`ArtifactBundle`, `renderCharterKindLanePrompt`) and a `bundle()` fixture helper the proposal never wrote. The proposal copy could not have run at all. |
| 2026-08-25 | `P43-answered-work-vs-open-run-collision` | Two defects. (1) The fixture wrote the decision ledger as `{ decisions: { … } }`; the ledger is a FLAT map, so `readDecisions` saw an empty ledger, `--list` took its early exit, and the test was RED for a reason unrelated to the missing mechanism — the proposal's stated RED reason ("`--list` prints nothing about an open remediation run") was not the reason it failed. (2) It imported `execFileSync` from `node:child_process`, which the repo invariant INV-WH refuses across the whole test tree — landing it reddened `npm test`. |

Correction (2026-08-25, owner): an earlier version of this section claimed these two rows were
the complete population and a 2-of-2 hit rate. That overclaimed. P37 and P40 both recorded
genuine measured RED/GREEN runs in their proposals (P37 at `ad0d51b0` with exit codes; P40
measured a real 2-failed red in the same run, after fixing an in-run false red). The rows above
still stand as defects — a recorded measurement can diverge from the landed copy (P40) or be red
for the wrong reason (P43) — which is why the record must bind the verbatim failure, the exact
command, and the sha.

## Why this is the signature of a missing mechanism

A test asserted to be red, whose redness nobody observed, is a **false red** — the same class the
repo already tracks as corrosive. A false red is worse here than a plain absence, because the
proposal presents it as evidence: the owner reads "RED against HEAD ... GREEN once the patch
lands" as a measurement, and it is a prediction.

## Mechanism

Run the test when the proposal is written, and record what actually happened.

1. The routine writes the proposal's test to a scratch path, runs it against HEAD, and captures
   the verbatim assertion failure.
2. It writes that output to `.audit-tools/nightly/proposals/<id>/RED-AT.txt`, with the HEAD sha
   and the exact command, and quotes the real failure message in the proposal instead of a
   predicted one.
3. `scripts/check-guard-reach.mjs` (or a small sibling check wired into `verify:checks`) refuses
   a proposal directory that contains a `*.test.ts` / `*.test.mjs` with no sibling `RED-AT.txt`.

The refusal is what makes it a mechanism rather than a reminder: today the routine can write an
unrun test and nothing notices, which is exactly the "host remembering" shape `CLAUDE.md` bans.

## What it would have caught

Both rows above, at write time, at the cost of one vitest invocation each.

## False-positive surface

A proposal whose test genuinely cannot run at HEAD because the patch creates the file under test.
That is real: P43's test could run (it drives an existing script), P40's could not have without
the missing helper. The escape is a `RED-AT.txt` whose body states, in one line, that the test is
not runnable at HEAD and why — the same declared-gap escape the guard-reach registry already uses.
An unrunnable test then still costs an explicit statement instead of passing silently.

## Already-shipped check

Grepped `scripts/check-*.mjs` and `.claude/hooks/`: nothing reads
`.audit-tools/nightly/proposals/**` at all. `scripts/guard-reach-data.mjs` claims the tree for
file coverage, not for proposal contents. Nothing runs a proposal's test.

## The owner's decision

Adopt the RED-AT record with the reconciliation check, adopt the record without the check
(honest but unenforced), or decline and keep the test as a written prediction.
