# P43 — Refuse a delegated lane that cannot read the repo, before spending on it

**Leg 3, nightly 2026-08-23. Proposal only — nothing landed.**

## Recurrence evidence — 10 records across 8 distinct dates

`docs/backlog/durable-traps.md`

- `:95` — "A Claude lane whose isolated `CLAUDE_CONFIG_DIR` has not TRUSTED the workspace
  answers from nothing" (2026-08-15), marked **UNENFORCED**
- "An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right"
  (2026-07-20)

Project memory

- `pool-lane-fabricates-when-untrusted.md` — 2026-08-07, 08-13, 08-14, 08-15
- `lane-agreement-is-not-evidence.md` — 2026-08-14
- `context-bundle-attributions-are-unverified-leads.md` — 2026-08-09
- `codex-bulk-verification-returns-leads.md` — 2026-07-29
- `verify-delegated-findings-mechanism-not-just-citation.md` — 2026-07-18, 07-25, 07-26, 08-11
- `claude-desktop-proxy-redirect-flip-flops.md` — ~1.9M tokens spent believing offload was live

## The failure

A lane launched with an isolated config dir that has not trusted the workspace cannot read
files. It does not error. It answers from nothing, with the right STRUCTURE and fabricated
supporting quotes, which is the shape a reader accepts. This run hit the adjacent form
directly: the first free-lane adversary dispatch reported that the claim list "was cut off
before the visible text" and offered to verify against an unrelated file it had found.

## Verified open at HEAD `fa66bd8c`

`scripts/shared/offload-lane-data.mjs` contains exactly one occurrence of the string "trust",
at `:18`, and it is unrelated prose about probe remedies. No row expresses trust or file-read
capability. P36 probes TRANSPORT LIVENESS only, and the module explicitly separates that from
"will it serve".

## Mechanism — a precondition, not a probe of judgment

Add a `configDirTrust` row to `scripts/shared/offload-lane-data.mjs` for the file-reading
lanes, checked by the existing session-start lane leg. An untrusted lane is then reported as
unusable at lap start rather than trusted mid-lap.

The failing input is deterministic and readable BEFORE dispatch: whether the isolated config
dir has trusted the workspace. So this spends no quota, which is the constraint the module's
own design states ("lane-serves is unknowable without spending quota").

## What it would have caught

The 2026-08-15 fabricated closeout, and the 08-07 / 08-13 / 08-14 pool-lane invention runs.

## False-positive surface — and the honest half

The launcher that would SET the trust lives at `~/freellmapi/claude.ps1`, outside this repo.
So the in-repo half only reports; it cannot repair. Trust state can also change between
session start and dispatch, so a stale green is possible. Lanes that legitimately receive
inlined content rather than file access must be marked unprobeable, or they red falsely.

## Already-shipped check

Read `scripts/shared/offload-lane-data.mjs` in full. `check:offload-lanes` reconciles rows
against the hook and the docs, so a new row is gated the moment it lands. Nothing today
expresses trust.

## The owner's decision

Approve the `configDirTrust` row plus the session-start report, approve a report-only variant
that never marks a lane unusable, or decline because the repairing half lives outside this
repo.
