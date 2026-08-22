# P40 — a prompt that names a contract renders it FROM the contract

**Leg 3 proposal, 2026-08-22. Propose-only; nothing landed.**

## The recurring problem

A generated worker prompt states the output contract as a **hand-written string literal**,
sitting beside a **separately hand-written validator** that judges the returned output. The two
drift. A worker that obeys the tool's own prompt then produces a submission the tool rejects —
the tool blames the worker for following its instructions.

This is a direct *auditor-agnostic robustness* violation (`CLAUDE.md`): correctness rests on
whoever edits the validator remembering to edit the prompt.

## Recurrence evidence — counted, not asserted

Three backlog entries, two distinct dates, **both** orchestrators:

| Date | Entry | Instance | State at HEAD |
|---|---|---|---|
| 2026-08-19 | `open-bugs.md` "remediate-code step prompts drift from the validators that read their output" | `confirm_intent` renders `excluded_scope` as a bare `[]`; the reader needs `{path, reason}` | **LIVE** |
| 2026-08-19 | same entry | `synthesize_intake` mandates checkpoint fields the `.strict()` schema rejects | unverified this run |
| 2026-08-19 | same entry | `goal_normalization` omits `created_at` which `validateGoalSpec` requires | **REFUTED — see below** |
| 2026-08-21 | `open-bugs.md` "The generated worker prompt omits `evidence`…" | audit finding contract absent from the dispatch prompt | **FIXED** — `findingContractPromptLines()` |
| 2026-08-21 | `open-bugs.md` "The charter-extraction lane prompt shows an OPEN provenance-kind list…" | closed enum rendered `"doc\|code\|comment\|inferred\|..."` | **LIVE** |

Measured cost of the two that bit: one submission quarantined **after a 34-minute lane run**; one
run wedged with no supported recovery path.

### The already-shipped half is the proof the mechanism works

The audit finding contract was fixed on exactly this principle. `buildPrompt` in
`src/audit/cli/dispatch/hostHandoff.ts` now calls `findingContractPromptLines()`, whose comment
states the rule outright: *"The finding contract is CARRIED, not referenced: it is rendered from
the very schema ingestion enforces, so a host never has to remember or fetch it."*

P40 is that one fix generalized to the two siblings that did not get it, plus the contract test
that forbids the shape returning.

### One claimed instance is REFUTED — do not act on it

The 2026-08-19 entry's `created_at` claim is **wrong at HEAD**, and wrong in a way worth
recording. A mechanical sweep of all 15 contract-pipeline prompt sketches against their 15
validators reports 15/15 "diverging" on `created_at` — a perfect-looking signal. It is a false
positive: `src/remediate/steps/contractPipeline.ts:540` stamps `created_at` tool-side before
validation, with the comment *"The host has no clock"*. The prompt omits it **correctly**; the
worker must not supply it.

Consequence: any generic "every validator field appears in the prompt" test would be red on 15
sites that are all correct. **The mechanism must target the shape, not the field set.** That is
why P40 proposes two narrow shape rules rather than a field-set reconciliation.

## The mechanism

Two live sites get the derived treatment, and one contract test forbids both shapes:

1. **`src/audit/cli/charterExtractionPrompt.ts:166`** — render the provenance kinds from
   `CharterProvenanceSchema.shape.kind` instead of the hand-typed `"doc|code|comment|inferred|..."`.
   A closed enum is rendered exhaustively, with no trailing ellipsis.
2. **`src/remediate/steps/nextStep.ts:3584`** — the pre-drafted branch of the confirm-intent
   checkpoint template renders `"excluded_scope": []`. The FALLBACK branch of the same function
   (line 3622) already renders the correct `[{"path": …, "reason": …}]`. One function, two
   branches, one of them wrong — the common path is the wrong one. Single-source the element
   shape so both branches render it.
3. **Contract test** `tests/shared/prompt-renders-its-contract.test.ts` (written, see
   `prompt-renders-its-contract.test.ts` beside this file) pins both properties:
   - no rendered prompt presents a **closed** schema enum as an open alternation ending in `...`;
   - the confirm-intent checkpoint template states the element shape of `excluded_scope`.

## What it would have caught

Both live instances, at the commit that introduced them. The charter one cost a 34-minute lane
run and a full-submission quarantine.

## False-positive surface — stated, not hidden

- The enum rule is **literal**: it matches an alternation of quoted-enum members followed by
  `|...`. A prompt that legitimately offers an open vocabulary (e.g. `edgeReasoning.ts`'s
  rewrite `kind`, which is a free-form *matching key* with no validator enum — checked this run,
  correctly excluded) is not matched, because there is no closed schema to compare against.
- The rule reaches only the two named prompt builders. It is **not** a general sweep of every
  prompt literal in the tree; a third site introduced tomorrow goes uncaught. That uncovered half
  must be declared in `scripts/guard-reach-data.mjs` if this lands, per the guard-reach registry
  rule — the registry, not this proposal, is the authoritative statement of reach.
- `synthesize_intake` (the 2026-08-19 entry's second instance) was **not** verified this run and
  is not covered by the proposed test. Stated so the covered half does not read as a close.

## Owner decision

Approve, and the patch + tests land under the normal gate. Decline, and the two live sites stay
as they are — with the refuted `created_at` claim trimmed out of the 2026-08-19 backlog entry
either way, since acting on it would corrupt working code.

## Red-green validation (performed this run, then INVERTED — nothing landed)

The test beside this file was run against HEAD and against the patched tree. Both edits were
reverted by inverting them, never by `git checkout`; `git status` afterwards shows only this
proposal directory and the pre-existing untracked `high.json`.

| Stage | Result |
|---|---|
| HEAD, unpatched | **2 failed** — `a closed enum must not be rendered as an open alternation ending in '...'`; `every rendering of excluded_scope must state its element shape … expected '[],' to match /path/` |
| Both fixes applied | **2 passed** |

Both failures are for the intended reason. An earlier draft of the charter pin failed with
`TypeError: Cannot read properties of undefined` — a false red from a wrong call signature — and
was rewritten as a source-level pin before being accepted as the proof.

### The two edits, verbatim

`src/audit/cli/charterExtractionPrompt.ts:166`
```
- "kind": "doc|code|comment|inferred|..."
+ "kind": "doc|intent_checkpoint|user_feedback|code|comment|inferred"
```

`src/remediate/steps/nextStep.ts:3584`
```
-   "excluded_scope": [],
+   "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],
```

Shown as literals for review. If approved, the charter line should be **rendered from
`CharterProvenanceSchema.shape.kind.options`** rather than retyped — a hand-typed exhaustive list
is the same defect one edit later, and the test above passes either way. That is a gap in the
test's reach, and it is stated here rather than left for the patch to imply.
