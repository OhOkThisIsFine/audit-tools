# Prompt Contract Standard and Verified Prompt Review — 2026-09-19
<!-- review-routing: backlog-bugs -->

This document is the implementation target for prompt cleanup across `audit-code` and
`remediate-code`. It supersedes ad-hoc prompt-shape decisions with one small prompt contract
standard, and records which issues from the 2026-09-19 review survived verification against the
actual producers, validators, and execution paths.

The earlier inventory,
[`prompt-refinement-2026-09-13.md`](prompt-refinement-2026-09-13.md), remains useful historical
evidence. This document is the narrower, verified design to implement.

---

## 1. Scope and design goal

The failure pattern is not that prompts are uniformly bad. The contract-pipeline prompts in
`src/remediate/steps/contractPipelinePrompts.ts` already demonstrate the strongest pattern in the
repository:

- exact required inputs,
- explicit read scope,
- one bounded task,
- one output path,
- a complete output sketch,
- validator-backed field rules,
- a self-check command,
- an explicit stop condition.

The weaker prompts are mostly orchestration/driver prompts and generic dispatch wrappers. They are
more likely to:

- duplicate facts owned by schemas or validators,
- refer to state or files the executor was never given,
- hide the immediate action under rationale,
- use incomplete closed vocabularies,
- leave actor ownership ambiguous,
- inherit a generic fallback that contradicts the lane's purpose.

The goal is therefore **not** a large prompt framework or a universal prose generator. The goal is a
small set of structural invariants and reusable fragments that make these mistakes hard to write and
easy to test.

---

## 2. Verified findings

### P0 — correctness

#### P0.1 — Audit host worker prompt asks for `reviewed_clean`, but the ingest contract rejects it

**Files**
- `src/audit/cli/dispatch/hostHandoff.ts`
- `tests/audit/host-handoff.test.ts`

`buildPrompt()` says the result contract contains `reviewed_clean` (conditionally for the base
lane and unconditionally for the steward lane). But:

- `AUDIT_RESULT_ENVELOPE_KEYS` does not include `reviewed_clean`;
- `renderResultTemplate()` omits it and tells the worker to fill only `file_coverage` and
  `findings`;
- `parseHostResult()` uses an exact-key gate and therefore rejects a submission that follows the
  prose and adds `reviewed_clean`;
- `toAuditResult()` derives `reviewed_clean: result.findings.length === 0` itself.

This is a real prompt/consumer contradiction, not a style issue.

**Required correction:** make `reviewed_clean` tool-owned everywhere. Remove it from worker-facing
result prose and pin that the rendered prompt, result template, and accepted envelope agree.

---

#### P0.2 — Audit `confirm_intent` lies about which checkpoint fields are required

**Files**
- `src/audit/cli/confirmIntentStep.ts`
- `src/shared/types/intentCheckpoint.ts`

The prompt says:

> only `scope_summary` and `intent_summary` are required

The strict schema requires all of:

- `schema_version`
- `confirmed_at`
- `confirmed_by`
- `scope_summary`
- `intent_summary`

The example happens to show the missing required fields, but the prose explicitly contradicts the
schema.

**Required correction:** render required/optional status from the actual contract, or at minimum
state the complete required set with a regression test tied to the schema.

---

#### P0.3 — Audit `confirm_intent` hides a closed vocabulary behind `...`

**Files**
- `src/audit/cli/confirmIntentStep.ts`
- `src/shared/types/disposition.ts`

The prompt sketches:

```text
"<generated|vendor|excluded|...>"
```

The actual accepted vocabulary is:

```text
included | excluded | generated | vendor | binary | doc_only
```

This makes the executor guess a schema value that the tool already knows exactly.

**Required correction:** render the full vocabulary from the same source that validation uses. No
closed enum in a prompt may contain `...`.

---

#### P0.4 — Second-order adversary cannot obey the generic no-subagent fallback

**Files**
- `src/audit/systemic/secondOrderAdversaryPrompt.ts`
- `src/audit/cli/nextStepCommand.ts`
- `src/shared/prompts.ts`

The generic fanout instruction says:

> dispatch one subagent per file if a subagent facility exists, else read and follow each file
> sequentially yourself

The second-order adversary says:

> You are a SEPARATE agent from the one that drove this audit.

and:

> If you ARE the agent that drove this audit, stop and say so instead of answering.

The dispatch envelope also explicitly says that this lane must not be the driver. The generic
fallback therefore violates the defining requirement of the lane.

**Required correction:** fallback policy must be lane-compatible. Independence-required lanes must
state the need and a truthful degraded behavior; they must not inherit a generic "do it yourself"
fallback that makes compliance impossible.

---

### P1 — substantial prompt-contract defects

#### P1.1 — Remediation ambiguity review asks for evidence it does not supply

**Files**
- `src/remediate/steps/prompts.ts`
- `src/remediate/steps/nextStep.ts`

`ambiguityReviewPrompt()` tells the host to:

1. read the cited files for each candidate, and
2. add missed ambiguities for any finding in the plan.

The emitted prompt contains only sparse `ClarificationRequest` data:

- finding id,
- category,
- candidate description,
- the closed set of valid finding ids.

The step's readable artifacts do not provide a complete finding packet containing affected files,
evidence, summary, confidence, etc.

**Required correction:** materialize or bind a bounded ambiguity-review packet containing the full
context the review requires, and name its exact path in the prompt/read scope.

---

#### P1.2 — Critical-flow fallback contains a dangling guessed artifact name

**Files**
- `src/audit/reporting/criticalFlowFallbackPrompt.ts`
- `src/audit/cli/nextStepCommand.ts`

When more than 80 flows exist, the lane prompt says:

> see `critical_flows.json`

But the renderer is given only the manifest value, not a path, and the step grants the worker only the
materialized lane prompt as a read path. The phrase therefore names a guessed relative filename that
is not bound to the step.

**Required correction:** either render all required information into the prompt or pass the exact
artifact path to the renderer and grant that path in `access.read_paths`.

---

#### P1.3 — Audit `confirm_intent` has too many responsibilities in one prompt

**File**
- `src/audit/cli/confirmIntentStep.ts`

The prompt currently combines:

- deterministic scope presentation,
- scope-rule interpretation,
- disposition review,
- internal lens recommendation review,
- canonical lens explanation,
- optional/custom lens selection,
- conceptual review-depth selection,
- one-round operator interview,
- constraint-clause resolution,
- strict JSON authoring,
- continuation instructions.

This makes the immediate action hard to find and increases the chance that an executor satisfies one
part while overlooking another.

**Required correction:** use the driver format in this document. Put the operator decision first,
then only the facts required for that decision, then the exact record format. If the content still
does not fit one immediate responsibility, split deterministic packet preparation from the
operator-facing confirmation step.

---

#### P1.4 — Audit loader asks for an undefined "structural-capability preflight"

**File**
- `skills/audit-code/audit-code.prompt.md`

The loader asks the host to confirm that its tools can inspect the required "structural
graph/relationships and source structure", while also saying that the presence of a tool or server
is insufficient evidence. No operational test defines what counts as enough capability.

The loader is also otherwise designed to be thin: call `next-step`, read `prompt_path`, and follow
that prompt. This abstract preflight makes the loader itself a second workflow authority.

**Required correction:** move capability requirements into an emitted step with concrete evidence or
acceptance criteria. Keep the loader limited to bootstrap, argument forwarding, current prompt
execution, and continuation.

---

### P2 — consistency and clarity debt

These are real, but they are not equivalent to the P0/P1 execution defects.

#### P2.1 — Remediate guidance-file instructions have two authorities

**Files**
- `skills/remediate-code/remediate-code.prompt.md`
- `src/remediate/steps/prompts.ts`
- `src/shared/intake/guidanceBootstrap.ts`

The loader says conversational feedback should be written to a temporary file and passed with
`--guidance-file`. The starting-point prompt tells the host to write directly to
`intake/conversation-start.md` and pass that same path as `--guidance-file`.

This is functionally supported: `applyGuidanceFile()` explicitly treats source==target as a no-op.
So this is not a runtime bug.

**Required correction:** one prompt owns the intake mechanics. Prefer the emitted starting-point
prompt; the loader should state only that `--guidance-file` is available when explicitly supplied
or instructed.

---

#### P2.2 — Extracted-plan recovery is usable, but not in the standard format

**Files**
- `src/remediate/steps/prompts.ts`
- `src/remediate/steps/nextStep.ts`

The earlier review overstated this issue. Recovery does preserve the rejected plan, carries the exact
normalization/grounding failure reason into the emitted step, and explains the two common failure
classes.

What remains is consistency debt: the repair prompt does not present the corrected artifact using the
same explicit input/output/check structure as the contract-pipeline prompts.

**Required correction:** migrate it to the driver/repair shape below. This does not need to block the
P0/P1 work.

---

#### P2.3 — Triage does not explain what `halt` actually does

**Files**
- `src/remediate/steps/prompts.ts`
- `src/remediate/phases/triage.ts`

The prompt defines `retry` and `ignore`, but not `halt`.

The consumer makes `halt` a whole-run action: it archives the resolution, marks remaining
nonterminal work abandoned, sets `closing_context: "user_halted"`, and routes to partial closeout.

The prompt also does not render the closed set of valid blocked finding ids.

**Required correction:** state the whole-run consequence of `halt`, render the valid ids, and make
clear that omitted blocked items remain unresolved and will be re-presented.

---

#### P2.4 — Degraded independent review has no standard structured marker

**Files**
- `src/shared/prompts.ts`
- `src/remediate/steps/contractPipelinePrompts.ts`

The full independent-review mandate says that, when no independent context is available, an inline
self-review may proceed as a degraded fallback and should "say in the output" that it was
self-conducted.

The critique/critic/judge output shapes do not define where that fact belongs. Their validators are
not exact-key schemas, so an extra field is not necessarily rejected; the executor is simply forced
to invent a representation.

**Required correction:** choose one standard representation, ideally tool/step metadata rather than
inventing a semantic field independently in each review artifact.

---

#### P2.5 — Stated-charter example uses code-looking evidence

**File**
- `src/audit/cli/charterExtractionPrompt.ts`

The stated lane is testimony-only (docs and comments), but its worked example still uses references
such as `src/scheduling/promise.ts#Promise` and quotes such as `class Promise {`, merely changing
the provenance kind to `doc`.

The example is schema-valid but semantically misleading for the lane.

**Required correction:** render lane-specific examples:
- stated: README/doc/comment testimony,
- structural: file tree/declaration/import evidence,
- revealed: code-body behavior.

---

#### P2.6 — Analyzer install choice does not name the decision-maker

**File**
- `src/audit/cli/prompts.ts`

The analyzer consent prompt explicitly says to present each candidate to the operator and not decide
on the operator's behalf. The install prompt only says:

> Choose `ephemeral`, `permanent`, or `skip`

Because persistence/install behavior is an operator-level decision, the actor should be explicit.

**Required correction:** use the driver format and say who chooses.

---

## 3. Retracted finding

### `created_at` omission in contract-pipeline prompts is intentional

Do **not** "fix" the contract-pipeline prompt sketches by adding `created_at`.

`stampToolCreatedAt()` in `src/remediate/contractPipeline/artifactStore.ts` owns the field. The test
suite explicitly records this asymmetry as a design decision and asserts that no host sketch asks the
worker to supply it.

This is an example of the desired rule: tool-owned fields should stay out of worker-authored
contracts.

---

## 4. Prompt Contract v1

Prompt Contract v1 defines three profiles:

1. **worker** — a bounded semantic task that writes an artifact;
2. **driver** — an orchestration/operator decision that records a result;
3. **dispatch** — a thin envelope that tells the host which already-materialized lanes to execute.

The headings below are a canonical order, not a requirement to print empty sections.

### 4.1 Worker prompt

```md
# <Task name>

<One sentence saying exactly what to do.>

## Inputs

- `<exact path>` — <what it contains>
- `<exact path>` — <what it contains>

## Read Scope

<Exactly what may be read. No implied files or state.>

## Task

<Short bounded instructions.>

## Output

Write exactly one artifact to:

`<exact output path>`

It must have this shape:

```json
{
  "...": "complete admissible shape"
}
```

## Rules

- <complete closed vocabularies>
- <validator-enforced field invariants>
- <tool-owned behavior only when omission would otherwise be ambiguous>

## Check

`<exact validation command>`

`status: "ok"` means the artifact is admissible.

## Stop

Stop after writing the output. Do not start the next phase.
```

The contract-pipeline prompts are the reference implementation for this profile.

---

### 4.2 Driver/operator prompt

```md
# <Decision name>

## Do Now

<One sentence saying what the host must ask, decide, or collect.>

## Facts

<Only the facts needed for that decision.
Use exact paths for any additional material that must be read.>

## Ask / Decide

<The complete questions or choices.
Explicitly name the decision-maker: operator, host, or tool.>

## Record

Write the decision to:

`<exact path>`

```json
{
  "...": "complete shape"
}
```

Valid values: <complete closed set>

## Continue

Run:

`<exact command>`
```

A driver prompt is not exempt from contracts merely because a human is involved. Its contract is the
decision boundary: actor, available evidence, allowed choices, record shape, and continuation.

---

### 4.3 Dispatch/fanout prompt

```md
# <Phase name>

## Do Now

Execute these lane prompts:

- `<lane prompt path>` -> `<result path>` — demand: <...>
- ...

<Fallback rule compatible with the lane class.>

## Continue

After every required result has been written, run:

`<exact command>`
```

The dispatch prompt must not restate the lane's semantic task or result schema. Those facts belong in
the lane prompt. The dispatch envelope owns only orchestration.

---

## 5. Repository-wide invariants

These are the hard rules Prompt Contract v1 should test.

### PC-01 — Actor ownership is explicit

Use language such as:

- "Ask the operator..."
- "The worker writes..."
- "The host records..."
- "The tool derives..."

Avoid bare "choose", "decide", or "record" where more than one actor could plausibly own the action.

### PC-02 — Immediate action comes first

The executor should not need to read rationale, history, or implementation notes to learn what to do
now.

### PC-03 — No hidden context

Anything the executor must know is either:

- rendered directly,
- supplied at an exact path granted to the step, or
- explicitly tool-owned and therefore not the executor's responsibility.

### PC-04 — No guessed paths

A phrase such as "see `foo.json`" is invalid unless that exact artifact path is bound to the step.

### PC-05 — Closed vocabularies are complete and derived

Never render:

```text
<a|b|...>
```

for a validator-owned enum. Render all accepted values from the same constant/schema source.

### PC-06 — Worker-owned and tool-owned fields are distinct

If the tool derives a field such as `reviewed_clean` or `created_at`, do not ask the worker to
supply it.

### PC-07 — Required/optional claims agree with the consumer

Prompt prose, examples, templates, and validators must describe one contract.

### PC-08 — One immediate responsibility per prompt

A prompt may carry supporting facts, but it should have one immediate action boundary. If it both
performs substantial semantic analysis and conducts a multi-part operator interview and authors a
strict artifact, split the responsibilities or precompute a decision packet.

### PC-09 — Worker outputs have a mechanical self-check when available

When a worker-accessible validator exists, render the exact validation command and success condition.

### PC-10 — Every prompt has a terminal instruction

A prompt ends by telling the executor to exactly one of:

- stop,
- wait for the operator,
- or run the named continuation command.

### PC-11 — Fallbacks preserve lane semantics

A generic fallback must not violate the property that gives the lane value. In particular, an
independence-required reviewer cannot silently become the author reviewing its own work.

### PC-12 — Examples are admissible and lane-specific

Examples must pass the relevant contract and model the evidence channel the lane actually receives.

---

## 6. Test architecture

The current prompt-contract registry is strong for schema-bound worker prompts but explicitly places
many driver prompts under `declared-gap` because they do not have a worker output contract. That is
where several verified failures survived.

Do not solve this by forcing driver prompts into worker schemas. Instead, classify prompt builders by
profile and test the right contract for each.

### Worker-profile tests

Keep and extend the current schema/projection tests:

- rendered output sketch matches the accepted shape,
- closed enums come from validator-owned constants,
- required inputs are derived from the dependency map,
- output path and validator command are present,
- tool-owned fields are absent from host-authored sketches,
- terminal instruction is present.

### Driver-profile tests

Add structural assertions for:

- decision-maker is explicit,
- every referenced read artifact is present in the step's read scope,
- every referenced write path is present in the step's write scope/artifact paths,
- closed choice sets are complete,
- required fields in the rendered record agree with the real schema,
- a continuation command is explicit,
- no prose requires state not rendered or bound.

### Dispatch-profile tests

Assert:

- every lane prompt path exists in the step contract,
- every lane result path is bound,
- dispatch text does not duplicate worker result schemas,
- fallback mode is compatible with the lane's independence classification,
- continuation remains owned by the dispatch step, not the lane file.

The registry may expose `profile: "worker" | "driver" | "dispatch"`; this is preferable to expanding
a generic "declared gap" bucket.

---

## 7. Implementation order

### Slice 1 — correctness first

1. Remove worker-authored `reviewed_clean` from the audit host-handoff prompt.
2. Fix `confirm_intent` required-field wording.
3. Render the complete disposition vocabulary from schema-owned values.
4. Resolve the second-order adversary/fallback contradiction.

These should land with direct regression tests before broader prompt cleanup.

### Slice 2 — establish Prompt Contract v1 primitives

Add only the small reusable pieces that eliminate repeated mistakes:

- exact input/read-path rendering,
- complete closed-value rendering,
- output-path/shape section,
- validation/check section,
- stop/continue section,
- lane-class-compatible dispatch fallback.

Avoid a generic prose DSL or a central mega-renderer.

### Slice 3 — migrate the P1 prompts

Prioritize:

1. ambiguity-review evidence packet,
2. critical-flow exact artifact binding,
3. `confirm_intent` restructuring,
4. audit loader capability handling.

### Slice 4 — migrate P2 prompts opportunistically

Guidance-file ownership, triage semantics, independent-review metadata, charter examples, analyzer
install actor naming, and extracted-plan repair formatting can move to the standard without blocking
the earlier correctness work.

---

## 8. Acceptance criteria

This work is complete when:

- the four P0 contradictions are gone and regression-pinned;
- no prompt names a closed enum with an ellipsis;
- no prompt tells an executor to read an artifact that is not rendered or granted;
- driver prompts are covered by explicit contract tests rather than a generic exemption;
- independence-required lanes have a fallback policy that does not contradict their purpose;
- worker-owned versus tool-owned output fields are mechanically distinguished;
- the audit/remediate loaders remain thin and do not become parallel workflow engines;
- new prompts have an explicit profile and satisfy the corresponding Prompt Contract v1 invariants.

The standard should reduce governance machinery, not add a second prompt framework. The useful
abstraction boundary is **a few shared facts plus contract tests**, not centralized prose generation.
