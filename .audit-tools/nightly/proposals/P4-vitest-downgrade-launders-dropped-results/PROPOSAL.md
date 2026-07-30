# P4 — the false-RED fix can launder a real failure into a green release gate

**Leg 3 proposal. Nothing here has been landed.**

This supersedes [P2](../P2-vitest-false-red/PROPOSAL.md), which SHIPPED (`5fc913a8` / `605fe61e`).
P4 is a residual in the shipped mechanism, found by attacking it rather than by a new incident.

## Provenance — not a counted recurrence, and said so plainly

The routine's leg-3 bar is counted recurrence across separate entries and dates. **P4 does not
meet it and is not claiming to.** It has zero incidents: it is a defect found by adversarial
review of the fix that closed P2, in the direction P2's own text named as the dangerous one:

> "Swallowing a non-zero exit whenever `failed === 0` would turn an OOM'd worker or an unhandled
> rejection green *in a release gate*. … Condition 3 is what makes this safe, and it is the part
> that must not be dropped for convenience."

Condition 3 (`outcome.filesTotal` matches the expected count) **was** dropped, in favour of P2's
own stated fallback — a stderr error-signature allowlist. That substitution is where the hole is.
Surfaced here because a false-green in the release gate is the class the whole gate exists to
close, not because a pattern was counted.

## The mechanism, end to end

Three facts compose:

1. **`scripts/shared/vitest-timing-reporter.mjs:67-78`** buckets a leaf by `leaf.result?.state`.
   `pass` → `passed`, `fail` → `failed`, **everything else → `skipped`**. The comment says so
   outright: *"skip / todo / queued / any unfinished state — none of these are a pass."* A leaf
   whose result **never arrived** has `result === undefined`, so it is counted as `skipped`. It is
   never counted as `failed`.

2. **`scripts/shared/vitestGateVerdict.mjs:20`** —
   `HARNESS_FAULT = /\[vitest-worker\]:\s*Timeout calling "on[A-Za-z]+"/` — matches
   `onTaskUpdate`. That is the RPC that **carries task results** from worker to main process. So
   the downgrade fires in precisely the situation where result delivery is known to have failed.

3. **`isReporterTransportFault` (`:34-41`)** requires only `runToken` match, `outcome.failed === 0`,
   and the signature. `onFinished` still runs on the main process, so a ledger bearing the current
   token is written regardless of how many task updates were dropped.

Compose them. A genuine test failure whose `onTaskUpdate` was dropped:

| condition | value | why |
|---|---|---|
| vitest exit | nonzero | the failure is real |
| `outcome.failed` | `0` | the result never landed; the leaf was bucketed `skipped` |
| `runToken` | matches | `onFinished` ran on the main process |
| stderr signature | present | the dropped update IS the timeout |

→ `isReporterTransportFault` returns `true`, the gate prints "Treating as PASS" and exits 0.
**A red release gate turned green by the mechanism installed to stop false reds.**

The existing test at `tests/shared/vitest-gate-false-red.test.mjs` ("keeps the red when a test
actually failed") does not reach this: it covers a failure that *was counted*. A dropped result is
not a counted failure.

Note P2's original condition 3 would **not** have caught this either — the file is present in the
ledger with its leaves collected; only the leaf *results* are missing. `filesTotal` matches.

## Honest bound on severity

Under load the common shape of a vitest RPC timeout is the **ack** not returning while the payload
was already applied — results intact, nothing swallowed. So this is a probabilistic hole, not a
certain one, and it needs a failure and a dropped update in the same run. It is cheap to close,
which is the argument for closing it rather than a claim that it has bitten.

## Proposed mechanism — class (a), makes the trap unrepresentable

`skipped` must stop being the bucket that absorbs "we never heard back", because that bucket is
the one the downgrade trusts. Separate the two, then refuse the downgrade on any unfinished leaf.

**1. `scripts/shared/vitest-timing-reporter.mjs`** — split the else-branch:

```js
    for (const leaf of leaves) {
      const state = leaf.result?.state;
      if (state === "pass") {
        passed += 1;
      } else if (state === "fail") {
        failed += 1;
        failedFiles.add(rel);
      } else if (state === "skip" || state === "todo") {
        skipped += 1;
      } else {
        // No terminal result reached the main process — absent / queued / running.
        // This is NOT a skip: it is the absence of an answer, and the false-RED
        // downgrade must never treat it as one.
        unfinished += 1;
        unfinishedFiles.add(rel);
      }
    }
```

and carry `unfinished` (plus `unfinishedFiles`) in the returned outcome. `total` stays
`passed + failed + skipped + unfinished` so no count is lost.

**2. `scripts/shared/vitestGateVerdict.mjs`** — one added condition, with its rationale:

```js
  if (outcome.failed !== 0) return false;
  // A leaf with no terminal result is an unanswered question, not a pass. The
  // trigger signature is `Timeout calling "onTaskUpdate"` — the RPC that carries
  // results — so this is exactly the fault where a real failure can go uncounted.
  if ((outcome.unfinished ?? 0) !== 0) return false;
  return HARNESS_FAULT.test(stderrText ?? "");
```

`?? 0` keeps a ledger written by an older reporter from failing closed on every run; the field is
additive. If you would rather fail closed on an absent field, that is a deliberate one-run
transition cost — say so and it becomes `if (outcome.unfinished !== 0) return false;`.

**Why this and not condition 3.** Condition 3 asks "did every file report?", which the dropped-leaf
case answers yes to. This asks "did every collected test reach a terminal state?", which is the
property the downgrade actually needs and which the reporter already computes — it just merges it
into `skipped` on the way out.

## What it would have caught

Nothing historical — no such incident is recorded. It closes the stated hole in the shipped
mechanism, and it makes the reporter's own distinction (`:75`'s comment already knows these states
are different) visible to the consumer that depends on it.

## False-positive surface

A run with a genuine harness timeout **and** at least one unfinished leaf now stays red where it
would have been downgraded. That is the intended behaviour — the downgrade is only sound when the
ledger is complete — but it does mean the false-RED relief is narrower than it is today. If
unfinished leaves turn out to be common in the ordinary timeout shape, the relief this buys
shrinks toward zero and the honest response is to say so rather than loosen the predicate.

Everyday cost: none. No new command, no new gate, nothing an agent wants to do is blocked.

## Red-green tests

`tests/shared/vitest-gate-false-red.test.mjs` (extend; `vitest.config.ts` excludes `.claude/**`,
so these belong under `tests/`):

1. **RED before the change** — ledger with matching token, `outcome.failed === 0`,
   `outcome.unfinished === 1`, HARNESS_FAULT signature present, child exit 1 ⇒ gate must exit
   **nonzero**. Fails today (today it exits 0).
2. **GREEN guard, regression** — same but `unfinished === 0` ⇒ still downgrades to 0. The
   false-RED relief P2 shipped must survive.
3. **GREEN guard** — `unfinished` field absent entirely (older ledger) ⇒ downgrades to 0, proving
   the `?? 0` compatibility branch.
4. **Reporter unit** — `computeOutcome` over a task tree containing one `pass`, one `skip`, one
   `todo` and one leaf with `result === undefined` ⇒ `{passed:1, skipped:2, unfinished:1, failed:0}`
   and `total === 4`. Fails today: currently `skipped === 3`, no `unfinished` field.
5. **Reporter unit, regression** — a `fail` leaf still increments `failed` and lands in
   `failedFiles`.

Test 4 is the one that pins the actual defect; tests 1–3 pin the consumer.

## Also worth the owner's attention

This should probably exist as an entry in `docs/backlog/open-bugs.md` too — it is a live
false-green hole in the release gate, not merely a proposal. The routine did not add it: leg 2's
autonomy is mechanical cleanup only, and `open-bugs.md` is over its size budget, so a new entry is
the owner's call.
