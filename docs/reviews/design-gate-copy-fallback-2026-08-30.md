# Design gate — the two swallowed deletes in `foldTransaction.ts` (2026-08-30)

Pre-implementation gate for [`open-bugs.md`](../backlog/open-bugs.md) — *Two more swallowed deletes
in `foldTransaction.ts`*. Written before any production edit.

**Required property.** A copy-then-delete fallback that cannot delete its source fails, or records
that the source survived. It never reports success while leaving a file a later pass re-processes.

## 1. Retirement verdict — clean, with one live constraint

No source retires "throw when the delete fails". The evidence sweep:

| Source | Result |
|---|---|
| `CLAUDE.md` standing decisions and invariants | Nothing on this class. |
| [`durable-traps.md`](../backlog/durable-traps.md) | No entry names these functions. |
| Project memory index | No entry names these functions. |
| `git log -S` over `foldTransaction.ts` | `30e3b812` is the **precedent, in this same direction**: the sibling instance in `commitFold`'s applied branch now rethrows anything but ENOENT. |

**The one live retirement that constrains the design.** The header of
`tests/audit/submission-staging.test.ts` records that **unlink deferral was refuted**: "a deferred
deletion creates a re-consumption path, and a re-consumed systemic-challenge round reports a quiet
round and converges the adversary loop falsely and permanently". Staging is its decided replacement.

Consequence: the *record* arm of the property must stay a **record**. A queue of failed deletes to
retry later is the refuted mechanism in a new shape, and is not available.

## 2. Adjacent strands — the two functions need OPPOSITE arms

This is the gate's substantive finding. A single uniform "throw on failed unlink" is wrong.

### `moveFile` — throw is correct

Three call sites, all in `foldTransaction.ts`:

- **`stageLaneSubmission` (line 162).** Already wraps `moveFile` and rethrows any non-missing error,
  *before* `tx.staged.push`. A throw consumes nothing, records no ledger event, and leaves the bound
  file intact for the retry. Today's behaviour is the harmful one: it stages a copy, the commit then
  deletes the staging copy and records `accepted`, and the bound original waits for the next fold to
  consume a second time — a duplicate consumption behind an `accepted` event.
- **The recovery sweep (line 250).** Runs inside the artifact-tree hold but *outside* the
  commit-on-throw `try`, before `loadArtifactBundle`. A throw aborts the whole `next-step` with
  nothing staged and nothing lost, and the next invocation retries recovery.
  ⚠ **This section first claimed a persistently undeletable staging file would abort EVERY future
  invocation at the same point. That was WRONG, and the independent lane caught it** (§5). The next
  run does not repeat the throw: run 1's `writeFile` already landed the content at the bound path,
  so run 2's `readFile(boundPath)` succeeds, `boundOccupied` is true, and the sweep takes the
  quarantine branch instead — which RECORDS rather than throws, and `continue`s. The failure mode is
  a recorded repeat, not a wedge. Confirmed at source.
- **`commitFold`'s un-applied restore (line 300).** The caller already rethrows any non-missing
  error, so a throw escapes `commitFold`. Note the restore's own goal is already met when the unlink
  fails: the copy put the content at the bound path. What survives is the staging duplicate.

### `quarantineSubmissionFile` — throw is WRONG; it must record

Verified at the call sites, not assumed. Every quarantine caller awaits the quarantine and *then*
records a `rejected` ledger event (`nextStepHelpers.ts:792` → 797, `:841` → 842, and the sibling
sites). A throw from the quarantine therefore:

1. suppresses the `rejected` event that explains the refusal,
2. leaves the malformed submission at its bound path, and
3. makes the next fold fail identically — a **permanent wedge with no ledger record**.

That is strictly worse than today, where the run continues and the repeat is merely unbounded. So
this half takes the property's *record* arm: report that the source survived, and let the refusal
event say so. Recording does not stop the repeat; it stops the repeat from being silent.

## 3. The failing test — red, on both halves independently

`tests/audit/copy-fallback-delete-failure.test.ts`. It mocks `rename` to fail with EXDEV (forcing
the copy fallback) and `unlink` to fail with EBUSY (stranding the source), so it depends on no real
filesystem quirk and behaves identically on every OS.

Confirmed red against the unfixed tree, each half failing on its own function:

```
× stageLaneSubmission does not report a submission staged while the bound file survives
  AssertionError: promise resolved "{ status: 'staged', staged: { …(5) } }" instead of rejecting
× quarantineSubmissionFile does not report a file quarantined while its source survives
  AssertionError: promise resolved "'C:\Users\ethan\AppData\Local\Temp\cop…'" instead of rejecting
```

⚠ **The second half's assertion pins the wrong arm and must be rewritten** before the fix, per
finding 2: it currently demands a throw from `quarantineSubmissionFile`. The red proof above is
still valid evidence that the call reports success over a surviving source — that is the defect —
but the green condition has to become the recorded-survival shape, not a rejection.

## 4. Out-of-scope finding — `foldTransaction.ts` is NOT loop-core

Found while sizing this change, and it is not about this change alone.

`src/audit/cli/foldTransaction.ts` is absent from `LOOP_CORE_PATTERNS`
([`src/shared/loopCorePaths.ts`](../../src/shared/loopCorePaths.ts)) and has never been in it
(`git log -S'foldTransaction'` over that file returns nothing). The file was created by `b4a3eb4a`
(CX-02), and `quarantineSubmissionFile` moved into it from
`src/audit/cli/nextStepHelpers.ts:693` — which **is** loop-core, then and now.

So a refactor moved the fold's staging and commit core out of attestation coverage, silently. The
file whose own header calls `commitFold` "THE commit — the fold's one core write boundary, run on
EVERY fold exit including the throw path" is not covered by the gate that governs loop-core commits.
No `guard-reach-data.mjs` row claims it either.

This is a gate-reach defect, not a retirement. The owner widened the set in this lap
(2026-08-30), which closes the instance; the CLASS — a symbol leaving loop-core coverage by being
moved — is an [`open-bugs.md`](../backlog/open-bugs.md) entry.

## 5. Independent refutation — ran late, and it CORRECTED this record

Step 3 of the gate did not run before the code, and that is stated rather than hidden. The
`claude-free-pool` lane was dispatched first and ran **23 minutes without returning**, so the
design work above was done by the authoring session alone. The `agy-claude-opus` lane was then tried
and came back quota-exhausted in 16s. `agy-gemini` answered in **45 seconds**, fully cited.

⚠ **This repeated a mistake the record already held.** The friction walk of the *two-identities*
lap, in this same backlog, states: the pool lane ran 14 min with no answer while agy answered the
identical prompt in ~4 min, and *"for a repo-reading refutation, prefer agy and hand it the recon
map"*. That instruction was not followed here, and the same 20+ minutes were spent again.

Its verdict, each claim re-verified against source before being accepted:

1. **The asymmetry is correct**, and it supplied a stronger argument for it than this record had: if
   `moveFile` swallowed the failure in the recovery sweep, the surviving staging file would make the
   NEXT pass read `boundOccupied` as true — because the copy already wrote the bound path — and it
   would then quarantine and reject a submission that is perfectly valid.
2. **Corrected the wedge claim** — folded into §2 above.
3. **The survival note reaches a durable record, not just the console.** Verified:
   `recordLaneOutcome` forwards `message` into `appendSubmissionEvent`, which persists to the
   submission ledger. It also confirmed no operator command in this repo targets
   `submission-staging/` — `grep` over `recoverSubmissionCommand.ts` and `cleanupCommand.ts` returns
   nothing.
