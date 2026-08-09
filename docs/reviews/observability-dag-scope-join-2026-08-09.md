# Observability run — why re-running the DAG is not yet the right next move (2026-08-09)

Read-only recon against HEAD (`dd67285c`) plus the persisted artifacts of the
`dispatch-effectiveness-observability` run. Written because HANDOFF's immediate-next item 1
("Re-run the observability DAG") rests on two premises that do not survive contact with the code.

Every claim below was verified by hand against source or the run's own artifacts. A parallel
agent recon was run alongside; where it disagreed it was wrong, and those corrections are called
out explicitly rather than quietly dropped.

## 1. The run is COMPLETE, so nothing re-validates on `next-step`

`state.json` carries `status: "complete"` — not paused, not blocked. Per-node:

| node | status | recorded reason |
|---|---|---|
| CP-NODE-1 | `resolved` | — |
| CP-NODE-2 | `blocked` | "Empty dispatch scope … nothing a worker could be scoped to (structural, never retried)" |
| CP-NODE-3 | `blocked` | same |
| CP-NODE-4 | `blocked` | "A dependency node did not reach a verified-complete disposition … (INV-RS-01)" |

The scope-less refusal added in `40f632b4` lives in `validateImplementationDagTraceability`, called
from `src/remediate/steps/contractPipeline.ts:2364` — inside the contract-pipeline step flow. A
completed run never reaches it: `PRE_INTAKE_PRIORITY` in `src/remediate/steps/nextStep.ts:5130`
orders `complete` ahead of `pending_intake`, and the `complete` obligation
(`nextStep.ts:5302`, `derive: state => state?.status === "complete" ? "missing" : "satisfied"`)
fires first and emits `handleComplete`.

**Correction to the agent recon.** It concluded "Resume will refuse and regenerate." That is right
about the mechanism and wrong about its reach — the validator is unconditional *within* the contract
pipeline, but a `complete` run is short-circuited before it. Re-running therefore means starting a
run that is not already complete, not resuming this one.

## 2. The refusal only catches the LOUD failure. Two quiet ones are uncaught — and both fired

`buildNodeWriteScopeResolver` (`contractPipeline.ts:1434`): a node with no declared
`output_files`/`files_likely_touched` inherits `file_scope` from whichever decomposed module its
obligation ids prefix-match as `OBL-<moduleSlug>-`. The validator
(`contractPipeline.ts:1093`) refuses **only** `resolveWriteScope(node).length === 0`.

The 7 decomposed module names, against the 4 nodes' obligation slugs:

| node | obligation slug | joins | resolved write scope |
|---|---|---|---|
| CP-NODE-1 | `attribution-contract` | ✅ | `runLedger.ts`, `remediationOutcome.ts` |
| CP-NODE-2 | `attribution-capture` | ❌ none | *empty* → refused |
| CP-NODE-3 | `verdict-capture` | ❌ none | *empty* → refused |
| CP-NODE-4 | `attribution-artifact` | ⚠ partial | `src/audit/io/artifacts.ts` only |

**Quiet failure A — partial join (CP-NODE-4).** Its title is "attribution-artifact — sole writer,
ordering, aggregates, **renders**, registration", and its description explicitly requires "add
by_provider / by_model / by_lens to RemediationOutcomesReport, rendering both sections" — that is
the `effectiveness-render` module, whose `file_scope` is
`src/audit/reporting/synthesis.ts` + `src/remediate/phases/close.ts`. Neither is in CP-NODE-4's
resolved scope. The result is non-empty, so the validator passes it.

The agent recon "refuted" this by answering a different claim — that CP-NODE-4 carries mixed
obligations. It does not, and that was never the claim: the narrowing exists *precisely because* it
joins one module while its description spans two.

**Quiet failure B — the successful join was itself wrong (CP-NODE-1).** Derived scope was
`runLedger.ts` + `remediationOutcome.ts`. What the worker actually wrote (`d5ef739b`, landed on main
as `14677902`): `src/shared/types/attributionContract.ts`, `src/shared/index.ts`,
`tests/shared/dispatch-effectiveness-contract.test.ts`. **Zero overlap.** The run's own result record
says it outright: *"src/shared/types/runLedger.ts and src/shared/types/remediationOutcome.ts have
zero diff."* The node passed with `passed: true`.

So of four nodes, the join produced: two empty, one narrowed, one wholly wrong. It was never right.

## 3. THE ACTUAL ROOT CAUSE — an LLM repair rewrote 7 modules into 4 and nothing checked

Sections 1–2 describe the symptom. The cause is three artifacts upstream, and it is not a DAG-authoring
fault at all. There are **three** module name spaces, not two:

| artifact | module count | names |
|---|---|---|
| `module_decomposition.json` | **7** | attribution-contract, dispatch-attribution-capture, ingest-attribution-stamp, verdict-capture-audit, verdict-capture-remediate, attribution-artifact, effectiveness-render |
| `module_contracts.json` (drafted, sharded) | **7** | identical to the above |
| `finalized_module_contracts.json` | **4** | attribution-contract, **attribution-capture**, **verdict-capture**, attribution-artifact |

`attribution-capture` and `verdict-capture` exist in **no other artifact** — they are invented merged
names. `effectiveness-render` was **dropped entirely**, which is why its two files
(`synthesis.ts`, `close.ts`) are claimed by no node.

Everything downstream follows mechanically. `phase_cut.json` derives from the *finalized* contracts, so
it too carries the 4 collapsed names. The DAG author wrote obligations against those names —
`OBL-attribution-capture-*`, `OBL-verdict-capture-*` — and was internally consistent in doing so. The
write-scope resolver then joins those obligations against `module_decomposition`'s 7 granular names and
finds nothing. **The DAG was faithful to its input; its input had already lost three modules.**

**Why nothing caught it.** Finalization is deliberately deterministic —
`contractPipeline.ts:2210` states it is "a mechanical merge, not fresh authoring: carry each drafted
module contract verbatim," and `deriveFinalizedModuleContracts` does exactly that, preserving all 7.
But the same comment names an escape hatch: a downstream gate that finds the merge inadequate
"re-emits contract_finalization as an **LLM step** via buildPhaseStep — the only path that still needs
judgment." `repair-state.json` records **four** rewrites against this artifact (2 judge `repairs` for
CE-001…CE-012 and CE-101…CE-104, 2 `critique_repairs`). The LLM rewrote the artifact wholesale and
collapsed the module set, and **no post-condition checks that a rewrite preserves it**.

The completeness machinery that would have caught this exists but does not reach here: `scanModuleShards`
enforces one shard per decomposed module, and `contractPipeline.ts:539` exempts finalization on the
grounds that it "is deterministically derived, never sharded" — true of the derivation, false of the
repair path that overwrites it.

No archived predecessor survives (`history/` holds stale copies of every other artifact but none of
`finalized_module_contracts`), so the collapse is unrecoverable from artifacts — only detectable by
comparing against `module_contracts`.

**The fix this points to** is a single set comparison at the earliest artifact: after any LLM rewrite of
`finalized_module_contracts`, its module-name set must equal the drafted `module_contracts` set. Ground
truth is unambiguous, no host discretion is involved, and it fires before `phase_cut`, before the DAG,
and before dispatch — instead of at the dispatch wall three steps later. This is squarely "verify, don't
re-author"; sections 4–6 below were written against the symptom and are superseded as a *fix target*,
though their evidence stands.

## 4. Contributing cause: nothing ever asks for a node's write scope

`output_files` and `files_likely_touched` are both optional on the node type
(`src/shared/types/contractPipeline/implementation.ts:44,52`), and
`src/remediate/steps/contractPipelinePrompts.ts` **never mentions either field** — grep returns
nothing. The DAG author is not asked for write scope, so every node falls through to the join, and
the join is a prefix match between two independently authored name spaces
([[prefix-join-between-two-name-spaces-fails-empty]]).

This is the [[write-only-data-looks-authoritative]] shape: a derived value that is always present,
never verified against the work, and read downstream as if authoritative.

## 5. Consequence for the re-run

Regeneration works as designed — a violation archives the DAG (`archiveContractArtifact(…,
"invalid")`) and re-emits `implementation_planning` with the violation text naming the failed slugs
and the available modules; `dag_regenerations` is `[]` against `MAX_DAG_REGENERATION_ATTEMPTS = 2`,
so the budget is intact.

But the regenerated DAG is authored under the *same* prompt that never asks for `output_files`. The
most likely outcome is a DAG that satisfies the refusal (non-empty join) while reproducing quiet
failure A or B — which is what CP-NODE-1 and CP-NODE-4 already demonstrate. Re-running first buys a
DAG that passes the gate, not one that is correctly scoped.

## 6. Other verified mechanics

- **Resume gate.** A non-complete run re-invoked bare emits `confirm_resume_or_restart` and requires
  `confirm_resume_ack.json` carrying `{"choice":"resume"}` (`nextStep.ts:5192`).
- **Hand-editing the DAG is detectable.** `detectStaleArtifacts`
  (`src/remediate/contractPipeline/artifactStore.ts:327`) recomputes `envelopeSemanticHash` from the
  *current* payload and compares it against each downstream's recorded `dependency_hashes`, so an
  edited `implementation_dag.json` surfaces as staleness in its dependents rather than being
  silently accepted.
- **Ingest reads only `.input.json`.** With no fresh input file the persisted envelope is left
  alone (`contractPipeline.ts:506`), which is why the defective DAG survived the run.

## 7. RETIREMENT COLLISION — the obvious fix is the thing that was deliberately removed

`/design-check` step 2 found the plan ("require the DAG author to declare `output_files`") collides
with `c60eb73f`, the 2026-07-12 fix that introduced the derivation in the first place. Its own words:

> derive the write scope DETERMINISTICALLY at finalization **instead of trusting the host to have
> filled it**

Same failure, opposite direction. `c60eb73f` was fixing a run where all 16 promoted nodes had empty
`affected_files` *because the host left the field empty* — a coarse "Remediate `<module>`"
decomposition. It did not delete the field (`declared files still win`, resolver line 1443); it
removed the *reliance* on the host having filled it.

CLAUDE.md's robustness rule cuts the same way: correctness "never by the host *remembering*,
*noticing*, or *reasoning*." The DAG author is an LLM, so requiring it to declare scope is precisely
that pattern.

**So both candidate fixes are against a standing principle:**

| | tool-enforced? | correct? |
|---|---|---|
| Derived scope (today) | ✅ deterministic | ❌ demonstrated wrong 4 of 4 nodes |
| Host-declared scope | ❌ host discretion — retired by `c60eb73f` | unknown, unverifiable |

The derivation is deterministic but not *right*: determinism was mistaken for correctness. A guess
computed the same way every time is still a guess, and nothing ever checks it against the work.

**The direction this points to is a third option neither commit took:** make the scope *verifiable*
rather than merely present — whoever authors it, the tool refuses a scope that does not cover the
modules the node's obligations span, and refuses a node whose description spans a module its scope
omits. That subsumes `40f632b4`'s empty check as the degenerate case, keeps enforcement in the tool,
and does not require trusting either side. It is a different design from the one this gate was asked
to check, so it is the owner's call, not an implementation detail.

## 8. What this does not settle

`forward-tracks.md:289` records "whether the obligation id should be DERIVED from the decomposition"
as an **open question, not planned work**, and `40f632b4` deliberately rejected a tolerant join. This
record does not reopen either. It reports a narrower, separable fact: **the DAG author is never asked
for the scope, so the join is load-bearing in every case** — and that is fixable without touching the
name-space question.
