# P65 — a deletion-authorizing triage verdict must be earned by a probe

**Leg:** 3 (recurring-problem solutions). **Raised:** nightly run 2026-09-11.
**Status:** proposal only. Nothing is wired; leg 3 lands nothing.

## The recurrence, counted

`scripts/shared/triage-backlog.mjs` hands each backlog entry to a relay lane and
stores the lane's verdict. One verdict — `already_shipped_or_stale` — is the
only one that authorizes DELETING an entry. A separate stamp, `premise`, records
whether the entry's own quoted fragments could be checked against the tree.

The two are not coupled, so a row can claim "shipped" while establishing
nothing. One entry has been served that way on **five distinct dates**:

| Date | Entry | Verdict | Premise |
|---|---|---|---|
| 2026-08-27 | `forward-tracks#55883634` | `already_shipped_or_stale` | unprobed |
| 2026-08-28 | `forward-tracks#55883634` | `already_shipped_or_stale` | unprobed |
| 2026-09-09 | `forward-tracks#55883634` | `already_shipped_or_stale` | unprobed |
| 2026-09-10 | `forward-tracks#55883634` | `already_shipped_or_stale` | unprobed |
| 2026-09-11 | `forward-tracks#55883634` | `already_shipped_or_stale` | unprobed |

(The 2026-08-31 and 2026-09-06 sweeps classified the same entry
`accepted_residual_no_work`, so the row is not stable either.)

Every run refuted the lead by hand and wrote the refutation into its own skipped
block — the 2026-09-09, 2026-09-10 and 2026-09-11 records each say the same
thing in different words. The entry's prose says implementation was *assigned
outside this repository's agent loop*; being assigned elsewhere is not being
done, and that is not the code anchor a deletion requires.

## Why the existing statement does not hold it

The module header already states the rule. It says a `probes_unusable` row is
"never evidence for deleting an entry when paired with
`already_shipped_or_stale`". That is prose addressed to a reader, and the reader
it has to reach is a relay lane plus whichever agent reads the JSONL at 3am.
`CLAUDE.md`'s auditor-agnostic-robustness rule is explicit about this shape:
what can be enforced in tooling must be.

## The mechanism

`reviveRecord` already re-evaluates every stored row's premise at load, because
running the script IS the presentation event. Add one pure function to the same
module and call it there:

```js
// in reviveRecord, replacing the object it returns today
const { stamp: premise, recovered } = premiseVerdict(rec);
return downgradeUnearnedShippedVerdict({
  ...rec,
  premise,
  ...(recovered.length > 0 ? { premise_probes_recovered: recovered } : {}),
});
```

`downgradeUnearnedShippedVerdict` (full body in
`candidate-triage-downgrade.mjs`) rewrites `already_shipped_or_stale` to
`shipped_claim_unverified` when the premise is `unprobed`, `probes_unusable` or
`premise_unconfirmed`, and touches nothing else. `shipped_claim_unverified`
joins the verdict enum so the stamp can count it.

This removes the trap rather than guarding it: the unearned pairing becomes
unrepresentable in stored output, so no later reader has to re-derive that the
claim was empty.

## What it would have caught

The five rows above, at the moment each was written. A run would still see the
entry — as a claim that was not checked, which is what it is — but it would
never again read as a deletion lead, and the nightly would stop spending a
refutation on it.

## False-positive surface

A genuinely-shipped entry whose probes are unusable is downgraded too, so the
sweep under-reports deletions. That is the safe direction: the sweep is advisory
by contract and a deletion still requires the run's own code anchor. The measured
size of the class is in tonight's stamp — 27 of 89 rows carried unusable probes,
and exactly one of those 89 rows claimed `already_shipped_or_stale`.

Nothing else reads the verdict enum for control flow; `summarize-triage.mjs` and
the coverage stamp group by it, so both gain one bucket.

## Test

`unearned-shipped-verdict.test.mjs` — six cases: three premises that downgrade,
two that do not, and one non-deletion verdict that must pass through untouched.
Measured RED at HEAD and GREEN against the candidate: see `RED-AT.txt`,
`red-run.txt`, `green-run.txt`.

On acceptance the test moves to `tests/shared/` and imports the real module.
