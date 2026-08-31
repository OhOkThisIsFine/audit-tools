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
  ⚠ **Residual risk:** a *persistently* undeletable staging file would abort every future
  invocation at the same point. Transient EBUSY self-heals; a permission fault does not.
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

This is a gate-reach defect, not a retirement. It is stated here rather than fixed here, because
widening the loop-core set changes which future commits require an attestation — an owner call.
