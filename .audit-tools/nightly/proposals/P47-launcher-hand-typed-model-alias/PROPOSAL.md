# P47 — the pool launcher hand-types a model alias, and the alias is not recognized

**Leg 3 (recurring-problem solutions). Propose-only. Nothing here was applied.**

## What happened

Tonight's leg-1 reviewer lane died on its first call. The launcher
`C:\Users\ethan\freellmapi\claude.ps1` runs, at line 53, the only `--model` in
the file:

```powershell
& claude --model auto @args
```

Claude Code no longer accepts `auto`. The whole lane output was 71 bytes:

```
[claude-code:unrecognized_model] {"model":"auto","query_source":"sdk"}
```

The router was up, the credential was fine, and the workspace was trusted. The
one broken thing was a model name typed by hand into a script.

## Recurrence — counted, not asserted

Four separate records, four distinct dates, one trap class: **a hand-typed
model alias in a caller goes stale against what the callee accepts.**

1. **2026-08-05** — `docs/backlog/durable-traps.md` (d): an agy model pin
   `claude-sonnet-5` was hand-written while agy offered only
   `Claude Sonnet 4.6 (Thinking)`. The entry's own remedy is *"read the roster
   rather than hand-typing it."*
2. **2026-08-09** — same file: *"The router's `auto` alias resolves to a
   reasoning model that spends its whole budget thinking in the visible
   channel"* — 7 of 7 jobs returned unusable output. The `auto` alias was
   already known to be a bad pin, for a different reason.
3. **the global `~/.claude/CLAUDE.md`** — records that `claude.ps1` pins
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS` *"because Claude Code does not recognize
   the `auto` alias."* The launcher therefore already works around
   `auto`-is-unrecognized on one flag while still passing `auto` on another.
4. **2026-08-27 (tonight)** — the failure above.

Record 3 is the sharpest: the same defect, in the same file, was found and
worked around on one flag and left standing on the next one.

## What it would have caught

Tonight's leg-1 lane, and the second-adversary coverage that leg 1 depends on.
Both independent lanes were unavailable this run — Codex is out of quota until
2026-09-01 and the pool launcher was broken — so leg 1 ran with reviewer
coverage only.

## Proposed mechanism — remove the trap, do not guard it

**Do not hand-type a model in the launcher at all.** Two orderings, cheapest
first:

- **(a) Drop the flag.** Delete `--model auto` from line 53 so the nested
  session takes the router's own default and `@args` still lets a caller pin
  one. Smallest change; nothing left to go stale.
- **(b) Resolve it from the roster.** Ask the router for a live model id at
  launch (the same roster `scripts/shared/triage-backlog.mjs` already resolves
  from) and pass that. Keeps an explicit pin, and the pin cannot be stale
  because nothing types it.

Either way, the alias stops being a literal in a script.

## False-positive surface

None for (a): removing a rejected flag cannot make the lane worse than the
71-byte error it returns today. For (b), the launcher gains a dependency on the
router answering before the nested session starts — a router that is down would
turn a slow failure into a fast one, which is an improvement, but it is a
behaviour change worth naming.

## Why there is no repo patch or repo test

`claude.ps1` is the owner's file outside this repo. A repo gate that read it
would be a gate asking the local disk, which this project bans. The in-repo
half is one line of data: the `claude-ps1-launcher` row in
`scripts/shared/offload-lane-data.mjs` says the lane is unprobeable because
"nothing listens". That is true of liveness and silent about this failure — the
lane can be perfectly live and still return nothing but a rejected flag. If the
owner wants the repo to carry a reminder, the honest place is that row's
`note`, not a probe.

## Evidence

- `.audit-tools/nightly/proposals/P47-launcher-hand-typed-model-alias/RED-AT.txt`
  — the verbatim failure, the launcher line, and the confirmed workaround.
- `.audit-tools/nightly/free-leg1-0827.log` — the 71-byte lane output.
