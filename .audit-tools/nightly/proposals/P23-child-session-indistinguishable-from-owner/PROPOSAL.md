# P23 — a child agent session is indistinguishable from the owner's, so the repo's own Stop gates recruit it into mutating git

**Leg 3. Proposal only — nothing landed.** Nightly run 2026-08-12.

## Recurrence: 4 records, 3 distinct dates

| record | date | what happened |
|---|---|---|
| `docs/backlog/durable-traps.md` | 2026-08-07 | a nested `claude -p` probe hit the closeout-challenge Stop hook, spent its whole reply answering it, and **pushed the checkout's unpushed commits** on its way out |
| memory `dispatch-lane-children-hit-repo-stop-gates.md` | 2026-08-07 | in `-p` mode the final message *is* the deliverable, so a Stop-gate block hijacks it — the child answers the gate and the actual report is silently lost |
| `docs/reviews/dogfood-run-2026-08-08.md` O9 | 2026-08-08 | a child loaded this repo's `security-review` skill mid-audit-packet. "Hooks were the known half; **skills are the uncovered half**" |
| `docs/backlog/durable-traps.md` | 2026-08-09 | in-process `Agent`/`Workflow` subagents trip the Stop gates "and they commit" — names commits `00d6fbfd`, `c687fed9` |

Mechanically corroborated: both named commits exist, two minutes apart on
2026-08-09, editing `docs/HANDOFF.md` and a review doc — authored by read-only
recon subagents while the parent was still mapping.

Scale signal: `.claude/hooks/.state/closeout-challenge/` holds **88 session
markers**, up to 14 in one day (2026-08-07) and 13 on 2026-08-09 — far more
sessions than the owner plausibly opened, consistent with child sessions
routinely reaching the gate.

## Not already guarded

`scripts/guard-reach-data.mjs` claims no coverage for this. The gate's only
escape is `AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE`, which a subagent **inherits** from
the parent — so setting it disarms the parent too, exactly as the trap entry
states. The live-background-work skip (`scripts/shared/liveSessionWork.mjs`)
fixed a different half (the 2026-07-28 mid-lap cap burn) and, as the memory file
says outright, does not help here: the child's stop is a real stop.

## Mechanism — hook, two legs

**(a) Identity.** `.claude/hooks/session-start-guards.mjs` writes a per-`session_id`
marker at SessionStart; both Stop gates exit 0 for any session whose id has no
marker.

> ⚠ **Requires one probe before building.** This assumes child sessions do NOT
> fire SessionStart. The repo documents the exact probe pattern in memory
> `stop-payload-background-tasks-signal.md`. **If children do fire SessionStart,
> leg (a) is inert and must not be built.** Do not skip this step.

**(b) Harm — the stronger, trap-removing half.** Extend
`.claude/hooks/pre-commit-gate.mjs` (already on PreToolUse Bash) to refuse
`git commit` / `git push` from an unregistered session. This removes the damage
regardless of whether the Stop gate fires, and covers the O9 skill-loading
variant, which leg (a) does not.

Leg (b) is preferred on this repo's own rule — prefer the fix that removes the
trap over the guard that catches it.

## What it would have caught

`00d6fbfd` and `c687fed9`; the 2026-08-07 uninstructed push; the 2026-08-07 child
whose report was replaced by a gate answer.

## False-positive surface — stated honestly

- **Leg (b) blocks *intentional* agent-authored commits.** This repo genuinely
  dispatches write-capable agents, and `/ship` may run from one. So leg (b) needs
  a per-dispatch allow token — and the owner decided on 2026-08-07 (memory
  `offload-switch-is-owner-owned-config.md`) that these kill-switches stay
  **per-dispatch, never centralized in config**, so the token must be set by the
  caller. A caller who forgets it gets a blocked commit mid-run.
- **Leg (a) fails the opposite way.** If the marker file is lost or the state dir
  is cleaned, the owner's own session is misread as a child and the closeout
  challenge silently stops firing — a false negative in a gate whose entire value
  is that it fires.

## Where it belongs

**Hook**, both legs — the trap is detectable at a tool call (leg b) and at session
start (leg a). Its tests go under `tests/`, since vitest excludes `.claude/**`.

## Open question for the owner

Build leg (b) alone (removes the harm, needs the per-dispatch token), both legs,
or neither pending the SessionStart probe? Leg (a) is cheap but unproven until
that probe runs.
