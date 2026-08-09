# P18 — leg 2 is defined to escalate, and since 2026-08-06 its escalations cannot be written

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**A guard that fixed one direction silently closed another. Dated, and measurable in the
tracked item history: three runs, zero leg-2 items, four blocked questions.**

## The finding

`nightly-routine.md`'s leg table gives leg 2 exactly one thing it may not do alone:

> | **backlog** | … | Mechanical cleanup only … | **Any genuine disambiguation — turning a vague
> item into a spec is the owner's call** |

So leg 2's whole non-mechanical output is escalation. But an escalated item must carry a premise
probe, and `writeOpenItems` refuses a probe whose target is a record path
(`scripts/nightly/items.mjs:257-263`):

```js
const RECORD_PATH_PREFIXES = [
  'docs/backlog',
  'docs/reviews',
  'docs/HANDOFF.md',
  'docs/nightly-inbox.md',
  '.claude',
];
```

A leg-2 escalation is *about a backlog entry*. Its premise is prose in `docs/backlog/`. There is
frequently no code side at all — the question is "is this entry still worth keeping / what should
it become", not "does the doc match the code". So the only probe that could pin it is refused,
and the item cannot be written.

**The refusal is correct for what it was built for.** A probe on a record cannot *close* an item:
a backlog entry quotes the code it is about, so its own text vanishing says nothing about whether
the defect was fixed. That reasoning (in the module's own comment) is sound. It just also
governs *creation*, where the property needed is the opposite one.

## The before/after, from the tracked history

| | |
|---|---|
| `e2fa990a`, **2026-08-06 02:51** | `backlog-1` written — *"The test-tree conversion entry is fully shipped, but it is the ONLY home for three durable rules — rehome them and delete it, or keep the entry?"*, probe `{ file: "docs/backlog/open-bugs.md", contains: "Test-tree \`.mjs\`→\`.ts\` conversion: COMPLETE at its floor" }` |
| `9d307314`, **2026-08-06 09:24** | P8/P12 land; `RECORD_PATH_PREFIXES` begins refusing exactly that probe |
| `44137e5f` 08-07, `1d203e89` 08-07, `f02138eb` 08-08 | **0 backlog-leg items** out of 1, 1 and 3 |

`backlog-1` is the last leg-2 escalation the routine ever produced, and it would be rejected if
re-submitted today. Three runs since, none.

## The questions it has actually blocked

Four, across two nights, all real and all still unanswered:

1. **`~/.claude/llm-call.mjs` described as live** in six `durable-traps.md` passages and three in
   `open-bugs.md`. Recorded in the 2026-08-08 digest's *skipped* list with the reason stated
   outright — "it could not be raised as an open item because writeOpenItems refuses a premise
   probe aimed at docs/backlog". Now carried as `docs/HANDOFF.md` *Immediate next* item 5.
2. **`open-bugs#de319d16`** — an entry that has been telling its reader *"Before rebuilding this:
   name the process that rewrote the bytes, or close the entry"* since 2026-07-16. That is a
   close-or-keep decision, sitting unasked for three weeks. This run's sweep flagged it
   `already_shipped_or_stale`; verification refuted deletion, which leaves the decision — and the
   decision has no channel.
3. **`open-bugs#0487b95c`** — flagged shipped, verification found four live residuals (a, b, c, e),
   one of which is an explicit live-run watch. Whether a four-residual entry stays whole is a
   keep/trim call.
4. **This run's `already_shipped_or_stale` set generally** — five entries, one deleted after a
   reviewer+adversary pass, four needing judgment nobody can be asked for.

The consequence is worse than silence. Item 1's escape was to be written into `HANDOFF.md` by
hand, which is precisely the *"an escalation that lives only in one machine's untracked scratch
is lost"* failure the tracked-inbox design was built to end — displaced rather than solved. The
rest are in a *skipped* list, which the contract intends for coverage that could not run, not for
questions that could not be phrased.

## The mechanism

Split the refusal by DIRECTION, because it is enforcing two different properties under one rule.

- **Auto-close (`partitionBySettled` → `evaluateProbes` → `resolved`)**: keep the refusal exactly
  as it is. A record-path probe must never produce `absent`, must never produce `gone`, and must
  never close an item. Nothing here changes.
- **Creation (`writeOpenItems`)**: accept a record-path `contains` probe when the item declares
  itself non-auto-closing — an explicit `auto_close: false` on the item, refused unless every one
  of its probes is a record path. Such an item is verified at write (the fragment must be present,
  same as today), surfaces normally, and simply never auto-closes: it leaves the queue when the
  owner answers it, which for a "what should this entry become" question is the only correct exit
  anyway.

That is the whole change. It restores the pre-`9d307314` capability without restoring the bug: a
record-path probe still cannot manufacture a close, because the item that carries it is marked as
one that never closes that way.

### False-positive surface

The real risk is `auto_close: false` becoming the lazy default — an item that *does* have a code
side gets marked non-closing and then rides the queue forever, which is the exact failure the
subject-key ledger was built to end. Two cheap bounds:

- **Refuse the flag when any probe targets a non-record path.** If the item has a code side, it
  must auto-close off it. The flag is only reachable when *every* probe is a record path, so it
  cannot be used to opt a normal item out.
- **Surface `nights_open` for them like any other item.** The existing five-nights callout is
  already the backstop for a question that will not die; a non-closing item is exactly what that
  mechanism was written for.

## Not written as a patch

`writeOpenItems`, `evaluateProbes` and `partitionBySettled` are the contract three surfaces read
(the sweep's `premiseStamp`, `answer.mjs`, the inbox renderer), and the flag changes the shape of
a persisted item. That is a contract change, not a rule addition — the owner's call, and worth
pairing with the P17 decision since both touch probe evaluation.

## Verified, and not verified

**Verified:** the `RECORD_PATH_PREFIXES` list and both call sites, read from source; the two
commit timestamps and their order; the leg counts in `44137e5f` / `1d203e89` / `f02138eb`, read
from the tracked JSON at each commit; `backlog-1`'s exact probe, read from `e2fa990a`; that
`open-bugs#de319d16` and `#0487b95c` are live entries with open remainders, read in full.

**Not verified:** that no OTHER mechanism could have suppressed leg-2 items in those three runs —
they may simply have found nothing to escalate. The item counts are consistent with the
refusal being the cause but do not prove it; the four blocked questions are the direct evidence,
and item 1 is the one with a written record of the refusal firing.
