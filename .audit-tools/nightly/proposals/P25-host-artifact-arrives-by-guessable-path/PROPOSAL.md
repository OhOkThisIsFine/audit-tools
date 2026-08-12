# P25 — a host-authored artifact reaches the tool by plain file write, so drift, absence and malformation are all shaped like success

**Leg 3. Proposal only — nothing landed.** Nightly run 2026-08-12.

This is the highest-recurrence problem in the corpus: three independent sweeps
converged on it.

## Recurrence

**Contract-drift half — 4 records, 4 distinct dates**

| record | date | measured rate |
|---|---|---|
| `docs/reviews/re-dogfood-2026-07-21.md` | 2026-07-21 | "Silent-destroy design-review ingest (HIGH)" |
| `docs/reviews/dogfood-run-2026-08-05.md` #3 | 2026-08-05 | **5 of 8** design-review agents missed the output contract (2 wrong filename, 1 wrong directory, 2 invalid JSON) — hand-repaired |
| `docs/reviews/dogfood-run-2026-08-06.md` lead 1 | 2026-08-06 | same class |
| `docs/reviews/dogfood-run-2026-08-08.md` O2/O6 | 2026-08-08 | **3 of 3** charter lanes drifted; running rate **9 of 10** offloaded lanes |

**Success-shaped-failure half — 4 records, 4 distinct dates**

| record | date | what |
|---|---|---|
| `re-dogfood-friction-2026-07-22.md` #12 | 2026-07-22 | a worker self-reported "valid, verified" on a malformed-JSON result file |
| `dogfood-run-2026-08-05.md` #2 | 2026-08-05 | same class |
| `dogfood-run-2026-08-06.md` lead 2 | 2026-08-06 | same class |
| `dogfood-run-2026-08-08.md` O5/O8/O12 | 2026-08-08 | the session ends **without ever calling Write**. Exit 0, no file, all work discarded — indistinguishable from success |

**Memory corroboration — 4 files, 3 dates:**
`success-shaped-empty-needs-affirmation.md` (2026-07-25, "a BROKEN lane reads as
a merely weak one"); `prefix-join-between-two-name-spaces-fails-empty.md` and
`llm-repair-of-a-derived-artifact-needs-a-postcondition.md` (both 2026-08-09);
`meta-audit-friction-must-be-tool-enforced.md` (2026-06-25).

Already tracked open at `open-bugs.md:477` and `:168` — **and reproduced after
being tracked** (2026-08-08). Tracking it has not stopped it.

## In scope after the retirement

Squarely inside the retained surface: the 467b1e8f directive keeps "result
**ingestion** (consumption, not execution)". This proposes nothing about routing,
execution, quota or providers.

## Mechanism — a design change, not a guard

Remove the well-known path. The tool should have **no read path for a
host-authored file at a location the host types**. Every incoming artifact arrives
only through a validating submit command that writes to a tool-owned path, and a
fan-out step records its expected shard set at dispatch so an absent shard reports
as **transport failure**, never as an empty-but-clean result.

That makes "the host used the wrong filename or directory" *unrepresentable* —
there is no filename left to get wrong — rather than guarding against it. This is
strictly stronger than the backlog entry's own stated property ("every incoming
artifact rides a tool-validated write"), which still leaves the path guessable.

Prefer-the-fix-over-the-guard applies directly here.

## What it would have caught

All 5 of 8 drifted 2026-08-05 design-review lanes; all 3 of 3 charter lanes on
2026-08-08; the 2026-07-22 malformed-result self-report; the 2026-08-08 lane that
exited 0 having never written.

## False-positive surface — stated honestly

It **removes hand-recovery**. Dropping a file into place to unwedge a run stops
working, and any partially-good shard is refused rather than absorbed — raising
the cost of a flaky lane from "host repairs it" to "re-run it". The sanctioned
recovery path (`audit-code force-synthesis`) already assumes tool-owned writes, so
this narrows an existing habit rather than adding a new restriction — but the
habit is real and currently load-bearing.

## Note on the related backlog entry

`open-bugs.md:477` compares these lanes against the **submit-packet lane, which
467b1e8f deleted** (0 hits in `src/`). Tonight's leg 2 proposes trimming that
stale comparison while keeping the entry and its open property. This proposal is
what would actually close it.
