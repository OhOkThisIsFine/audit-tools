# Proposal — surface an open remediation run's write scope in `answer.mjs --list`

**Leg 3, propose-only.** Nothing here is applied. One patch file is ready to copy.

## The recurring problem

An answered nightly decision often implies a CODE fix. When a remediation run is in flight,
that fix may target a file a still-pending work item claims, and applying it corrupts the
run's binding. Nothing computes that collision, so every agent re-derives it by hand from
`.audit-tools/remediation/state.json` — and the derivation is easy to get wrong in the
over-broad direction, which parks ready work.

## Recurrence evidence

| Date | Record | What happened |
|---|---|---|
| 2026-08-23 | commit `78ad5f54` "handoff: four answered items wait behind the run's close" | An agent hand-derived that ALL FOUR answered-not-done items collide with the run's binding, and wrote that conclusion into `docs/HANDOFF.md` prose. |
| 2026-08-24 | this nightly run | The same derivation was performed again from scratch. It disagreed: one of the four (`5acf2e262ebd7ab0`, the F-label comment cleanup) touches NO file any pending block claims. It shipped this run as `7e34fe14`. |

Two distinct dates, one property, and the hand-derivation was **wrong once out of four** —
in the direction that silently parks ready work for a day. A conclusion that has to be
re-derived every session, and that a careful agent got wrong, is the signature of a
missing mechanism rather than of carelessness. It is also a direct instance of the
`CLAUDE.md` invariant *auditor-agnostic robustness*: correctness here rests entirely on
the host remembering to go look, and then reasoning correctly about what it found.

## What it would have caught

The 2026-08-23 blanket deferral of `5acf2e262ebd7ab0`. With the run's pending write scope
printed beside the answered-not-done list, the non-collision is visible at a glance instead
of requiring a state-file read plus a block-to-item join.

## The mechanism

`node scripts/nightly/answer.mjs --list` already prints ANSWERED, NOT RECORDED AS DONE.
Add one block beneath it: when `.audit-tools/remediation/state.json` exists and its status
is not terminal, print each non-terminal item's id and the `touched_files` of its block,
read from `plan.blocks`. Absent or terminal run state prints nothing, so the common case
is unchanged.

## What it deliberately does NOT claim

It does not label an answered item READY or BLOCKED. A decision record carries the `path`
the QUESTION was about, which is frequently not the file the FIX touches — `240e467dfd7a8ac9`
is recorded against `docs/project-philosophy.md` while its fix edits `admitSpawn` under
`src/shared/`. A path-match verdict would therefore under-detect collisions and hand out a
false READY, which is worse than the status quo.

So the mechanism supplies the FACT (what the open run currently claims) and leaves the
judgement where it belongs. This is deliberately an information change, not a gate: the
tool cannot know an unwritten fix's write set, so a DENY here would be guessing.

## False-positive surface

None that blocks anything — it prints, it never refuses. The failure mode is staleness:
if the run advances between the print and the edit, the scope shown is old. That is the
same window every read of the run state has, and it is narrower than the current practice
of copying the conclusion into `docs/HANDOFF.md` prose, where it survives for days.

## Files

- `answer-list-run-scope.patch` — the addition to `scripts/nightly/answer.mjs`.
- `answer-list-run-scope.test.mjs` — red/green test: absent run state prints nothing;
  a run with pending items prints their block write scope.

Tests belong under `tests/` when adopted; Vitest excludes `.claude/**` but these live under
`scripts/`, so a test beside the script would run — place it with the other nightly tests.
