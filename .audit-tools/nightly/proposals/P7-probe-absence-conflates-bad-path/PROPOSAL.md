# P7 — a probe path that does not exist reads exactly like a premise that vanished

## The defect, in one line

`evaluateProbes` maps `ENOENT` to `state: 'absent'`, so **a probe naming a path that was never
valid is indistinguishable from a probe whose code genuinely disappeared** — and all-absent is the
signal that means *this item is done*.

```js
// scripts/nightly/items.mjs — evaluateProbes
try {
  state = readFileSync(join(root, p.file), 'utf8').includes(p.contains) ? 'present' : 'absent';
} catch (err) {
  state = err && err.code === 'ENOENT' ? 'absent' : 'error';   // <-- here
}
…
const status = evaluated.every((p) => p.state === 'absent') ? 'resolved' : 'open';
```

"The file is not there" and "the file is there and no longer contains this" are different facts.
Collapsing them makes the strongest possible claim — *resolved* — out of the weakest possible
evidence: a typo.

## It is not theoretical. It is most of tonight's leg-2 output.

The premise stamp was added by determination `ea4e616f` precisely so triage verdicts would track the
CODE rather than the model's opinion. Measured over tonight's classified triage rows:

| Measure | Count |
|---|---|
| Probes emitted | 95 |
| **Probes naming a path that does not resolve** | **42 (44%)** |
| Rows carrying probes | 35 |
| Rows with ≥1 unresolvable path | 20 (57%) |
| Rows stamped `premise: gone` or `partial` | 27 |
| **…of those, resting on ≥1 unresolvable path** | **20 (74%)** |

The failure mode is mundane and completely reproducible: the model is told to emit "the
repo-relative path the entry names", it has **no repo access**, and it emits a bare filename.

```
open-bugs#36  premise=gone   proxyCatalog.ts               :: "expandSources"
open-bugs#45  premise=gone   providerConfirmationStep.ts   :: "| id | provider | model | $/Mtok |"
open-bugs#1   premise=gone   serve.mjs                     :: "stdio: 'ignore'"
```

Every one of those files exists exactly once in the tree — at a real path, under `src/…` or
`scripts/nightly/…`. None exists at the repo root, so each read throws `ENOENT`, each probe scores
`absent`, and the row is stamped `gone`: *this backlog entry's premise is no longer in the tree.*

That stamp is the input to a **deletion** decision. Leg 2's whole job is finding backlog entries
whose work already shipped, and its rule is that deletion needs a code anchor. A `gone` derived from
a nonexistent path is a code anchor pointing at nothing, wearing the costume of one.

## Why the existing refusal does not cover this

There *is* a refusal, and it is good — but it is on the other path:

- **`writeOpenItems` (nightly items):** refuses the whole batch if any probe is not `present` at
  creation. A bad path is caught loudly, immediately. **Protected.**
- **`triage-backlog.mjs` (leg 2):** calls the same evaluator through `premiseStamp` with **no
  refusal at all**. The model supplies the paths, nothing validates them, and the bad ones become
  the most confident verdict in the file. **Unprotected.**

This is exactly the shape `CLAUDE.md` names: *"A trap enforced only partly is NOT deletable — state
the uncovered half outright, or the covered half reads as a close."* The covered half has been
reading as a close since `ea4e616f` landed.

There is a second, smaller consequence on the protected path. Because creation refuses bad paths, a
persisted nightly item's probes were valid once — but if the file is later **renamed**, every probe
goes `absent` and `partitionBySettled` auto-closes the item as `resolved` without ever surfacing it.
The item contract already concedes this ("a rename mis-closes"). It is conceded because the evaluator
cannot tell the two cases apart. Fix the evaluator and the concession stops being necessary.

## The mechanism — distinguish the two absences, in one place

Split the state in `evaluateProbes`, which is the single place both consumers read:

- `present` — file read, fragment found.
- `absent` — **file read, fragment not found.** This is the only absence that means anything.
- `no-such-path` — `ENOENT`. Says nothing about the premise; says the probe is malformed.
- `error` — unreadable for any other reason (unchanged, still fails open).

Then let each caller apply its own policy, because they genuinely differ:

- **`resolved` requires every probe to be `absent`** — a `no-such-path` can never contribute to an
  auto-close, on either path. This alone removes the false-green.
- **`writeOpenItems`** keeps refusing anything not `present`, and its error message can now say
  *"that path does not exist"* instead of the misleading *"its premise is gone — drop it as
  resolved"*, which is advice that actively causes the wrong action when the real problem is a typo.
- **`triage-backlog.mjs`** stamps `premise: 'unprobed'` (or a new `'invalid-probe'`) when the row's
  probes are all `no-such-path`, so a bad probe degrades to *no signal* rather than to *shipped*.

Optionally, and cheaply: since the model reliably emits bare filenames and each resolves uniquely,
the triage script can resolve a bare filename against the tracked file list and accept it when the
match is unambiguous. That is a convenience, not the fix — the fix is that an unresolvable path must
never read as evidence.

### What it would have caught

Tonight, directly: 20 rows whose `gone` stamp is an artifact of a bad path, including candidates a
leg-2 deletion pass would have been entitled to act on. Going forward it also retires the
"a rename mis-closes" trade-off on the nightly path.

### False-positive surface

Effectively inverted — this proposal *removes* a false-positive class rather than adding one. The one
behaviour change to be deliberate about: items that would previously have auto-closed on a bad probe
will now stay **open**, so the digest may surface a few items that were silently vanishing. That is
the correct direction (mis-holding is recoverable, mis-closing is not), but it is a visible change in
queue size and worth expecting rather than being surprised by.

No contract shape changes: `premise_probes` stays `{file, contains}` and persisted items are
unaffected.

## Bound on this proposal

Leg 3 is propose-only; nothing here was applied, and `scripts/nightly/items.mjs` is untouched at
HEAD. Because the flaw is in the evidence rather than in a verdict, **no backlog entry was deleted
this run on the strength of a `premise: gone` stamp** — see this run's `skipped` note.
