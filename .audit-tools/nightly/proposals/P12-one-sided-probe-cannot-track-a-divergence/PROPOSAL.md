# P12 — a one-sided premise probe cannot track a divergence

## The trap

A nightly item's premise is almost always a **relation between two locations**: the doc says
X, the code says Y. A `premise_probe` is a fact about **one** location — a literal string that
must be present in one file. So the probe tracks one endpoint of the relation, and the item
survives or closes on that endpoint alone.

When the endpoint the probe pins is the one that moves, the item closes correctly. When the
*other* endpoint moves, the probe still passes, the item is surfaced again, and its stored
`options[]` — written against the old state of the world — now describe the **wrong edit**.

## Recurrence evidence

Two distinct instances, two distinct nights, same subsystem (the probe contract):

| Date | Item | Shape |
|---|---|---|
| 2026-08-05 | `sol-1` (P8) | Probe aimed at a gitignored/untracked path reports `absent`, and `absent` is the verdict that CLOSES an item. A probe that cannot read its target closes the item it was meant to protect. |
| 2026-08-06 | this one | Probe pins the DOC side of a doc-vs-code divergence; the CODE side moved to match, and the item stayed open carrying an option that would re-introduce the error. |

Both are the same underlying defect: **the probe's truth value is not the item's truth value.**

### The concrete instance, fully traced

`docs-1` (subject `d58dbfc3bbc8ef8b`) and `docs-2` (subject `e0c4fbe93a7814ef`) were written on
2026-08-05 against HEAD `563f7c09`, when:

- `spec/audit/artifact-contract.md:17` said `— 38 entries`, and `ARTIFACT_DEFINITIONS` had **37**.
- `spec/audit/executor-catalog.md:10` said `— 28 entries`, and `EXECUTOR_REGISTRY` had **27**.

Their probes were, respectively, `{ file: "spec/audit/artifact-contract.md", contains: "— 38 entries" }`
and `{ file: "spec/audit/executor-catalog.md", contains: "— 28 entries" }` — the doc side only.

Between that run and HEAD `2b6ba83e`, two commits landed:

- `3fb84823` added `docs_digest: jsonArtifact("docs_digest.json", "analysis")` to
  `src/audit/io/artifacts.ts` → the registry became **38**.
- `52d9b25c`/`3fb84823` added `id: "docs_digest_executor"` to
  `src/audit/orchestrator/executors.ts` → the registry became **28**.

Verified at HEAD: both registries now hold exactly the counts the docs state. **The divergence is
gone and both docs are correct.** But both probes still pass, so `partitionBySettled` would have
re-surfaced both items tonight, each offering *"Correct it to 37"* / *"Correct it to 27"* — edits
that would now **introduce** the very error the item was raised to remove.

This run dropped both items by hand after verifying the registries. Nothing mechanical would have.

## Why this is not just sol-1 again

`sol-1` is a probe that cannot READ its target. This is a probe that reads its target correctly and
is still answering the wrong question. Fixing the read path does not touch this.

## The mechanism

Two candidate shapes, in preference order.

### (A) Preferred — forbid the item class rather than patch the probe

A **computed-value divergence** (a count, a length, a total) has no literal string on the code side
to probe. There is nothing to quote: the fact is `Object.keys(ARTIFACT_DEFINITIONS).length`, which a
`contains` probe cannot express at all. For this class the probe mechanism is not weak — it is
*inapplicable*.

So: an item whose premise is a hand-typed count in a doc is **not raised as a doc-review item**. It
is raised once as a request to **gate the number** — which is exactly the open `sol-3`
(`P10-registry-counts-are-hand-maintained`). Once a count is machine-verified, this whole item class
stops existing, in both directions, and tonight's inversion becomes impossible rather than
detectable.

This is the "prefer the fix that removes the trap over the guard that catches it" rule applied
literally. It also means **`sol-3` should be read as higher-value than it looked last night**: the
count drifted *twice in two nights, in opposite directions*, which is stronger recurrence evidence
than the single instance it was filed with.

### (B) If items of this shape are still wanted — make the probe two-sided

Extend `premise_probes[]` with a negative form:

```text
{ file, contains }        # existing: this string MUST be present
{ file, absent }          # new: this string MUST NOT be present
```

and require that an item naming two locations carries at least one probe per location.
`writeOpenItems()` enforces the count structurally, the same way it already refuses a batch whose
probes fail at creation. `partitionBySettled` then auto-closes when *either* side's probe stops
holding — which is the correct semantics for a divergence: the relation is resolved as soon as
either endpoint moves.

⚠ (B) does **not** rescue the count case — see (A); there is still no string to write. (B) is worth
building only for divergences where both sides are quotable prose or code text.

## What it would have caught

Tonight's two items, before they could offer a corrupting edit. Under (A) neither would have been
raised in the first place.

## False-positive surface

- **(A)** narrows what the routine may raise. The cost is real: a genuinely wrong count in a doc
  that nobody has gated goes unreported until the gate is built. Mitigated by the fact that the
  gate request itself is the item.
- **(B)** an `absent` probe is a rename magnet — the string vanishes on any refactor that touches
  it, closing the item early. Same accepted trade-off the routine already documents for `contains`
  ("a rename mis-closes"), but it lands on the opposite failure: `contains` mis-holds on rename,
  `absent` mis-closes. Pick the probe string to be the fragment whose disappearance genuinely means
  resolved, not a symbol name.

## Files

- `scripts/nightly/items.mjs` — `writeOpenItems()`, `partitionBySettled()`.
- `docs/nightly-routine.md` — *Machine output contract* owns the probe rules and would need the
  new form or the new prohibition written into it.

No patch is included: (A) is a policy change to the routine doc plus the already-proposed `sol-3`
gate, and (B) should not be built unless the owner declines (A).
