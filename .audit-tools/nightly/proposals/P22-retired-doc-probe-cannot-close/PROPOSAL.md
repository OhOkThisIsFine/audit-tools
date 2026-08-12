# P22 — a probe on a RETIRED doc can never close its item

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
Found by the 2026-08-12 nightly while re-evaluating its own queue.

## The problem, in one line

An item auto-closes when the doc it is about is **edited**, but never when that
doc is **deleted** — and "retire this doc" is the single most common thing leg 1
asks the owner.

## How it surfaced

Open item `docs-1` (2 nights) asked the owner to *retire or supersede the
dispatch/quota/routing design docs whose subject the (d) directive deletes*. Its
two premise probes were:

| probe file | `contains` fragment |
|---|---|
| `spec/backend-identity-axes.md` | `it does not remove the identities required for quota` |
| `spec/dispatch-quota.md` | `This spec owns the whole dispatch/quota model as one subject` |

Commit `467b1e8f` **deleted both files**. `git grep -F` finds neither fragment
anywhere in the tracked tree — the only surviving copy is inside
`open-items.json`, the queue's own record of the question.

So the asked-for work landed, and the item still re-surfaced tonight.
`partitionBySettled` returned it as `open`, with both probes evaluating to
`untrackable / untracked`.

## Mechanism

`scripts/nightly/items.mjs`, in `evaluateOneProbe`:

```js
if (!isTrackedPath(root, probe.file)) return { state: 'untrackable', reason: 'untracked' };
```

That check short-circuits **before** the missing-file chain further down — which
already answers this question correctly and with git evidence:

- fragment lives elsewhere in the tree → `moved` (item stays open — the prose
  was relocated, not retired)
- file has history, fragment nowhere → `absent` + the removing commit → the item
  resolves
- file has no history at all → `bad_path` (a typo'd probe, never a close)

A deleted file is untracked, so it takes the `untrackable` branch and none of
those three verdicts is ever reached. **All three are dead code today** — the
red run below shows a `moved` case and a `bad_path` case both collapsing to
`untrackable`, which means the mis-close protection that made the close path
safe has never actually run in this scenario.

## Why the untracked check exists, and why it is over-broad

Its purpose (P8, owner decision sol-1 2026-08-06) is to refuse a probe aimed at a
**gitignored runtime artifact** — `.audit-tools/audit/…`, a file whose content
varies per run and so can never be evidence. That case is real and must stay.

But it is characterised by *untracked **and present on disk***. A deleted tracked
file is *untracked **and absent from disk*** — the opposite situation, and one the
code below already handles. One predicate was covering two unrelated cases.

## Proposed fix

Abstain only when the path is untracked **and still exists**; otherwise fall
through to the existing evidence chain. See [`patch.md`](patch.md).

This adds **no new closing authority**: the close still rests on the repo-wide
`git grep` plus `git log --all --full-history`, and a git failure still yields
`unknown` (fail-open), so a broken git can never manufacture a close.

## What it would have caught

- `docs-1` tonight — an item whose work landed 2 nights ago, still being served
  to the owner. This is precisely the false-RED the probe machinery was built to
  prevent (2026-07-25: 15 of 21 surfaced items were already fixed at HEAD).
- Every future leg-1 "retire this doc" escalation, which is the modal leg-1 ask.
  The doc-review rubric's own condensation pass generates retire/fold proposals
  by design, so this failure mode is structural, not incidental.

## Recurrence evidence

The general defect class — *a queue item that outlives its premise* — is the most
repeatedly-recorded problem in this project's memory, across distinct dates:

| record | date | what recurred |
|---|---|---|
| `queue-items-must-be-rechecked-at-presentation` | 2026-07-25 | 15 of 21 surfaced items already fixed at HEAD |
| `probe-quoted-from-prose-manufactures-gone` | 2026-08-09 | probe verdicts wrong 3 times out of 3 |
| `a-refusal-correct-for-closing-can-be-wrong-for-creating` | 2026-08-09 | one refusal enforcing two opposite directions — **the same shape as this bug** |
| `nightly-settled-means-answered-not-executed` | 2026-07-28 | answered ≠ landed; twelve answers invisible |
| this run | 2026-08-12 | a retired doc cannot close the item that asked for its retirement |

Five records, four distinct dates. The 2026-08-09 entry is the direct precedent:
a single predicate serving two directions that need opposite properties. This is
that lesson recurring in a second place.

## False-positive surface — stated honestly

1. **A doc deleted while its prose is genuinely still live elsewhere.** Covered:
   `git grep` over `PREMISE_GREP_PATHSPECS` returns `moved` and the item stays
   open. This is tested (third case below).
2. **A probe file that was renamed.** The fragment moves with the rename, so
   `moved` fires. Only a rename that *also* rewrites the fragment closes the
   item — the same accepted trade-off the contract already documents for
   `contains` probes.
3. **A path that was never tracked and does not exist (a typo).** Now reaches
   `bad_path` instead of `untrackable`. Both are non-closing, so behaviour is
   unchanged for the item; the verdict is simply more accurate.
4. **Genuine new risk:** an untracked-and-absent path that a future caller
   *intends* as a runtime artifact reference would now consult git history
   instead of abstaining immediately. Since the artifact is absent, history is
   empty, and it lands on `bad_path` — still non-closing. No close is reachable.

I could not construct a case where this closes an item the current code holds
open other than the intended one.

## Where the mechanism belongs

**Contract test**, not a hook. The trap is a property of the tree evaluated at
presentation time, not something detectable at a tool call. Tests go under
`tests/` — vitest excludes `.claude/**`, so a test beside a hook never runs.
Proposed home: `tests/shared/nightly-probe-retired-doc.test.ts`, alongside the
existing `nightly-probe-target.test.ts` which owns the sibling P8 rule.

## Red-green validated

Test written first, run against HEAD, then against the patch — both recorded in
[`patch.md`](patch.md).

- **RED at HEAD:** 3 failed / 2 passed. `absent`, `moved` and `bad_path` all
  came back `untrackable`.
- **GREEN with the patch:** the new file plus the three existing nightly suites
  (`nightly-probe-target`, `nightly-routine`, `nightly-completion-ledger`) —
  **4 files, 90 tests, all passing**, no regressions.

## Action taken tonight

`docs-1` was **dropped from the queue by hand** for this run: its premise was
verified gone (both files deleted; fragments absent from the whole tracked tree).
That is a one-off manual correction. The patch is what makes the next one
automatic — which is the point, since a correction that depends on an agent
noticing is exactly what this repo's robustness rule forbids.
