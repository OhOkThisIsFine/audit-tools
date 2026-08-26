# P46 — one broken provider key silently eats 39% of leg 2's coverage

Nightly leg 3, 2026-08-26. Propose-only. **No patch, and none is wanted**: the fix is a
credential repair outside this repo, and the one code change that suggests itself is already
forbidden by a standing decision in the file it would touch — see *The fix*.

## What happened tonight

Leg 2's mechanical sweep (`scripts/shared/triage-backlog.mjs`) attempted all 111 backlog
entries and classified 66. **45 errored.** Coverage is read from
`.audit-tools/nightly/triage-2026-08-26-coverage.json`, not eyeballed.

**43 of those 45 errors are one provider**, and all 43 carry the same message:

```
HTTP 502 provider_error: Provider error (…(CF)): Cloudflare key must be in format "account_id:api_token"
```

Every routed model whose name ends `(CF)` fails on the same malformed credential: Qwen2.5
Coder 32B, QwQ 32B, Nemotron 3 120B, Gemma 4 26B-A4B, Gemma SEA-LION v4 27B, GLM-4.7 Flash,
Llama 3.1 8B Instruct Fast, GPT-OSS 120B. The remaining 2 errors are ordinary upstream
failures on other providers.

This is not a discovery. `~/.claude/CLAUDE.md` has recorded it since **2026-08-09**:

> Registered here (12 keys, checked 2026-08-09): … plus **Cloudflare, which is broken**: its
> key must be stored as `account_id:api_token` and holds a bare token.

The credential has been known-bad for seventeen days. What is new is how much it now costs.

## Recurrence — counted, and accelerating

The Cloudflare share of leg-2 errors, per night, from each run's own log:

| Night | `(CF)` errors | total errors | classified / attempted |
|---|---|---|---|
| 2026-08-20 | 0 | 11 | 68 / 79 |
| 2026-08-21 | 1 | 18 | 71 / 89 |
| 2026-08-23 | 1 | 19 | 81 / 100 |
| 2026-08-24 | 3 | 41 | 69 / 110 |
| 2026-08-26 | **43** | 45 | 66 / 111 |

The trend is the finding. A provider that contributed one failure a night now contributes
almost all of them, because the router's live roster has filled with its models while its key
stayed broken. Leg 2's classified count has fallen every night since 08-23 even as attempted
rose.

Three separate nights recorded the shortfall in the inbox's *could NOT cover* block without
naming this cause — 2026-08-25 attributed 55 errors to a dialect/truncation/parser split, and
the 2026-08-22 backlog entry *"The backlog triage sweep needs a second manual invocation to
reach its real coverage"* is the same symptom seen from the other side. The cause was
diagnosable from the logs on each of those nights and was not diagnosed, which is its own half
of the finding.

## What it would have caught

Leg 2's whole job is *"is this backlog entry still real?"*. Tonight it could answer that for 66
of 111 entries. The other 45 are not clean — they are unlooked-at, and the routine's own rule
is that a quiet inbox must never mean "did not look".

Worse: this run found **no `already_shipped` class at all** for the third run running
(`actionable_now` 58, `owner_decision_needed` 3, `live_run_blocked` 5). With 41% of entries
unclassified, "we found nothing to delete" is not a statement about the backlog.

## The fix — remove the trap, do not guard it

**Primary, and the owner's:** repair or retire the Cloudflare credential in FreeLLMAPI. Its key
must be stored as `account_id:api_token` and holds a bare token. Either store the correct
composite value, or disable the provider so the router stops routing to it. `freellmapi\backup.ps1`
snapshots the DB and `.env` before any key change — the `ENCRYPTION_KEY` in `app\.env` is the
only thing that can decrypt the other eleven keys.

That single action recovers essentially all of tonight's lost coverage, and no code changes.

**The obvious fallback is already refused, and the refusal is right.** `triage-backlog.mjs`
counts an `HTTP 502 provider_error` as `errored` and moves on. The reflex is to re-attempt the
entry so the router's failover lands it elsewhere. That file forbids it in as many words:

> Deliberately NO retry/backoff anywhere in this lane: failover is the router's job, and
> duplicating it in the caller would hide a router defect.

Tonight is that decision being *vindicated*, not violated. A caller-side retry would have
absorbed 43 failures into latency, the classified count would have looked normal, and the
broken credential would have gone another seventeen days unnoticed. The sweep reported the
defect exactly as designed; what failed is that nobody read the report.

So there is no code change to propose here. The single action is the credential.

## False-positive surface

None. The primary fix is a credential repair, not a detector, and no mechanism is proposed.

## Evidence

| Claim | Where |
|---|---|
| 43 of 45 errors are `(CF)` | `.audit-tools/nightly/triage-2026-08-26.log` |
| 111 attempted, 66 classified, 45 errored | `.audit-tools/nightly/triage-2026-08-26-coverage.json` |
| per-night `(CF)` counts | `.audit-tools/nightly/triage-2026-08-2{0,1,3,4}.log` |
| the key has been known-broken since 2026-08-09 | `~/.claude/CLAUDE.md`, *Free-provider lane* |
| the sweep records an error and moves on, and forbids a caller-side retry | `scripts/shared/triage-backlog.mjs` |
