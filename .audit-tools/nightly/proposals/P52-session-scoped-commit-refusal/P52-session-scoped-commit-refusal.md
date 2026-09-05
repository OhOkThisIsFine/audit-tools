# P52 — a commit must not absorb another session's uncommitted work

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
**Scope: MACHINE-WIDE (`~/.claude/hooks/`), not this repository.**

## The trap

Two agent sessions — or a nightly run and a live session — share one working
tree. A `git add -A`, a `git add .`, a `git commit -a`, or a bare `git commit`
after a partial add then sweeps the other session's uncommitted or staged work
into a commit whose message never mentions it.

## Recurrence — 11 records across 9 distinct dates

| Record | Date |
|---|---|
| `memory/in-tree-wip-is-own-compacted-work.md` | 2026-06-12, 2026-06-13 |
| `memory/concurrent-sessions-share-the-checkout.md` (4 observations) | 2026-07-23, 2026-08-06, 2026-08-07 |
| `docs/backlog/durable-traps.md:305` (+ a 2026-08-27 sibling-WIP addendum) | 2026-07-23 |
| `docs/backlog/durable-traps.md:115` | 2026-08-20 |
| `docs/backlog/durable-traps.md:874` — a subagent `Read` served pre-edit content | 2026-08-20 |
| `docs/backlog/durable-traps.md:676` — an offload recon lane read a mid-edit tree | 2026-08-07 |
| `docs/backlog/durable-traps.md:64` — `git add -A` swept a sibling's P45 proposal, and it was pushed | 2026-08-26 |
| `memory/nightly-and-live-session-share-one-checkout.md` — HEAD moved four times mid-run | 2026-08-26 |
| `C:\Code\docs\backlog.md:596` | 2026-08-30 |
| `C:\Code\docs\backlog.md:415` — llm-relay, commit `76e11e4`, attribution lost | 2026-09-04 |
| `C:\Code\docs\backlog.md:445` — llm-relay, forced re-cut of v0.71.1 | 2026-09-04 |

The incidents span `audit-tools`, `llm-relay`, and `C:\Code` itself. That is why
the scope is machine-wide: fixing it in one repository leaves every other
repository broken in exactly the same way, and the two most expensive incidents
were not in this repository.

## Two candidate mechanisms — the owner picks the FORM

### Form A — make it unrepresentable: one worktree per live session

`session-start-guards.mjs` registers the session against the checkout's
git-common-dir. When another live session is already registered on that same
common dir **and this session is in the main checkout**, the guard refuses to
proceed until this session opens its own linked worktree. Two sessions can then
never hold hunks in one index, and all eleven incidents become impossible rather
than detected.

The global instruction file already states this rule in prose — *"the
one-worktree-per-lane rule covers interactive sessions too."* Form A is that
prose made mechanical.

### Form B — a staging-scope refusal at the tool call

Every input already exists. `session-start-guards.mjs` writes a per-`session_id`
tree-dirt baseline at session start, and the closeout Stop gate already
partitions foreign dirt from session dirt. Only the refusal is missing.

A PreToolUse rule denies `git add -A`, `git add .`, `git commit -a`, and a bare
`git commit` after a partial add **whenever the tree carries dirt that is not in
this session's baseline** — naming the foreign paths and offering
`git commit -- <pathspec>` instead. The `durable-traps.md:64` entry names this
exact gap in its own words: *"that is a Stop-TIME REPORT, not a staging refusal,
so nothing stands between `git add -A` and the push."*

## What it would have caught

The pushed P45 sweep (2026-08-26); the nightly's untracked proposal directory
landing in a foreign commit (2026-08-26); the three staged backlog files riding a
one-file handoff fix and forcing an amend (2026-08-20); the llm-relay `76e11e4`
attribution loss (2026-09-04); the llm-relay `docs/backlog.md` rewrite that
shipped an untracked doc link and forced the v0.71.1 re-cut (2026-09-04); the
`C:\Code\docs\backlog.md` absorption (2026-08-30).

## False-positive surface — stated honestly

- A single-session lap legitimately runs `git add -A` constantly. Form B must key
  on *foreign dirt exists*, never on the command shape, or it fires every lap.
- The baseline is a snapshot. A session that deliberately leaves work dirty
  across a compaction, or an owner editing in an IDE beside the agent, produces
  "foreign" dirt that is in fact wanted. Form B needs a bypass, and that bypass
  must work verbatim in the form the refusal prints.
- Form A carries the sharper cost. It blocks a session at its very first action,
  and a stale registry entry — a crashed session that never deregistered — would
  lock the main checkout outright. The registry therefore needs a liveness
  expiry, and `C:\Code\docs\backlog.md:547` records that **Windows reuses pids
  within seconds**, so a pid-liveness check is not a liveness check here. That is
  the hard part of this proposal, not the detection.

## Why no patch is attached

The routine normally attaches a full patch and its red-green tests so the owner
approves in one step. Here the question put to the owner is *which form*, and the
two forms share no code: Form A is a session-start refusal keyed on a liveness
registry, Form B is a PreToolUse rule keyed on a dirt baseline. A patch written
before that choice would be discarded by either answer. The patch follows the
form decision.
