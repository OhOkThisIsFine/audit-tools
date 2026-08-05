# P11 — leg 2's mechanical lane has failed to sweep the backlog three nights running, differently each time

## The pattern, not the incident

`scripts/shared/triage-backlog.mjs` is the mechanism that makes leg 2 possible: 154 entries of dense
prose is more than a nightly can read, so the lane classifies them and the routine works from a
routing map. It has now failed to complete on three consecutive runs, and the *cause has been
different every time*:

| Date | Cause | Coverage reached |
|---|---|---|
| 2026-07-29 | lane failure, unattributed | partial |
| 2026-07-30 | masked groq 8000-TPM rate limit; every failure recorded `finish_reason=undefined`, the retry-after never honoured (filed as `sol-1`, fixed in `391c743d`) | 31 of 105 |
| 2026-08-05 | default pool `pool/fast` no longer exists (hard 400); on a live pool, throughput ~32 of 154 in ~35 min, plus unparseable model output | partial |

Three nights, three faults, one constant: **leg 2 silently degrades to a partial sweep, and the
routine only discovers it by watching the row count.** The 2026-07-30 defect was found and fixed;
the lane broke again in a new place immediately. That is the signature of a component with no
health contract, not of three unlucky nights.

## Tonight's two faults, both verified

**1. The default model spec is dead.**

```
$ grep -n "TRIAGE_MODEL" scripts/shared/triage-backlog.mjs
41://   TRIAGE_MODEL=<spec>        default pool/fast (llm-relay spec: pool/<name>
42://                              or <provider>/<model>); pool/coding for retries
67:const MODEL = process.env.TRIAGE_MODEL || 'pool/fast';

$ curl -s -X POST http://127.0.0.1:8791/v1/chat/completions -d '{"model":"pool/fast",...}'
{"type":"error","error":{"message":"llm-relay routing: no pool \"fast\" configured (available: low, medium, high, xhigh)"}}
```

llm-relay renamed its pools to effort tiers (`low`/`medium`/`high`/`xhigh`) at v0.15.4; `fast`,
`coding` and `reasoning` no longer resolve. Both the default **and** the documented retry spec
(`pool/coding`) are dead. Run with no `TRIAGE_MODEL` set — which is how the routine's own doc
describes invoking it — and every single entry 400s. The relay's refusal is loud and correct; the
script is what is stale.

Tonight's run only produced anything because the pool was overridden by hand.

**2. Throughput cannot cover the file in one night.** On `pool/medium`, ~32 of 154 entries in ~35
minutes, with 2 rows lost to `Unexpected non-whitespace character after JSON` — the serving model
prepending prose despite `response_format`, the exact failure the script's own header warns about
for `deepseek-v4-flash`.

## Why "fix the pool name" is not the proposal

A one-line default bump fixes tonight and leaves the class untouched — the pool names will drift
again, the relay roster changes weekly, and the next fault will be a fourth new one. Three things
are missing, in increasing order of importance:

1. **The default must not name a pool.** A hardcoded `pool/fast` is precisely the
   *never-hand-maintain-a-table* rule applied to routing: the script is holding a stale copy of
   llm-relay's configuration. Ask the relay instead — it already answers
   `GET /candidates` and knows its own pool names — or drop the default entirely and **refuse to
   start** without an explicit `TRIAGE_MODEL`, which is honest and one line. A default that silently
   points at nothing is strictly worse than no default.

2. **A dead lane must fail loudly at entry 1, not silently at entry 154.** The script should probe
   its target once before the sweep and abort with the relay's own error message. Tonight it
   attempted every entry against a spec that could never work; last week it retried into a rate
   limit it could not see. Same shape: no preflight, so a transport fault is indistinguishable from
   a long slow run.

3. **Partial coverage must be a recorded fact, not a paragraph in the digest.** The script should
   write a completion stamp beside the JSONL — entries seen, classified, errored, skipped — so the
   routine reports leg-2 coverage from data instead of the operator eyeballing `wc -l`. Three nights
   running, the honest sentence *"the exhaustive sweep did not complete"* has been reconstructed by
   hand.

Item 3 is the one that ends the recurrence, because it converts a silent degradation into a signal.
Items 1 and 2 are what stop it happening again this month.

## What it would have caught

Tonight's 400-on-every-entry, before a single call. Last week's masked rate limit, at entry 1 rather
than after 74 failures. And the standing question the routine has answered wrongly three times —
*did leg 2 actually cover the backlog?* — becomes a number the run can read.

## False-positive surface

A preflight probe adds one request per run and can itself fail transiently, turning a recoverable
slow start into an abort. Mitigate by probing with the same retry policy as a normal entry, and by
making the abort message name the escape (`TRIAGE_MODEL=<spec>`), so a wrong preflight is a
five-second fix rather than a dead night.

Refusing to start without `TRIAGE_MODEL` costs a required flag, which the repo normally treats as a
bug signal (*"a needed manual flag is a bug signal"*). That rule is why option 1's **preferred** form
is asking the relay for a live pool name rather than requiring the operator to supply one — the flag
is the fallback, not the design.

## Scope note

This proposal is about the lane's health contract. The separate question of whether the probe
*stamps* it produces are trustworthy is P8 in this directory — two of tonight's three `premise: gone`
stamps came from probe targets that carry no evidence.
