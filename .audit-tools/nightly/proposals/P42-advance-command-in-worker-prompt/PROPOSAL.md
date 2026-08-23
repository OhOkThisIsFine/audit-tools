# P42 — Delete the advance command from the worker-facing prompt document

**Leg 3, nightly 2026-08-23. Proposal only — nothing landed.**

This is a design change that makes the trap unrepresentable, not a guard.

## Recurrence evidence — 3 incidents across 2 dates, and the spec is already written

- `docs/backlog/open-bugs.md:547` — "A delegated step prompt can turn its executor into a
  second driver (2026-07-16)". The entry records TWO separate occurrences: a
  `charter_extraction` worker and a later `systemic_challenge` round. It already carries a
  full SPEC.
- `.audit-tools/…/remediation-friction-CONTRACT-mt0qo4m9-bknh8b.json` (2026-08-19) — two
  independent sub-agents flagged the same prompt self-contradiction unprompted.

## The failure

A worker prompt tells the executor to stop and write its output file, and then, in the same
document, tells it to run the advance command. The 2026-08-19 record captures both halves
side by side: "Stop … Do not advance to the next pipeline step" and "After writing the output
file, run: remediate-code next-step". An executor given both obeys one of them, and which one
it obeys is not a property the tool controls.

## Verified open at HEAD `fa66bd8c`

`src/remediate/steps/prompts.ts` renders `loaderCommand("next-step")` into worker prompts at
lines 88, 171, 269, 311, 386, 504 and 548.

## Mechanism

Each step already emits two artifacts: a driver-facing machine step contract, and a
worker-facing prompt document. Move the advance command into the first only. An executor
handed material that contains no advance command has nothing to obey.

This is not a guard. There is no rule to enforce and nothing to detect, because after the
change the sentence cannot be written into worker material at all.

## What it would have caught

Both 2026-07-16 self-advances, and the 2026-08-19 contradiction.

## False-positive surface

None as a guard, because it is not one. The real cost is behavioural: a host that has been
reading the advance command out of the prompt FILE rather than out of the step contract loses
its cue. So the driver-facing contract must surface the command at least as prominently as
the prompt did, and that is the part to get right before landing.

The backlog entry explicitly warns against the two alternative designs — an out-of-band
control channel, and an agent-identity check on the advance command. Do not reach for either.

## Already-shipped check

Grepped `src/**` for the advance command inside prompt templates (the seven sites above).
Grepped `.claude/hooks/` and `scripts/check-*.mjs`: nothing refuses an advance command in
worker material.

## The owner's decision

Approve moving the command to the driver-facing contract only, approve it with a named
prominence requirement on the step contract, or decline and keep the command in both.
