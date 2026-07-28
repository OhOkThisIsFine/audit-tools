# `intent-equivalence-verdict.json` — endpoint trace and disposition (2026-07-28)

Nightly `docs-3` approved registering `intent-equivalence-verdict.json` in `ARTIFACT_DEFINITIONS`.
`/design-check` reopened it: the DD-9 design explicitly retired a persisted verdict-pair cache.
The owner asked for both endpoints to be traced before the collision was settled.

## What the trace found

The premise of BOTH sides was incomplete. The real defect is neither a missing registry row nor a
contradicted design — it is a **spec label that is factually false for this file**.

`spec/audit/artifact-contract.md` gives two files the identical description prefix
`Durable host input:` — and they have opposite lifecycles.

| | `critical-flow-fallback.json` | `intent-equivalence-verdict.json` |
|---|---|---|
| In `ARTIFACT_DEFINITIONS` | **yes** — `src/audit/io/artifacts.ts:245` | **no** |
| In the staleness DAG | **yes** — a declared leaf, `dependencyMap.ts:56,68` | **no** |
| Executor reports it written | **yes** — `artifacts_written: ["critical-flow-fallback.json"]` | **no** — `artifacts_written: []` at all five exits |
| Persists after consumption | **yes** — merged into `critical_flows.json`, file remains | **no** — `unlink`ed |
| Where the value ends up | the artifact itself is the durable input | `artifact_metadata.intent_baseline` |

`critical-flow-fallback.json` genuinely is a durable host input: a registered, DAG-participating
leaf. `intent-equivalence-verdict.json` is a **transient host submission**: written to
`incoming/` (`nextStepCommand.ts:1341`), validated and consumed
(`nextStepHelpers.ts:1198-1210`), then `unlink`ed. The executor materializes the accepted judgment
into `artifact_metadata.intent_baseline` and writes no artifact at any of its five exits
(`intentEquivalenceExecutor.ts:132,150,184,220,240`).

That is exactly the behavior DD-9 specified: *"No verdict-pair cache is persisted: a verdict is
materialized into the entry/baseline at commit, so a seen pair never re-fires"*
(`intent-gate-charter-slice-design-2026-07-23.md`). Runtime and design agree. Nothing is broken.

## Why the nightly answer went wrong

The shared `Durable host input:` prefix is the whole cause. Reading the table, the two rows look
like the same kind of thing; one of them IS registered, so registering the other reads as an
obvious consistency fix. The answer was a correct inference from a table that misdescribes one of
its rows.

This is a documentation defect that manufactures work, not a contract gap.

## Disposition

**Option (a), and narrower than stated.** The registry status is already correct — do not add the
row. Correct the label instead, so the row states its actual lifecycle and stops generating this
proposal:

- `intent-equivalence-verdict.json` is relabeled **Transient host submission**, stating that it is
  staged under `incoming/`, consumed and deleted, and materialized into
  `artifact_metadata.intent_baseline` — never registered and never a staleness-DAG participant.
- `critical-flow-fallback.json` keeps `Durable host input:` and now says so explicitly (registered,
  a DAG leaf), so the two categories are visibly distinct rather than distinguished only by the
  reader's knowledge of the code.

Option (b) — persisting accepted verdicts as audit attestations — is NOT taken. It would supersede
a deliberate retirement in order to make a mistaken table cell true, which inverts the direction of
authority between spec and code. If durable attestation of intent judgments is ever wanted, it
should be argued on its own evidence, not inherited from this collision.

No runtime change. No registry change.

## ⚠ AWAITING OWNER GO — the spec edit is NOT applied

`spec/audit/artifact-contract.md` is a constitutional doc. The pre-commit gate refused this edit,
and the refusal is correct: the owner asked for a traced recommendation, and has not decided it.
Attesting an owner decision here would manufacture one — which is the exact thing that record
exists to prevent. Escalated rather than applied.

Note the gate's own warning deserves an answer, because it names this shape: *"editing one to match
current code destroys the thing the code is measured against."* The claim here is that this is a
**spec-vs-spec** conflict, not spec-vs-code: DD-9 is the design authority and explicitly retired the
cache; `artifact-contract.md`'s label contradicts DD-9. The code is corroboration that the
retirement was honored, not the authority being deferred to. That reasoning is also easy to
construct after the fact, which is why it is the owner's call and not mine.

**The exact two-row replacement, ready to apply on your go** (`spec/audit/artifact-contract.md`,
Analysis table, lines 54-55):

```
| `critical-flow-fallback.json` | JSON | Durable host input: the LLM fallback flow enrichment authored when `critical_flows.fallback_required` is set. Merged into `critical_flows.json` by the structure phase. REGISTERED in `ARTIFACT_DEFINITIONS` and a declared leaf of the staleness DAG — the file itself is the durable input. |
| `intent-equivalence-verdict.json` | JSON | **Transient host submission** — NOT registered, NOT a staleness-DAG participant: the DD-9 gate's verdict on whether a re-stated intent still means what the confirmed checkpoint meant. Authored only for a prose-only delta — every other arm resolves deterministically without host input. Staged under `incoming/`, validated, consumed and DELETED; the accepted judgment is materialized into `artifact_metadata.intent_baseline`, which is the revision authority. Per DD-9 no verdict-pair cache is persisted, so the executor writes no artifact — do not "fix" its absence from the registry by adding a row. |
```

Apply with:

```
node scripts/attest-constitutional-doc-change.mjs --reviewed-by <id> --attester-class human \
  --owner-decision "<your call, and that it was escalated in this record>"
```
