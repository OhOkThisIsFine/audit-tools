# P68 — the P65 unearned-shipped downgrade is exported, tested, and called from nowhere

**Leg 3 (recurring-problem solutions). Proposal only — nothing in this
directory is applied.**

## What is wrong

`already_shipped_or_stale` is the one leg-2 verdict that authorizes deleting a
backlog entry. P65 (owner decision 2026-09-05, landed in `6b81dfb0` on
2026-09-15) made the unearned form of that claim unrepresentable in stored
output: a shipped verdict whose `premise` stamp establishes nothing about the
tree degrades to `shipped_claim_unverified`, which authorizes nothing.

`downgradeUnearnedShippedVerdict` in `scripts/shared/triage-backlog.mjs`
implements it correctly and is covered by
`tests/shared/triage-unearned-shipped-verdict.test.ts`. **No production code
calls it.** Both record-finishing paths compute the premise stamp and return:

- the write path (`buildRecord`, inside the `dispatchBoundedItems` options) sets
  the identity fields, sets `premise`, resolves `code_paths`, returns;
- the load path (`reviveRecord`, same options object) re-derives `premise` on
  every invocation, resolves `code_paths`, returns — under a comment that says
  in so many words *"P65 LAST, after the premise is re-derived … leaves revive as
  `shipped_claim_unverified`"*.

Neither calls the function. The comment describes a call that is not there, in
both places.

## The evidence, from the routine's own artifacts

`shipped_claim_unverified` appears in **0 rows across all 30 retained sweeps**.
The forbidden pairing it replaces appears in 30 rows across 22 dates; the two
that fall AFTER the mechanism landed are the whole measure of its reach:

| Sweep | forbidden pairing | downgrades written |
|---|---|---|
| 2026-09-16 | 1 (`already_shipped_or_stale` + `premise: unprobed`) | 0 |
| 2026-09-17 | 1 (`forward-tracks#55883634`, `premise: unprobed`) | 0 |

So the mechanism has had two opportunities and taken neither. The 20 earlier
dates are not evidence against the code — they predate it — they are the reason
the owner approved it.

Tonight's row is verbatim in `.audit-tools/nightly/triage-2026-09-17.jsonl`:

    "verdict":"already_shipped_or_stale", … "action":"Delete the entry as a
    stale pointer …", "premise_probes":[], … "premise":"unprobed"

A reader who trusts the sweep's stated contract would take that as a deletion
lead. It quotes no fragment and checked nothing.

## Why it happened — the same cause as P67

Both paths duplicate one fold (own the identity fields → stamp the premise →
resolve the paths) as an **anonymous inline closure** inside a big options
object. Nothing in the suite can reach either closure, so a step missing from
BOTH is invisible to every gate: `check:deadcode` sees the function as consumed
(its unit test consumes it), and no test exercises the path that should call it.
[[additive-export-without-adopter-fails-the-deadcode-gate]] covers the adjacent
case the gate DOES catch — an export with no consumer at all. This is the class
one step further on: an export whose only consumer is its own test.

## The mechanism

**Extract the fold, do not add a call.** One exported function, used by both
paths:

    export function finishTriageRecord(rec, { lane, servedBy, root = ROOT } = {}) {
      if (lane) rec.lane = lane;
      if (servedBy) rec.served_by = servedBy;
      const { stamp: premise, recovered } = premiseVerdict(rec, root);
      rec.premise = premise;
      if (recovered.length > 0) rec.premise_probes_recovered = recovered;
      const pathsRecovered = applyCodePathResolution(rec, (args) => trackedMatches(root, args));
      if (pathsRecovered.length > 0) rec.code_paths_recovered = pathsRecovered;
      return downgradeUnearnedShippedVerdict(rec);   // LAST — reads the stamp just computed
    }

`buildRecord` becomes `finishTriageRecord(buildTriageRecord(e, raw), { lane, servedBy })`;
`reviveRecord` becomes `finishTriageRecord(revivedWithUnresolvedPathsRestored(rec))`.
The load path keeps its own step that restores `code_paths_unresolved` into
`code_paths` before the fold — that is genuinely revive-only and stays there.

This is the fix-not-guard direction and it removes duplication rather than adding
a watcher: there is then ONE place where a record is finished, so a future step
cannot be present on one path and absent on the other.

Adopting it makes `downgradeUnearnedShippedVerdict` production-reachable, so its
existing unit test stops being its only consumer.

## What it would have caught

Tonight's row and 2026-09-16's, i.e. every opportunity the mechanism has had.
Going forward it catches the class the owner approved P65 for: a lane that
asserts an entry shipped while quoting nothing checkable — the exact answer one
entry was served on five distinct dates before P65 was written.

## False-positive surface

- **The downgrade's own accepted cost is unchanged** and is restated here only
  because adopting it makes it real for the first time: a genuinely-shipped
  entry whose probes are unusable is downgraded too, so the sweep under-reports
  deletions. That is the safe direction, and a deletion still needs the run's
  own code anchor.
- **Idempotency on the load path.** `reviveRecord` runs on every invocation, so
  a stored `shipped_claim_unverified` row is re-finished. It must not be
  re-upgraded: the downgrade only ever reads `already_shipped_or_stale`, so a
  downgraded row passes through untouched. The third test in this directory
  pins that.
- **Mutation.** The sketch mutates `rec` as today's closures do. If it is
  preferred pure, copy at entry; the tests do not depend on either choice.

## Red proof

`RED-AT.txt` records the verbatim failure at HEAD `ae7e09a9`.

## Relationship to P67

Same file, same structural cause, independent properties: P67 is the coverage
stamp not counting `unprobed` rows; this is the downgrade not running. Either can
be accepted alone. If both are accepted they should land as one commit, because
both touch the same options object and the second would otherwise re-open the
first's diff.

## Scope

**This repository.** `scripts/shared/triage-backlog.mjs` only.
