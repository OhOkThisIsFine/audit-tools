# P5 — the backlog-triage lane reports a rate limit as `finish_reason=undefined`

## What it costs, concretely

**Leg 2 of the nightly routine has now failed two nights running, for this reason.**

- 2026-07-29: the Codex lane ran ~35 minutes over ~144 entries and returned unfalsifiable leads;
  leg 2 was recorded in the digest's `skipped` list.
- 2026-07-30 (tonight): the mechanical lane (`scripts/shared/triage-backlog.mjs`) errored on
  **94 of 106** entries on the first pass, and re-runs against three different models
  (`pool/fast`, `pool/coding`, `groq/openai/gpt-oss-120b`) each converted only a handful more.
  Every failure carried the same error string: `finish_reason=undefined`.

That string is not the error. Instrumenting the script to print the response body gave the real one
on the first try:

```
finish_reason=undefined RAW={"error":{"message":"Rate limit reached for model
`openai/gpt-oss-120b` in organization `org_…` service tier `on_demand` on tokens per minute (TPM):
Limit 8000, Used 5818, Requested 4909. Please try again in 20.4525s. …",
"type":"tokens","code":"rate_limit_exceeded"}}
```

A plain, retryable TPM limit that states its own retry-after — reported as if the model had returned
a malformed response. Two nights of leg-2 coverage were lost to an error the lane already knew how
to describe.

## Recurrence — counted, not asserted

This is the same defect class in four separate records, on four distinct dates:

| Date | Record | Same shape |
|---|---|---|
| 2026-07-29 | this run's predecessor, digest `skipped` | leg 2 lost to an opaque lane failure |
| 2026-07-30 | tonight | 78–94 entries lost to a masked 429 |
| standing | `docs/backlog/durable-traps.md` — "The offload lane degrades on TWO independent axes — payload SIZE and CONCURRENCY — and both look like model incapacity" | a transport limit misread as the model being bad |
| standing | memory `offload-lane-failures-are-usually-the-caller` | the lane is blamed for a caller defect |

The trap is already *written down twice* and it still cost two nights — which is the argument for a
mechanism rather than a third note.

## Two defects, both in `scripts/shared/triage-backlog.mjs`

### 1. The error body is discarded (line ~200)

```js
const c = r.choices?.[0];
if (c?.finish_reason !== 'stop') throw new Error(`finish_reason=${c?.finish_reason}`);
```

When the relay passes a provider error through, there is no `choices` array at all, so `c` is
`undefined` and the thrown message is `finish_reason=undefined` — the one string that carries no
information. The response's own `error.message` is right there and is thrown away.

### 2. There is no retry, and the resume set hides that (line 178)

```js
done.add(rec.id);
kept.push(rec.error ? rec : { ...rec, premise: premiseStamp(rec) });
```

`done.add` runs for **every** record including errored ones, so `queue = entries.filter(e => !done.has(e.id))`
skips them. A re-run therefore retries **nothing** and exits 0 — which reads as "the run completed".
This also contradicts the script's own header comment at line 21, which claims "Errored rows are NOT
skipped". Tonight's coverage only advanced because each pass was preceded by manually stripping the
errored rows out of the JSONL by hand.

### 3. The resume key is a POSITION in a file the routine edits

Every record is keyed `id: "<file>#<index>"`, where the index is the entry's ordinal position in
`docs/backlog/<file>.md`. Leg 2's own job is to **delete** shipped entries from those files, so the
key is a position in a list this very routine mutates.

It bit this run, live. After `open-bugs.md` entry 27 was deleted (a code-proven shipped-removal), what
had been entry 28 became entry 27 — so every already-classified row from 27 onward was labelled with
an id that now names a *different* entry, and the resume set would have skipped those entries
believing they were done. The in-flight artifact had to be discarded and the pass restarted from
scratch against the post-deletion tree.

The fix is the same one the repo applies everywhere else ids matter: key on **content**, not
position. A hash of the entry's normalized text is already the pattern used for the doc-review scope
ledger (`itemHash` over normalized text, in `docs/doc-review-guidelines.md`) and for
`subjectKey(path, subject)` in `scripts/nightly/items.mjs`. Reusing it here makes a reworded entry
correctly re-triage and an unrelated deletion correctly leave every other row alone.

## The mechanism — use the parser the repo already owns

`src/shared/quota/errorParsing.ts` (plus the whole `src/shared/quota/errorParsers/` directory) already
classifies 429/TPM/RPM errors and already reads `retry_after_ms`, `retry-after`, `Retry-After` and
`retry_after`, normalising to milliseconds. The quota subsystem exists for exactly this failure. This
script hand-rolls a strictly worse version of it — no classification, no backoff, no surfaced message.

So the fix is not new machinery, it is deleting a hand-rolled path in favour of the shared one:

1. **Surface the real error.** On a non-`stop` response, throw the response's `error.message` (and the
   HTTP status) rather than the absent `finish_reason`.
2. **Classify and honour the retry.** Route the error body through the shared quota error parser; on a
   retryable rate limit, wait the stated retry-after and retry the same entry instead of recording a
   permanent failure.
3. **Stop laundering errors into the resume set.** `done.add(rec.id)` should run only for records
   without `error`, making the header comment true and a bare re-run actually retry.

That is the whole fix. It is confined to one script; no contract changes.

### What it would have caught

Tonight, verbatim: leg 2 would have completed instead of classifying 26 of 106 entries. Last night's
lane failure would have named its cause instead of producing leads nobody could falsify.

### False-positive surface

Small and one-directional. Honouring a stated retry-after can only make the run slower, never wrong.
The one real risk is an unbounded retry loop against a lane that is genuinely exhausted for the night
— so the retry needs an attempt cap per entry, after which the entry records the **real** error
message and the run continues to the next one. Coverage then degrades entry-by-entry with a stated
cause, instead of silently truncating to a quarter of the file.

## Why a fix and not a guard

Per `CLAUDE.md` — *prefer the fix that removes the trap over the guard that catches it*. There is
nothing to guard here: the information was in the response the whole time and the caller threw it
away. Surfacing it removes the trap outright.

## Bound on this proposal

Leg 3 is propose-only; nothing here was applied. The instrumented copy used for the diagnosis lives
in the session scratchpad, not in the repo — the tracked script is untouched at HEAD.
