# P45 — `check:memory-citations` covers one citation form; memories cite each other in the other one

Nightly leg 3, 2026-08-26. Propose-only. Patch + red-green test attached.

## The defect

`scripts/check-memory-citations.mjs` exists because a dangling citation is not a broken link —
it is how a superseded design gets re-asserted with the authority of a pointer nobody can
follow. Its own module header says exactly that.

It scans **tracked repo docs** for the `memory: <name>` prose form.

Memories cite **each other** in a different form: `[[name]]`. That form lives inside the memory
store, which the gate opens (to build the `known` set) and never reads. So the citation form
that the store is actually written in is the one form the gate structurally cannot see.

The consequence is not hypothetical. Pruning the store is the operation that creates dangling
pointers, and the index header of the store says so in as many words: deleting a memory has two
gates, and the `[[…]]` half is not one of them, *"which makes every prune a hand-audit."*

## Recurrence — counted, not asserted

Same class — *a citation gate that covers one syntactic form and is blind to the other* — on
four distinct dates, twice against this exact gate:

| Date | Where it was recorded | The gate's state |
|---|---|---|
| 2026-08-13 | nightly `sol-4` / `P29` — `check-doc-code-citations` blind to **directory** and **bare-filename** citations | widened to those two forms |
| 2026-08-14 | `docs/backlog/open-bugs.md` — *"`check:memory-citations` cannot see a `[[name]]` cross-link"*, with four dangling instances named | unchanged |
| 2026-08-19 | nightly `P37` — `check-doc-code-citations` blind to **un-backticked** citations; all ten mechanical gates ran green over a deleted path | widened to that form |
| 2026-08-25 | the memory-store prune (242 → 129 entries) wrote the gap into the index header as a standing caveat, and into `memory-prune-by-use-not-by-uniqueness.md` | unchanged |

The 2026-08-14 entry named four dangling links. Three of those four are gone — not repaired,
but carried away by the 2026-08-25 prune deleting the citing files. The entry's *instance list*
is therefore stale; its *property* is not, and the store still holds a live instance (below).
That is the shape the entry warned about: the defect is invisible, so it is repaired only by
accident.

## What it would have caught, at HEAD, right now

One real dangling cross-link across the 130-file store:

```
memory/opus5-low-effort-beats-sonnet-haiku.md:24 → [[delegate-bulk-work-off-fable]]
```

Line 24 reads *"Supersedes any tier-based reflex in `[[delegate-bulk-work-off-fable.md]]`"*. No
such memory exists — it was pruned. A reader following that pointer finds nothing, and the
sentence's whole claim is *what it supersedes*.

## The mechanism

Extend the same gate rather than add a second one — the store is already resolved and the
`known` set is already built, so this is the cheap half of a check that exists.

`apply-patch.mjs` (idempotent, refuses if the anchors moved) inserts a scan of the store's own
`.md` files for `[[name]]`, resolving each against `known` and reporting through the existing
`dangling` channel with a `form` tag so the two citation kinds are distinguishable in the
output.

Two normalizations, each earning its place:

- **A stray `.md` suffix is stripped before resolution.** The live instance is written
  `[[delegate-bulk-work-off-fable.md]]`. That is a misspelling of a target, not a second kind of
  link, and the gate's question is *does the note exist*, not *is the link well-formed*.
- **Inline code spans and fenced blocks are stripped first.** Text like `` `[[name]]` `` is
  documentation *of the syntax*, not a link.

## False-positive surface — measured, not estimated

Run against the real 130-file store, the patched gate reports **exactly one** finding: the real
dangling link above. Zero false positives.

Without the code-span rule it would report two more, and both are instructive: the index
header's own `` `[[name]]` `` placeholder and `memory-prune-by-use-not-by-uniqueness.md`'s
`` `[[…]]` ``. Both are prose *about* the form. The code-span rule removes exactly those and
nothing else, which is why it is the rule rather than a name-shape allowlist.

Scope is deliberately the memory store only. Tracked repo docs use `memory: <name>`; the only
tracked files carrying `[[name]]` are `.audit-tools/nightly/proposals/**`, which are
excluded-by-construction records that deliberately cite notes that may have been pruned since.
Widening to tracked docs would red the build on the proposal corpus.

## Consequence of landing it — state this before approving

The patched gate is **RED at HEAD** against the live store, because the live dangling link is
real. `check:memory-citations` is in `verify:checks`, so landing the patch alone reddens the
build until the pointer is repaired.

The repair is one line, outside the repo, and it is the owner's to make:
`memory/opus5-low-effort-beats-sonnet-haiku.md:24` — repoint `[[delegate-bulk-work-off-fable]]`
at the note that superseded it, or drop the citation. Leg 3 lands nothing, including this.

## Red-green evidence

`RED-AT.txt` carries the verbatim HEAD failure. In short: with a fixture store holding
`alpha.md` that reads *"Supersedes any tier reflex in `[[beta]]`"* and no `beta.md`, the
unpatched checker exits **0** and prints *"all citations resolve"*. After the patch the same
command is green, and the pre-existing `tests/shared/memory-citations-gate.test.ts` still
passes. Validated by inverting the production edit, never by `git checkout`.

Honest bound: only the dangling-link case is red-green evidence. The `.md`-suffix and
code-span cases pass at HEAD **vacuously** — nothing scans the store, so nothing can misfire on
them. They are false-positive guards that become meaningful only once the patch lands.

## Files

| File | Role |
|---|---|
| `apply-patch.mjs` | the edit to `scripts/check-memory-citations.mjs`, idempotent |
| `memory-crosslink-gate.test.ts` | lands at `tests/shared/memory-crosslink-gate.test.ts` |
| `RED-AT.txt` | the observed failure at HEAD, and the green after |

The test goes under `tests/` because vitest excludes `.claude/**`, so a test beside a hook never
runs. It uses `spawnSyncHidden` from `tests/helpers/spawn.mjs` — `execFileSync` imported straight
from `node:child_process` is refused across the whole test tree by INV-WH, which is what reddened
P43 on landing.
