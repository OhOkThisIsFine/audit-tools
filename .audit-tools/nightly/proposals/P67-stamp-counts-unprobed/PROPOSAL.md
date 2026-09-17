# P67 — the leg-2 coverage stamp does not count the rows that were never premise-checked

**Leg 3 (recurring-problem solutions). Proposal only — nothing in this
directory is applied.**

## What keeps happening

Leg 2 writes a coverage stamp beside its JSONL so that "did the sweep cover the
backlog" is a number a routine READS rather than a count it eyeballs. Each
classified row also carries a `premise` stamp — `holds`, `partial`,
`premise_unconfirmed`, `probes_unusable` or `unprobed` — recording whether the
entry's own quoted fragments could be checked against the tree.

The stamp counts exactly one of those five classes. `stampExtra` in
`scripts/shared/triage-backlog.mjs` increments `probes_unusable` and nothing
else, so a row stamped `unprobed` — the lane quoted nothing checkable at all —
leaves no trace in the stamp a reader is told to trust.

The module's own header already states the intended behaviour, and states it as
done: a `probes_unusable` row is "visibly distinct from one that honestly quoted
nothing checkable, **counted in the coverage stamp**". Only the first half
shipped. So the defect is not a missing idea; it is a wired-up half.

## Recurrence, counted

Every sweep in the retained record carries rows the stamp does not mention.

| Sweep | rows | `unprobed` | stamp reports |
|---|---|---|---|
| 2026-08-09 | 121 | 88 | (no `probes_unusable` field yet) |
| 2026-08-14 | 55 | 20 | `probes_unusable: 16` |
| 2026-08-27 | 107 | 39 | `probes_unusable: 33` |
| 2026-08-28 | 131 | 31 | `probes_unusable: 47` |
| 2026-09-06 | 99 | 35 | `probes_unusable: 0` |
| 2026-09-09 | 89 | 28 | `probes_unusable: 16` |
| 2026-09-11 | 89 | 6 | `probes_unusable: 27` |
| 2026-09-16 | 34 | 5 | `probes_unusable: 7` |
| 2026-09-17 | 48 | 20 | `probes_unusable: 8` |

Across the 30 retained sweeps: **2,366 classified rows, 760 of them `unprobed`
(32%)** — not one of which the stamp names. The count is mechanical and
reproducible from the retained artifacts; `.audit-tools/nightly/recurrence-0917.mjs`
is the script that produced the table.

Tonight's run is the sharpest instance because the relay routed every row to a
CLI rung (`agy-gemini`) rather than the free pool, and that rung supplies probes
far less often: 20 of 48 rows `unprobed` (42%), against 6 of 89 (7%) on the
2026-09-11 free-pool sweep. So the size of what the stamp hides is not a
constant — it moves with a rung choice the sweep does not make and must not make
(owner decision 133f4f815b608ea4: the relay owns lane choice). A reader cannot
compensate by habit.

## The second half of the same defect

The counter is also per-INVOCATION while the premise stamps are re-derived for
the whole FILE on every load (`reviveRecord`, so a record whose quoted fragment
vanished reads as unconfirmed now rather than carrying last week's verdict). On
a resumed run the two disagree: the 2026-08-22 JSONL holds 33 `probes_unusable`
rows and its stamp says 5; 2026-08-18 holds 18 and says 2; 2026-09-10 holds 21
and says 0. Whichever way the fix goes, the stamp should describe the same set
of rows the file holds, or say which set it describes.

## The mechanism

Give the counter a name and a declared class list, and count all five classes
(`patch.diff` in this directory):

1. **`PREMISE_STAMP_CLASSES`** — the exported, frozen list of every premise
   stamp `premiseVerdict` can emit.
2. **`TRIAGE_STAMP_INIT`** — the counters seeded from that list, so a class
   cannot exist without a counter.
3. **`countTriageStamp(stamp, rec)`** — the pure, exported fold that replaces
   the anonymous inline closure. Naming it is what makes the property reachable
   by a test; the closure was invisible to the suite, which is why a
   half-wired counter survived 30 sweeps.
4. The stderr coverage line and the field list in `docs/nightly-routine.md`
   (a read-verbatim contract, per `scripts/shared/lane-dispatch.mjs`) name the
   new counters.

This is the fix-not-guard direction: nothing new watches the sweep. The class
list the records already use becomes the same list the stamp is built from, so
the two cannot diverge again.

## What it would have caught

Every row in the table above — most immediately, tonight's report that 44 of 61
backlog entries were "classified" without disclosing that 20 of those verdicts
rest on no premise check whatsoever. The consequence is not academic: leg 2's
deletion authority is gated on the premise stamp (P65's unearned-shipped
downgrade), so a reader who trusts the stamp's silence over-reads how much of
the sweep is evidence.

## False-positive surface

None on the analysis side: the change adds counters and removes no check, so no
verdict changes and nothing new can refuse. Two real risks, both narrow.

- **A stamp consumer reading by exact field set.** `lane-dispatch.mjs` calls the
  field list a read-verbatim contract with the routine doc. The patch is
  additive, and the doc half is in the same patch; a consumer that enumerates
  fields rather than reading them by name would see five new keys.
- **`Object.freeze` on `TRIAGE_STAMP_INIT`.** The frozen object must be spread
  into a fresh stamp, never mutated; the patch spreads it at the one call site
  and the test's own setup does the same, so the misuse is pinned rather than
  left to a reader.

## Red proof

`RED-AT.txt` records the verbatim failure at HEAD `ae7e09a9`, and states why the
red is an absent export rather than an assertion mismatch: at HEAD the counter
is an anonymous closure with no name a test can reach.

## Scope

**This repository.** The defect is in `scripts/shared/triage-backlog.mjs` and
the field list in `docs/nightly-routine.md`; nothing about it generalizes to
another checkout.
