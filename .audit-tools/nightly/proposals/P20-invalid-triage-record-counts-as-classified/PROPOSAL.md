# P20 — a triage record that parses but carries no verdict is counted as CLASSIFIED, so the coverage stamp over-reports

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**Recurrence: the fourth date for one class — the leg-2 sweep reporting coverage it did not achieve.**
**Found by this run's own sweep, in tonight's output.**

## The recurrence

The coverage stamp exists because the sweep kept degrading silently. Each fix closed one route and
the next night found another:

| Date | Record | The route it closed |
|---|---|---|
| 2026-08-06 | P11 / owner decision sol-4 | three nights degraded to a partial sweep, each on a different transport fault → live model resolution, preflight, and the coverage stamp |
| 2026-08-09 | P17 | a *fabricated* record stamped as honest |
| 2026-08-09 | sol-3 | the `gone` verdict was wrong 3 times out of 3 → retired |
| **2026-08-10** | **this run** | **a record that parses as JSON but is not a triage record at all is counted as `classified`** |

The class is one sentence: **the sweep counts what it produced, never what it produced is valid.**
Three fixes have hardened the *transport*; none validates the *payload's shape*.

## What happened tonight, verified in this run's own output

`.audit-tools/nightly/triage-2026-08-10.jsonl` holds 124 records. The stamp reports 120 classified /
4 errored. **Five of the 120 carry no `verdict` and no `error` field** — they are neither classified
nor errored, yet they are counted as classified:

```
{"id":"open-bugs#c5ba56ab","file":"open-bugs.md","type":"object","properties":{"title":"Dispatch children inherit repo .claude SKILLS","verdict":"actionable_now",...
{"id":"forward-tracks#d49d8593","file":"forward-tracks.md","symbol":"{repo_url, commit_sha, labels[]}","contains":"{repo_url, commit_sha, labels[]}","premise":"unprobed"}
{"id":"open-bugs#2ab6801e","file":"src/shared/dispatch/admissionLoop.ts","contains":"band <= Math.max(FLOOR_MAX_BAND[tier], bestAvailableBand())","premise":"unprobed"}
{"id":"open-bugs#aac0ea03","file":"open-bugs.md","symbol":"obligation_ledger.input.json","contains":"obligation_ledger.input.json","premise":"unprobed"}
{"id":"open-bugs#03d4bc94","file":"open-bugs.md","premise":"unprobed"}
```

Two distinct failures, both structural:

1. **`c5ba56ab` returned the JSON *schema envelope*, not an instance** — `{"type":"object","properties":{…}}`.
   Its real verdict sits inside `properties.verdict` where nothing reads it. The record parses, so it counts.
2. **The other four returned a bare probe fragment** — `symbol`/`contains` and nothing else. No verdict,
   no `why`, no `action`.

And `2ab6801e` shows a third, quieter defect: its `file` is **`src/shared/dispatch/admissionLoop.ts`**.
That field is supposed to name which of the three backlog files the entry lives in. The record has
lost the ability to identify its own entry.

## The mechanism, at HEAD

`scripts/shared/triage-backlog.mjs:556`:

```js
rec = { id: e.id, file: e.file, ...JSON.parse(raw.slice(start, end + 1)) };
```

The spread comes **last**, so any key the model emits overwrites the sweep's own `id`/`file`. That is
exactly how `2ab6801e` acquired a source path as its `file`. Identity fields the script owns are
writable by the text it is parsing.

`scripts/shared/triage-backlog.mjs:566-567`:

```js
if (rec.error) stamp.errored += 1;
else stamp.classified += 1;
```

The only thing standing between "parsed" and "classified" is the absence of an `error` key. There is
no check that `verdict` exists, that it is one of the five allowed values, or that `why`/`action` are
present. `JSON.parse` succeeding is treated as the sweep having done its job.

This defeats the stamp's stated purpose. `docs/nightly-routine.md` says coverage is *"read from the
stamp, never eyeballed"* — so a stamp that counts five non-records as covered makes the honest
sentence unavailable exactly where the contract says to look for it.

## Proposed fix — validate the payload before it counts

Two edits in `scripts/shared/triage-backlog.mjs`, both small:

1. **Spread first, own the identity last.**

   ```js
   rec = { ...JSON.parse(raw.slice(start, end + 1)), id: e.id, file: e.file };
   ```

   `id` and `file` are the sweep's facts about which entry this is. They are never the model's to state.

2. **A shape check between parse and count.** After parsing, require: `verdict` is one of the five
   enum values the schema declares; `why` and `action` are non-empty strings. On failure, build the
   same `{ id, file, error }` record the `catch` builds — `error: 'response did not match the triage
   schema (<what was missing>)'` — so it counts as **errored**, is re-queued by the existing resume
   path, and retries on a plain re-run like every other failure. No new lifecycle.

   The schema-envelope case falls out of this for free: `{"type":"object","properties":{…}}` has no
   top-level `verdict`, so it errors instead of counting.

Prefer the fix that removes the trap over the guard that catches it: this makes the invalid record
**unrepresentable in the classified count**, rather than adding a reader who must notice it.

## What it would have caught

Tonight's five, and — by the same check — P17's fabricated record, which was a *well-shaped* record
with invented content. P17 is not superseded; the two are complementary. Worth stating in the entry:
this closes the structural half, and the content half stays P17's.

## False-positive surface

- **A lane that answers correctly in prose with the JSON appended** — unchanged; the existing
  `indexOf('{')` salvage still runs, and only the parsed object is shape-checked.
- **A future schema field added without updating the check** — the check must assert only what the
  schema declares REQUIRED, or every schema extension turns into a false red. Keep it to
  `verdict`/`why`/`action`.
- **More entries now count as errored, so the stamp's numbers get worse.** That is the point: tonight's
  real coverage is 115 of 124, not 120. A stamp that reports a lower true number is the fix, not a
  regression ([[false-red-is-as-corrosive-as-false-green]] cuts both ways).
- **The 4 hard-errored entries retry forever.** Already true today; unchanged by this proposal. Both
  retry passes tonight recovered 14 of 18, so retry does work — it just is not guaranteed to converge.

## Second-order finding — the stamp is per-invocation, and the contract reads it as cumulative

Not part of the fix above; raised because it was found in the same place and misreads the same way.

The stamp is REWRITTEN per invocation. After tonight's second retry it reads
`prior_classified: 118, attempted: 6, classified: 2` — so the field literally named `classified` says
**2**, while the run's actual coverage is 120. `docs/nightly-routine.md` instructs the reader to
"report leg-2 coverage from that stamp". A reader following the contract exactly would report that
the sweep classified 2 of 124 entries.

Suggested minimum: add a `classified_total` (`prior_classified + classified`) so the cumulative number
the contract asks for exists as a field rather than as arithmetic the reader must know to perform.

## Tests (red-green), under `tests/`

Beside the existing sweep tests (`tests/shared/triage-premise-verdict.test.ts`,
`tests/shared/triage-lane-health.test.ts`):

1. **RED before / GREEN after — schema envelope.** Feed a stubbed lane response of
   `{"type":"object","properties":{"verdict":"actionable_now"}}`. Assert the record is written with an
   `error` and that the stamp's `errored` incremented and `classified` did not. Red today: it counts
   as classified.
2. **RED before / GREEN after — bare probe fragment.** Response `{"symbol":"x","contains":"x"}`.
   Same assertions.
3. **RED before / GREEN after — identity is not model-writable.** Response containing
   `"file":"src/shared/dispatch/admissionLoop.ts"` and `"id":"whatever"`. Assert the persisted record's
   `file`/`id` are the SWEEP's values. Red today: the spread wins.
4. **No false refusal.** A fully valid record still classifies, and `premise` stamping is unchanged.
5. **Errored records re-queue.** After (1), a second run over the same JSONL retries that id — proving
   the new failures join the existing resume path rather than being dropped.

Validate by INVERTING the production edit, never by checkout ([[redgreen-restore-by-inverting-never-checkout]]).
