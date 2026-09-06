# Design gate — the loop's silent-drop defect class (2026-09-06)

> **Status: recon map, pre-implementation.** Every citation below was verified against source at
> `0be78e43` by reading the file, not by lane report. This document is the read-only, provenanced
> input handed to the refutation lane. The lane never writes back to it. A lane that disagrees must
> name the file and line that contradicts a claim here.

## The class

One defect, five instances: **the orchestrator computes information the host needs, then emits a
step that does not carry it.** Each instance already has the fact in hand — a reason string, a
disposition record, a trigger identity, an issue list, a required field — and each loses it at the
host boundary. This is the repo's *auditor-agnostic robustness* rule broken five times: the host is
left to reason its way to something the tool already knew.

## Instance 1 — a destroyed extracted plan emits the no-input step

**Open. Confirmed at HEAD.**

- `handlePendingExtractedPlan` — [`src/remediate/steps/nextStep.ts:1331`](../../src/remediate/steps/nextStep.ts#L1331).
- Its `catch` begins at line 1420. It computes `const reason = error instanceof Error ? error.message : String(error)`
  and an `archivePath`, writes both to the run log (`extracted_plan_removed reason=…`) and to
  stderr, then `return null` at line 1464.
- The caller returns null at [`nextStep.ts:895`](../../src/remediate/steps/nextStep.ts#L895).
- The decide loop reaches `handleNoState` — [`nextStep.ts:2178`](../../src/remediate/steps/nextStep.ts#L2178)
  — which emits `stepKind: "collect_starting_point"`.

So the reason is known and durable. Only the **emitted step** omits it.

⚠ The stderr line asserts `Re-emitting extraction step.` That is **false**: the no-input step is
emitted, not an extraction step. The message misdescribes its own control flow.

⚠ `collectStartingPointPrompt` — [`src/remediate/steps/prompts.ts:338`](../../src/remediate/steps/prompts.ts#L338)
— has **no** spare reason slot. Its third parameter is `missingPaths`, which renders as
"The supplied input path did not exist". Do not overload it; a discarded plan is not a missing path.

## Instance 2 — a no-evidence finding is dropped where no gate can see it

**Open, both halves. Confirmed at HEAD.**

Half A, the remediate drop:
- `runFindingFilterPass` step 1 — [`src/remediate/findingFilter.ts:73`](../../src/remediate/findingFilter.ts#L73)
  — filters findings whose `evidence` is absent or empty and keeps **only their ids** in
  `droppedNoEvidence`.
- The dispositions persist through [`nextStep.ts:1903-1926`](../../src/remediate/steps/nextStep.ts#L1903).
- The review gate `runPlanningReviewGate` reads `state.plan?.findings`
  ([`nextStep.ts:2606`](../../src/remediate/steps/nextStep.ts#L2606)) — the **survivors**. A dropped
  finding is by construction absent from that set, so the gate cannot show it and the operator can
  neither confirm nor decline the drop.

Half B, the audit mint:
- `evidence` is **optional** in the shared contract:
  [`src/shared/types/finding.ts:241`](../../src/shared/types/finding.ts#L241) declares
  `evidence: z.array(z.string()).optional()`.
- Systemic-challenge findings join the merge at
  [`src/audit/reporting/mergeFindings.ts:77`](../../src/audit/reporting/mergeFindings.ts#L77)
  (`...(systemicChallenge?.findings ?? [])`).

- The systemic register declares its findings as the shared type:
  [`src/audit/types/systemicChallenge.ts:93`](../../src/audit/types/systemicChallenge.ts#L93)
  reads `findings: Finding[]`. Since `Finding.evidence` is optional, an evidence-free systemic
  finding is **contract-valid by construction**.

So the audit draw may validly mint an evidence-free finding, and the remediate draw treats that
same absence as grounds for a silent discard. The two draws disagree about one shared contract
field.

⚠ **This is a contract question before it is a code question, and it is the one instance whose
endpoint is genuinely undecided.** Three endings are available and they are not equivalent:
make `evidence` required (breaks every existing evidence-free artifact); keep it optional and give
the remediate intake an explicit admitted grounding class; or keep the drop and merely surface it
for confirmation. The recon does not settle which. This is flagged for the refutation lane and, if
it survives, for the owner.

## Instance 3 — the contract repair step always renders the judge template

**Open. Confirmed at HEAD.**

⚠ The site is in `src/remediate/`, **not** `src/audit/` as the backlog entry's wording suggests.

- `renderContractRepairPrompt` — [`src/remediate/steps/contractPipelinePrompts.ts:566`](../../src/remediate/steps/contractPipelinePrompts.ts#L566).
- It hard-codes one `requiredInputs` array of six names (`goal_spec`, `finalized_module_contracts`,
  `obligation_ledger`, `contract_assessment_report`, `counterexample`, `judge_report`) and
  **throws** when any of the six paths is absent.
- It hard-codes the sentence `The adversarial judge rejected the current contract.` and renders the
  same six names under `## Required Inputs`.
- Two callers, which are the two triggers to separate:
  [`contractPipeline.ts:2620`](../../src/remediate/steps/contractPipeline.ts#L2620) and
  [`contractPipeline.ts:2802`](../../src/remediate/steps/contractPipeline.ts#L2802).

There is no trigger parameter and no second template. Selection is unconditional.

**The two triggers, named.**

- Caller 1 is `conceptualCritiqueGate` — the **critique-driven** trigger. Its `instruction`
  correctly names the critique and its blocking ids. The template then overrides that framing with
  the judge sentence.
- Caller 2 is `judgeRepairGate` — the **judge-driven** trigger, for which the template is correct.

**The throw is dead code on the production path, and that makes the defect worse, not better.**
Both callers pass the same `ctx.artifactPaths`, and that map is populated **unconditionally for
every artifact name** — [`contractPipeline.ts:3744-3747`](../../src/remediate/steps/contractPipeline.ts#L3744)
loops `for (const name of CP_ARTIFACT_NAMES)` and assigns a path to each, with **no existence
check**. So:

1. The six-name guard can never fire in production, because every path string is always present.
2. The critique trigger therefore renders the judge sentence **and** a `## Required Inputs` list of
   six paths, four of which (`obligation_ledger`, `contract_assessment_report`, `counterexample`,
   `judge_report`) point at files that do not exist on disk for that trigger.

A worker sent to read four non-existent files has no way to tell a missing input from a wrong one.
That is precisely the live symptom the backlog entry records.

## Instance 4 — BOTH draws lose issues at a transition that ends the call

⚠ **Read the *Refutation outcome* section below before this one.** An earlier revision of this
section claimed the remediate half was fixed. That claim was **wrong**, and the correction is
recorded there: the diagnostics block is reached only when nothing was accepted, so a partial batch
loses every rejection. What follows describes the machinery that does exist; it is not a claim that
the machinery is reached on every path.

- `buildImplementDispatchStep` — [`src/remediate/steps/nextStep.ts:1085`](../../src/remediate/steps/nextStep.ts#L1085).
- It logs **every** ingest issue to the run log (a `runLogger.event` per issue, around line 1147)
  **and** renders them into the emitted prompt as `## Result status requiring attention`
  (around line 1170). Its own comment states the design.

What remains is the **audit draw**, which the entry records as observed live on 2026-08-29:
a result rejected on the exact-key envelope check produced no diagnostic on any surface, the next
fold re-minted the run id, and the step then reported the item as `submission_missing`.

- The audit ingest does return issues:
  [`src/audit/cli/dispatch/hostHandoff.ts:1301`](../../src/audit/cli/dispatch/hostHandoff.ts#L1301).
- They are carried at [`nextStepHelpers.ts:2855-2961`](../../src/audit/cli/nextStepHelpers.ts#L2855).

The residual is therefore a **cross-call carry**, and it is the same defect as the entry recorded in
[`minor-bugs.md`](../backlog/minor-bugs.md) ("A transition that ends the call drops the fold's
carried advisories"): an issue raised in one fold does not survive into the call that emits.
Rejected-with-reason then presents as missing-without-reason.

**This instance is the clearest case of draw drift in the set: one draw was fixed and its twin was
not.** The project's own rule says a fix in one usually belongs in both.

### ⚠ The plan's step 4 is REFUTED by the source itself

The audit draw already has a cross-fold carry, `FoldAdvisories`
([`nextStepHelpers.ts:2360`](../../src/audit/cli/nextStepHelpers.ts#L2360)), consumed once per
emission by `takeFoldAdvisories` ([`nextStepHelpers.ts:2946`](../../src/audit/cli/nextStepHelpers.ts#L2946)).
Its own header states the boundary as a **decision**, not an oversight:

> The carry is fold-local (a `{ value }` ref on `AuditNextStepCtx`), **never persisted** — the
> ledger (`recordHostResultOutcomes`) remains the only durable record, and this only defers the
> PROMPT statement of what it already recorded to the next emission within the same call.

So "persist the fold's carried advisories" — my step 4 as originally written — **adds a second
durable store for a fact the submission ledger already holds.** That breaks *one home per fact*, and
it reopens a boundary the code deliberately drew.

**Corrected direction for instance 4.** The durable record already exists. The defect is that the
emitting step does not READ it: an item is reported as `submission_missing` while the ledger holds a
rejection-with-reason for that same item under the previous run id. The fix is a reader, not a
writer — the step consults the ledger before it calls anything missing.

⚠ This connects to a separate open entry, "the remediate-side submission ledger has no reader"
([`open-bugs.md`](../backlog/open-bugs.md)). The two are the same shape on the two draws: a durable
ledger written by one side and read by nobody. That strengthens the single-source case — one reader
in `src/shared`, drawn by both.

## Instance 5 — the loader prompt asks for a reflection the parser is guaranteed to discard

**Open. Confirmed at HEAD, and exact.**

- The prompt — [`skills/audit-code/audit-code.prompt.md:48-53`](../../skills/audit-code/audit-code.prompt.md#L48)
  — tells the host: "record one reserved AgentReflection with task_id exactly
  `audit-capability-preflight`; use severity `high` or `critical` … with concrete `tool_friction`,
  `ambiguities`, and `suggestions` details."
- The parser `parseReflectionsNdjson` —
  [`src/shared/agentReflections.ts:76-88`](../../src/shared/agentReflections.ts#L76) — requires
  **three** fields: `task_id`, `instruction_clarity`, and `severity`. On a missing or out-of-enum
  `instruction_clarity` it executes `continue`, discarding the whole line.
- The prompt **never names `instruction_clarity`.**

So a host that follows the prompt exactly writes a line the parser is guaranteed to drop, and the
drop is silent by explicit design — the doc comment says such lines "are skipped silently".

⚠ **The test cannot catch this.** `tests/audit/agent-feedback-reflections.test.ts`, added by the
same commit `09b0f4e4` that added the prompt request, constructs the fixture directly as a typed
`AgentReflection` **with `instruction_clarity: "clear"`** — a field the prompt does not ask for. The
test therefore exercises the parser but never the prompt's own output shape.

⚠ **Not a retirement.** `git log -S'instruction_clarity' -- skills/` is empty: the field has never
appeared in a shipped prompt body. `09b0f4e4 feat(audit): surface structural limitations` added the
request and omitted the field. This is an oversight, not a decision.

**RED PROVED BY EXECUTION (2026-09-06).** A probe fed `parseReflectionsNdjson` exactly what the
prompt instructs the host to write:

```
{"task_id":"audit-capability-preflight","severity":"high","tool_friction":["no structural graph tool available"],"ambiguities":["unclear whether package boundaries are authoritative"],"suggestions":["expose a graph capability probe"]}
```

Result: `parsed count: 0`, `parsed: []`. The whole line is discarded, with no signal of any kind.
So the capability-preflight channel added by `09b0f4e4` — the one that decides whether a run may be
called comprehensive — cannot carry a single message from a host that obeys the prompt.

⚠ `parseReflectionsNdjson` has **four production callers** plus a public export, so changing its
return type is a real blast radius, not a local edit:
[`src/audit/cli/resynthesizeCommand.ts:62`](../../src/audit/cli/resynthesizeCommand.ts#L62),
[`src/audit/io/artifacts.ts:416`](../../src/audit/io/artifacts.ts#L416),
[`src/remediate/phases/close.ts:1986`](../../src/remediate/phases/close.ts#L1986),
[`src/shared/friction/triage.ts:398`](../../src/shared/friction/triage.ts#L398), and the export at
[`src/shared/index.ts:367`](../../src/shared/index.ts#L367). The repo bans a compatibility sibling,
and an additive export with no adopter reds `check:deadcode`, so the endpoint is one changed
signature and four updated callers.

⚠ `AgentReflectionSchema` is declared `.strict()`
([`agentReflections.ts:31-41`](../../src/shared/agentReflections.ts#L31)) but
`parseReflectionsNdjson` never calls it — the parser hand-checks fields and ignores unknown keys. The
strictness does not guard the path that reads the data.

## Precedent for a distinct step kind (instance 1)

`RemediationStepKind` — [`src/remediate/steps/types.ts:25`](../../src/remediate/steps/types.ts#L25)
— is a 19-member union. The most recently added member carries its own argument, in a comment on
the union itself, and it applies directly here:

- Adding a member is an **ADDITIVE persisted contract change**: "A host that switches on
  `step_kind` and does not know this one treats it as informational, which is the correct reading."
- Conflating distinct causes under one kind is named as the defect to avoid: "Conflating them is
  exactly the attribution defect the 2026-07-30 entry records — a whole-repo red that says nothing
  about which run, phase, or item caused it invites a response aimed at the wrong thing."

A destroyed plan and a never-supplied input are two different causes with two different repairs.
Reporting the first as the second is the same attribution defect. So the repo's own stated reasoning
argues for a distinct kind rather than a reason argument bolted onto `collect_starting_point`.

⚠ Counter-consideration to weigh: `MNT-e6c289ae`
([`src/remediate/steps/intakeResolver.ts:89`](../../src/remediate/steps/intakeResolver.ts#L89))
deliberately funnelled every `collect_starting_point` branch through ONE builder "so the step shape
stays consistent". A new kind must not fragment that consolidation — it is a sibling of it, not a
reopening.

## Retirement evidence gathered

- `git log -S'instruction_clarity' -- skills/` — empty. Nothing retired.
- `git log -S'audit-capability-preflight'` — six commits, none a removal; `09b0f4e4` is the origin.
- `git log --grep=retire --grep=revert --grep=delete -i -25` — no commit removes a discard-reason
  channel, a dropped-finding surface, a trigger-specific repair template, or a cross-call advisory
  carry.

No source says any of the five mechanisms was removed on purpose.

## Refutation outcome (agy-gemini lane, 290 s, 2026-09-06)

An independent lane was given this document as read-only provenanced input and asked to refute the
plan. **Three of its findings were verified against source here and are adopted. Two are rejected,
with reasons.** Everything below was re-checked in this session; none of it is adopted on the
lane's word.

### ADOPTED — the remediate half of instance 4 is NOT closed (this document was wrong)

An earlier revision of this record claimed the remediate half was fixed. **It is not.**
[`nextStep.ts:1107-1112`](../../src/remediate/steps/nextStep.ts#L1107) returns
`{ kind: "transition" }` **before** both the per-issue `runLogger.event` loop and the
`resultDiagnostics` render:

```ts
if (ingested.state_changed) {
  const { contract_version: _contractVersion, ...persistableState } = ingested.state;
  await store.saveState(persistableState);
  return { kind: "transition", state: persistableState };
}
```

So the diagnostics block is reached **only when nothing was accepted**. On a partial batch — some
results accepted, some rejected — `state_changed` is true, the call transitions, and the rejected
results' issues are **lost entirely**: not logged, not rendered, not carried. Remediate has no
advisory carry ref at all.

**Instance 4 restated, correctly.** Both draws lose classified issues at a transition that ends the
call. The audit draw carries them across folds *within* one call and loses them across calls; the
remediate draw loses them at the first transition. **One defect, two draws, and the draw with the
weaker mechanism is the one that looked fixed.** This is the strongest single-source case in the
set.

### ADOPTED — instance 2's stated Property reverses a LOCKED owner decision

⚠ **This is the gate earning its keep, and it stops instance 2 until the owner rules.**

The backlog entry's Property reads: "a finding the intake drops is surfaced at the review gate as a
disposition the operator confirms." Verified against git, that contradicts a direction the owner
locked on 2026-06-16:

- `8daee13a` — *"docs: lock item-1 convergence direction"*: "Ethan wants ONE preview per run,
  tiered by review-necessity, over the DEDUPED/grounded survivor set (**no items that will later be
  deduped/dropped**)."
- `161d60aa` — *"feat(remediate): Path-A single filter pass + review over the deduped survivor
  set"*: "the gate previews the SURVIVORS tiered by review-necessity — not the raw pre-dedup set."
- The current code states the same rule at
  [`nextStep.ts:2017-2020`](../../src/remediate/steps/nextStep.ts#L2017).

So the backlog entry asks for exactly what the owner removed. **Do not argue it back in.** The
owner decides whether the 2026-06-16 lock still holds.

### ADOPTED — the audit draw already renders its diagnostics block

The lane cites `renderIngestIssueLines` at
[`src/audit/cli/semanticReviewStep.ts:49-60`](../../src/audit/cli/semanticReviewStep.ts#L49), used
in the prompt at [`semanticReviewStep.ts:170-174`](../../src/audit/cli/semanticReviewStep.ts#L170).
The plan step "give the audit draw the same rendered diagnostics block" was therefore wrong: the
audit draw has one. Only the cross-call carry is missing.

### REJECTED — "making the parser report what it drops is unsafe"

The lane argues that reporting turns an opt-in best-effort channel into a blocking gate, and that
`src/shared/friction/triage.ts` would mint a mandatory triage subject per malformed line.

That refutes an implementation nobody proposed. The lane's own words are "*If* reporting throws" —
nothing in the plan throws. A report returned **as data alongside the reflections**, which each
caller may ignore, changes no caller's behaviour unless that caller opts in. The `triage.ts` hazard
is real but is avoided by not feeding discarded records into `collectTriageSubjects`.

⚠ Decisive: **the owner has already settled this half.** Nightly decision `6aebffe0c4e32e11` reads
"Name the field in the prompt **AND** make the parser report what it drops. The prompt edit fixes
today's gap; the parser change makes the next one visible instead of silent." A lane may not
overturn a settled owner decision; it may only warn about how to implement it, which it usefully
did.

**Constraint adopted from the objection:** the discarded record must have a real consumer (an
additive export with no adopter reds `check:deadcode`), and that consumer must not be the mandatory
friction triage.

### REJECTED — "a new step kind is not correct" for instance 1

The lane proposes reusing `collect_starting_point` with the reason passed into its prompt.

That cannot satisfy the entry's Property, which is that the step "never reads as 'no input
supplied'". A step whose heading is `# Collect Remediation Starting Point` reads as exactly that,
whatever the body adds. The union's own most recent member documents additive kinds as safe and
names conflation as the defect to avoid (see *Precedent* above).

The lane's `blocked` alternative is also wrong for this case: `blocked` is documented as the
terminal backstop for "next-step dies on an unhandled error", and a discarded plan is a handled,
recoverable state.

### Correction the lane made to this document's own claims

The lane objected that this record "claims `renderContractRepairPrompt` throws". It no longer does
— this record already states the throw is unreachable, and the lane independently reached the same
conclusion by the same route (`CP_ARTIFACT_NAMES` populates every key). Two independent derivations
agree, so instance 3's characterisation is firm.

## Open questions for the refutation lane

1. Is instance 4's remediate half genuinely closed, or does a path still reach the re-emit without
   the diagnostics block?
2. For instance 2, is the audit draw's evidence-free mint **intended** — is there a grounding class
   the remediate intake should admit rather than a defect on the audit side?
3. For instance 3, does either caller already bind all six artifacts, making the throw unreachable
   on one trigger?
4. Does instance 4's audit half reduce entirely to the tracked cross-call advisory carry, or is
   there a second loss inside a single call?
