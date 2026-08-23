# P41 — Derive every worker-facing prompt's output contract from the schema that consumes it

**Leg 3, nightly 2026-08-23. Proposal only — nothing landed.**

Generalize P40 past its two named builders. A generated worker prompt that states an
output contract must not hand-type that contract beside the validator that enforces it.

## Recurrence evidence — 12 records across 7 distinct dates

`docs/backlog/open-bugs.md`

- A delegated step prompt can turn its executor into a second driver (2026-07-16)
- Contract-pipeline fan-out names a mechanism the host may not have (2026-08-08)
- Diff-based re-review loses the verdict it must diff against (2026-08-08)
- Implementation workers are never given the contract they must satisfy (2026-08-09, high)
- remediate-code step prompts drift from the validators that read their output (2026-08-19)
- The systemic-challenge lane prompt withholds the banked findings it asks the adversary
  to beat (2026-08-21)
- The critique-driven contract repair step renders the judge-repair template (2026-08-22)

`docs/backlog/durable-traps.md`

- The contract-pipeline repair prompt orders the OPPOSITE of the repair invariant (2026-08-09)
- A critique can prescribe a remedy the pipeline structurally cannot perform (2026-08-09)

Friction records

- `audit-friction-20260812T…` — a prompt orders a write a read-only lane cannot perform
- `audit-friction-20260821T…` — `evidence` omitted, and a charter enum shown OPEN while the
  validator's enum is CLOSED
- `remediation-friction-CONTRACT-mt0qo4m9-bknh8b.json` (2026-08-19) — every contract-pipeline
  step prompt self-contradicts on advancement

## Verified open at HEAD `fa66bd8c`

`tests/shared/prompt-renders-its-contract.test.ts:4` imports exactly one builder,
`renderCharterKindLanePrompt`. `scripts/guard-reach-data.mjs:524` states the gap as declared
data, verbatim:

> P40: prompt-renders-its-contract-test reaches only its two named builders — a third prompt
> site (including the 15 contract-pipeline sketches and synthesize_intake, whose
> checkpoint-field drift was never verified) goes uncaught

The live `evidence` divergence is still three-way:

- `src/shared/types/finding.ts:206` — `evidence: z.array(z.string()).optional()`
- `src/audit/contracts/workerSchemas.ts:35` — `evidence: z.array(z.string()).min(1)`
- `src/audit/validation/auditResults.ts:339` — an imperative `validateEvidence`

## Mechanism — a registry-driven contract test, not a third named instance

Replace the hand-written import list with a declared registry: every prompt-emitting builder
paired with the zod schema its output is parsed by. Per row, assert that the rendered
contract block is GENERATED from that schema — required set, `minItems`/`minLength`, closed
enums — rather than typed beside it.

Reconcile the registry the way `scripts/guard-reach-data.mjs` is reconciled: a prompt builder
under `src/` that no row claims is a red build. That reconciliation is what makes this a
class fix instead of a third instance.

Rows carry one of three dispositions:

1. `derived` — the prompt renders the contract from the schema. Asserted.
2. `projection` — the prompt legitimately states a SUBSET (a step asking for one field). The
   row declares which fields, and the test asserts the subset relation, not equality.
3. `declared-gap` — a prose-shaped contract with no schema behind it. The row states why, the
   same escape `guard-reach` already uses, so the gap is data rather than silence.

## What it would have caught

- The `evidence` optional-vs-`min(1)` divergence, still live at three sites.
- The open-vs-closed charter provenance enum.
- The 15 contract-pipeline sketches and `synthesize_intake` that `guard-reach-data.mjs`
  already names as escaping.

## False-positive surface — real, and the reason for disposition 2

A builder whose prompt states a deliberate subset reds unless its row can declare the
projection. Prose-shaped contracts that are not schema-backed have no schema to point at and
need the `declared-gap` escape. Without both escapes this gate would misfire on legitimate
prompts, which is the failure mode that makes a guard get disabled.

## Already-shipped check

`c3eaa59d` (P40) and `20bba526` closed two named instances on 2026-08-22. The class is not
shipped — `guard-reach-data.mjs` declares it open in its own `uncovered:` field.

## The owner's decision

Approve the registry + reconciliation, approve a narrower version that registers rows without
the "unclaimed builder is a red build" reconciliation, or decline and keep the two named pins.
