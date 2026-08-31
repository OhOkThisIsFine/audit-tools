# P49 — the leg-2 triage lane dies on ONE unusable roster head

**Leg 3 proposal, nightly 2026-08-31. HEAD `5b634c7d`. Propose-only; nothing was applied.**

## What happened, measured

The leg-2 backlog sweep aborted at entry 0 tonight, having classified nothing:

```
.audit-tools/nightly/triage-2026-08-31-coverage.json   (first run)
  "model": "anthropic",
  "aborted": "preflight failed: HTTP 401 authentication_error: x-api-key header is required",
  "total_entries": 89, "attempted": 0, "classified": 0
```

Re-running the identical command with `TRIAGE_MODEL=pool/medium` classified the
backlog with **zero errors**. The router was healthy throughout. What failed was
the target the script CHOSE.

## The mechanism

`resolveTriageModel` (`scripts/shared/triage-backlog.mjs:198`) ends:

```js
return ids.includes('auto') ? 'auto' : ids[0];
```

`ids` is the router's `/v1/models` roster in the order the router returns it. The
relay currently returns `anthropic, pool/high, pool/low, pool/medium, pool/xhigh`
and no longer advertises an `auto` alias, so the fallback fires and selects
`anthropic` — the one id on that roster that requires a real Anthropic key and
answers 401 on loopback. `MODEL` is then a module constant, the preflight throws
`LanePreflightError`, and the driver exits 1 without attempting an entry.

**This is not an unnoticed bug — it is a pinned behaviour whose premise expired.**
`tests/shared/triage-lane-health.test.ts:37` asserts it by name: *"falls back to
the first advertised model when auto is absent"*. Changing it is therefore an
owner decision, which is why this is a proposal rather than a fix.

## Recurrence evidence — counted, not asserted

Nineteen coverage stamps exist for this sweep. They divide cleanly:

- `2026-08-07` … `2026-08-09` (3 nights): resolved `pool/medium`, all ran.
- `2026-08-10` … `2026-08-28` (16 nights): resolved `auto`, all ran.
- `2026-08-31` (tonight): no `auto` on the roster, fallback fired for the **first
  time**, sweep aborted at entry 0.

So the positional fallback has existed for the whole life of the stamp record and
had **never once been exercised** until the roster changed under it. That is the
honest recurrence count: **one occurrence, on its first exercise, fatal**. It is
raised anyway because the failure rate of the path when taken is 1/1 and its blast
radius is a whole leg of the routine — not because it is a frequent event.

## What it would have caught

Tonight's abort, in full. Under the proposed mechanism the sweep would have
preflighted `anthropic`, taken the 401, moved to `pool/high`, and run — with the
skipped head recorded in the coverage stamp so the choice stays visible.

## Proposed mechanism

Make resolution return an **ordered candidate list** instead of one id, and have
the driver preflight down that list, using the first target that answers:

- `resolveTriageCandidates(env, rosterSource) -> string[]`
  - an explicit `TRIAGE_MODEL` is the **only** candidate (unchanged escape hatch);
  - otherwise the router's roster **in the router's own order**, with `auto` hoisted
    to the front when advertised;
  - an empty roster still throws, still naming `TRIAGE_MODEL=` as the escape.
- The driver preflights candidates in order. The first that answers becomes `MODEL`.
  When every candidate fails, it aborts exactly as today — the abort message gains
  the list it tried and each failure.
- The coverage stamp records `model` (the one used) and `models_skipped[]` (head
  ids that failed preflight, with their status), so a silently-degraded target can
  never read as a clean run.

Red-green test: `triage-lane-candidate-fallback.test.ts` in this directory,
measured red at HEAD in `RED-AT.txt`. It ships to `tests/shared/` —
`vitest.config.ts` excludes `.audit-tools/**`, so a test left beside its proposal
never runs.

## The alternative that was REJECTED, and why

*Rank the roster: prefer a `pool/*` id over a bare provider id.* This would also
have survived tonight, and it is a smaller diff. It is rejected because it writes
provider-naming knowledge into the tool, which is the thing this repo has cut out
twice: **"No execution inventory in this package … Model identities, windows,
prices, rate limits, capability tiers, and provider rosters are host concerns"**
(`CLAUDE.md`). The script's own comment already states the principle — `auto`
exists precisely because "the router … is the only thing that knows live health
and quota". Ranking the roster is the script making the judgement it just said it
cannot make. Surviving a bad head makes no such judgement.

## False-positive surface

Small, and worth stating exactly.

1. **A slow-but-healthy head reads as unusable.** The preflight has no timeout of
   its own; a hanging first candidate would hang the sweep as it does today, so
   this is unchanged, not worsened. If a timeout is added later it must be long
   enough that a cold pool member is not skipped.
2. **A usable-but-wrong target could be silently adopted.** If the head fails and
   the second candidate is a weak model, the sweep runs and classifies at lower
   quality rather than refusing. `models_skipped[]` in the stamp is the mitigation:
   the run says which target it actually used, and the routine already reads
   coverage from that stamp rather than from prose.
3. **A universally-401 roster.** Every candidate fails, and the behaviour is
   today's: abort, exit 1, nothing attempted — with a better message.

There is no new gate here and nothing blocks a tool call, so the "a misfiring guard
blocks every call at 3am" risk that narrows leg-3 autonomy does not apply.

## Scope

**Repo-scoped.** The defect is in `scripts/shared/triage-backlog.mjs`, which lives
here and serves this repo's nightly routine. The roster change that exposed it is a
machine-wide fact about llm-relay, but the thing that must change is this file.
