# solN-3 — Derive a DAG node's write scope from the module contract's declared write targets

## The recurring problem

An implementation-DAG node's write scope never inherits the declared write targets
that the contract layer routes an out-of-`file_scope` file through (clause 1(c):
a module contract's `outputs` / `side_effects`). The declared file therefore falls
out of the work item's `allowed_files`, and the implementer cannot land the edit its
own obligation demands.

It fails closed, which is the good half: the implementer stops and reports rather
than editing out of scope. But the recovery is manual every time.

## Recurrence — counted, not asserted

The same manual fix was applied **four times** in the 2026-08-19/20 remediation wave,
to nodes CP-NODE-2, CP-NODE-24, CP-NODE-25 and CP-NODE-21. **Three separate implementers**
stopped on it independently:

- the enum widening's `src/remediate/state/disposition.ts`
- `tests/remediate/item-status.test.ts` pinning a now-widened exhaustive `Record`
- `tests/audit/dispatch-validate.test.ts`, which the contract declared but nothing routed

It also carries two written records, on two distinct dates:

- project memory `dag-node-output-files-drop-declared-write-targets` (2026-08-20), which
  already names the durable fix as unbuilt
- `docs/HANDOFF.md` → *Known routing-gap class*, which instructs the operator to
  "Expect the same fix shape if a later item stops on a declared-but-unwritable file"

That HANDOFF sentence is the tell. It makes correctness rest on the host *remembering*
and *noticing* — exactly what `CLAUDE.md` → *Auditor-agnostic robustness* forbids.

## Mechanism at HEAD

`buildNodeWriteScopeResolver` (`src/remediate/steps/contractPipeline.ts:1372`) resolves a
node's write scope from the **wrong artifact**, and then early-returns:

1. `readDecomposedModules` (`src/remediate/steps/contractPipeline.ts:1317`) reads the
   `module_decomposition` artifact and keeps only `name`, `responsibilities` and
   `file_scope`. The declared write targets are not in that artifact at all.
2. The declared write targets live in `finalized_module_contracts`, whose per-module
   record carries `outputs` and `side_effects`
   (`src/remediate/contractPipeline/derive.ts:229-232`). Nothing in the write-scope
   resolver opens that artifact.
3. `resolve` returns node-declared files immediately when non-empty
   (`src/remediate/steps/contractPipeline.ts:1381-1382`), so the module fallback never
   runs for a node that declared *anything* — the common case. Even if the contract's
   targets were parsed, this early return would discard them.

The module `file_scope` fallback at `:1387` only fires when the node declared nothing,
which is why the gap is invisible in the empty-scope gate at `:1032`.

## Proposed fix — make the trap unrepresentable, not guarded

`buildNodeWriteScopeResolver` reads `finalized_module_contracts` alongside
`module_decomposition`, and `resolve` **unions** the owning module contract's declared
write targets into the result instead of early-returning on the node's own declaration.

This is a fix, not a guard: after it, a declared-but-unrouted file cannot exist, so there
is no stop to recover from and no fix shape for the operator to remember. The HANDOFF
paragraph and the memory entry's "Durable fix (unbuilt)" both retire with it.

Ownership: a node's owning module is already resolved by the existing
`OBL-<module-slug>-` prefix match at `:1388-1389`. The union reuses that resolution;
no new identity scheme is introduced.

## False-positive surface

Widening a write scope is the permissive direction, so the risk is over-broad
`allowed_files`, not a blocked implementer.

- A module contract that declares a broad `outputs` entry widens every node owned by
  that module. Bounded by the fact that the same contract already authorizes those
  writes — the ingestion-time diff check reads the same declaration.
- A free-prose `side_effects` entry ("writes the run ledger") is not a path and must not
  be treated as one. The union must accept only entries that parse as repo-relative
  paths and drop the rest, or the scope fills with prose.
- A node whose obligation ids do not carry an `OBL-<module-slug>-` prefix resolves to no
  owning module and is unaffected — the same nodes the empty-scope gate already names.

## What it would have caught

All four wave stops, before dispatch, with no operator involvement.

## Tests to land with it

Under `tests/remediate/` (never beside a hook — vitest excludes `.claude/**`):

1. **Red-green:** a node declaring `output_files: ["src/a.ts"]` whose owning module
   contract declares `outputs: ["src/b.ts"]` resolves to **both**. Red at HEAD (returns
   only `src/a.ts` via the `:1382` early return).
2. A `side_effects` entry that is prose, not a path, is dropped rather than added.
3. A node with no owning-module prefix match is unchanged — no regression to the
   existing `file_scope` fallback or the empty-scope gate at `:1032`.

## Status

Proposal only. Leg 3 lands nothing.
