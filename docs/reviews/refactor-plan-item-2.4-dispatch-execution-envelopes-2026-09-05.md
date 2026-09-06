# Refactoring Plan: Item 2.4 - Dispatch Execution Envelopes

## Item Overview & Current State

- **Item:** 2.4 Dispatch Execution Envelopes
- **Files Involved:**
  - `src/audit/cli/nextStepCommand.ts` (only production file touched)
- **Key Symbols:** `emitCriticalFlowFallback`, `emitSynthesisNarrative`, `emissionRow`, `currentStepPlan`, `materializeFanoutLanes`
- **Prior Sweep & Verification Findings:**
  The sweep identified duplicate prompt tails ("The executor must write the ... JSON object to: ... When the result file exists, run: ...").
  Verification found this is part of a type-checked total dispatch table over result variants where common machinery is already factored. Extracting an 8-line prompt tail adds indirection to an intentional table design. The plan should assess whether to formalize as benign repetition or define a narrow prompt helper.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What the code is (read this before touching it)

`src/audit/cli/nextStepCommand.ts` owns the **step-emission dispatch**: every
host-actionable `NextStepResult["kind"]` contributes exactly one row to
`NEXT_STEP_EMISSION_TABLE`, each row built with `emissionRow` (which binds the
row to its own result variant so the narrowing is stated once, not re-checked
per body) and each row returning only a **plan** via `currentStepPlan` /
`blockedStepPlan` / `semanticReviewPlan`. The single emission site
`NEXT_STEP_EMISSION` (built by `createStepEmissionScaffold`) writes and logs
exactly once through `writeAuditStep`. The table is typed as a total record
over `NextStepEmissionKind`, so a kind added upstream with no row is a compile
error, and `NEXT_STEP_EMISSION_KINDS` is derived from the table's own keys so
no second hand-listed copy can drift.

The header comment above the table states the design intent explicitly: the
table exists to eliminate the old hand-repeated four-part scaffold (resolve a
lane path, build a prompt array, call `writeCurrentStep`, log and return)
that previously had to be changed in sixteen places by hand.

### 1.2 What is actually duplicated

Each single-lane fan-out row builds its host-facing step prompt from the same
envelope:

1. a `# audit-code <name>` title,
2. `renderLaneShortfallLines(shortfall)`,
3. `renderFanoutExecutionLines(...)` over the pending lanes,
4. a results-path sentence naming the schema noun
   ("The executor must write the CriticalFlowFallbackResult JSON object to:"
   vs "The executor must write the SynthesisNarrative JSON object to:"
   vs "The executor must write its CharterDeltaSubmission JSON to:"
   vs "The executor must write its findings JSON to:"),
5. the continue-command block
   ("When the result file exists, run:" / blank / `continueCommand` / blank /
   "Read and follow only the new step prompt returned by that command.").

Rows exhibiting this envelope: `emitCharterExtraction`, `emitCharterDelta`,
`emitSystemicChallenge`, `emitCriticalFlowFallback`,
`emitSynthesisNarrative`. The design-review branches
(`emitDesignReviewParallel`, `emitDesignReviewContract`,
`emitDesignReviewConceptual`) carry near-variants with different lead-in
wording ("When the contract results have been written, run:") and are
**out of scope** (see 1.4).

Steps 2 and 5 are already single-sourced (`renderLaneShortfallLines` in
`laneSubmissions.ts`, `renderFanoutExecutionLines` in `src/shared/prompts.ts`).
What repeats per row is therefore: the title line, the schema-noun sentence
(which is genuinely per-row content, not boilerplate), and the ~6-line
continue-command closer. The prior verification note ("extracting an 8-line
prompt tail adds indirection to an intentional table design") is correct
about the *scale* but misses that the closer is the one piece with zero
per-row information — it is pure ceremony, and ceremony with zero information
is exactly what drifts (one row gains a sentence, the others don't, and no
test pins the envelope because existing tests assert structure, not prompt
bytes — see 5.3).

### 1.3 Verdict: narrow prompt-tail helper, rows stay per-kind

**Keep the row-per-kind table shape. Extract only the zero-information
closer (plus the title+execution-lines assembly) into one narrow helper.**
Rationale:

- The table's totality typing is the load-bearing property: one row per kind,
  each row free to differ in `stepKind`, `stopCondition`, `artifactPaths`,
  and `access`. Merging `emitCriticalFlowFallback` and
  `emitSynthesisNarrative` into a shared "single-lane emitter" would erase
  exactly the per-row differences that matter (`stepKind:
  "critical_flow_fallback"` vs `"synthesis_narrative"`, different
  `stopCondition` strings, different `artifactPaths` keys) while saving almost
  nothing — the rows differ in every field except the closer.
- The closer carries no per-row information, so parameterizing it introduces
  no speculative abstraction: the helper takes the pieces that already exist
  as values (`title`, `shortfallLines`, `executionLines`, `writeSentence`,
  optional `midNote`, `continueCommand`) and returns `string[]` prompt lines.
  No new concepts, no options object that grows a boolean per caller.
- The schema-noun sentence (step 4) stays a **caller-supplied string**, not a
  helper parameter with a union of nouns: the helper must not know the
  registry of submission schemas. The two rows each keep their own sentence
  verbatim.

This is therefore a **benign-repetition-formalized** outcome, not a
keep-as-is outcome: the repetition is benign *per row* but the closer is
promoted to a shared helper so the next envelope edit lands once.

### 1.4 Explicit non-goals / boundary rules

1. **Do not touch the lane-file footer.** `materializeFanoutLanes` already
   appends the canonical results-path section (`renderLaneResultsFooter`) to
   every lane prompt file. The step-prompt tail names the bound path for the
   *host*; the lane file carries the write instruction for the *worker*.
   These are two audiences, not a duplication — conflating them would break
   the advance-free lane invariant (lane files carry no continue-command;
   the step prompt owns the advance; see `fanoutLanes.ts` module comment and
   the `prepareContractDispatch` independence note).
2. **Do not touch the design-review branches.** Their closers differ in
   wording and their prompts compose `instructionLine` /
   `conceptual.instructionLines` pieces. Forcing them through the same helper
   would either change host-visible wording or add branching inside the
   helper — both worse than the current near-duplication.
3. **Do not change submission-path derivation in this item.** `emitCharterDelta`,
   `emitSystemicChallenge`, `emitEdgeReasoning`, and the two rows here each
   compute their submission path via their own `laneSubmissionPath` call and
   interpolate it, while `materializeFanoutLanes` derives the same path a
   second time internally (recorded as a standalone audit finding; the
   `prepareContractDispatch` comment documents that this exact guessable-string
   coincidence already bit once). Unifying those derivations is a real fix but
   a different seam with its own blast radius — noted as follow-up work in
   section 6, not folded in here.
4. **Do not change `emissionRow`, `currentStepPlan`, `writeAuditStep`,
   `NEXT_STEP_EMISSION_TABLE`, or the scaffold.** The helper operates strictly
   *inside* row bodies, at prompt-array construction. Table shape, plan shape,
   and emission mechanics are untouched.
5. **Byte-identical host-visible prompts.** The refactor must not alter a
   single byte of any emitted step prompt or lane file. The helper reorders
   nothing and rewords nothing; verification diffs prompts before/after
   (see 5.2).

---

## 2. Blast Radius & Affected Files

### 2.1 Production code

| File | Change |
|---|---|
| `src/audit/cli/nextStepCommand.ts` | **Only file changed.** Add one module-local helper (next to `operatorHandoffBlock`, the existing shared prompt-shape home); call it from `emitCriticalFlowFallback` and `emitSynthesisNarrative`. Optionally call it from `emitCharterDelta` and `emitSystemicChallenge` if their envelopes match without wording changes (see 4.3 — decision rule, not a mandate). |

No changes to `src/shared/prompts.ts` (`renderFanoutExecutionLines`),
`src/audit/cli/fanoutLanes.ts` (`materializeFanoutLanes`),
`src/audit/cli/laneSubmissions.ts` (`renderLaneShortfallLines`,
`laneSubmissionPath`), `src/audit/cli/prompts.ts`, or any orchestrator /
reporting module (`criticalFlowFallbackPrompt.ts`,
`synthesisNarrativePrompt.ts` render only the lane bodies, not the envelope).

### 2.2 Callers / dependents

- `NEXT_STEP_EMISSION_TABLE` keys, `NEXT_STEP_EMISSION_KINDS` derivation,
  `writeAuditStep` dispatch, and the `semantic_review` fallback are
  untouched — the drift guards in `tests/audit/next-step-helpers.test.ts`
  (table key set, no `semantic_review` row, kinds-set equality, source-text
  assertion on the `handledKeys` derivation) and
  `tests/audit/seam-host-only-next-step.test.ts` (host-only seam key set)
  cannot observe the change.
- No other module imports `emitCriticalFlowFallback` or
  `emitSynthesisNarrative` (both are module-local `const`s, not exported).
  `currentStepPlan` and `emissionRow` are module-local; their signatures are
  unchanged.
- Host-visible contract (`current-step.json` shape, `prompt_path` file
  bytes, `artifact_paths`, `access`, `submissionShortfall`) is byte-identical
  by construction (5.2 proves it).

### 2.3 Risk assessment

Low. The change is a pure intra-function extraction inside two row bodies
with no signature, control-flow, ordering, or IO changes: same `await
materializeFanoutLanes` call with the same spec, same `currentStepPlan`
fields, same array-join. The only failure mode is a whitespace/ordering slip
in the assembled prompt, which the byte-identity check (5.2) catches
deterministically.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 Add: `renderSingleLaneDispatchEnvelope` beside `operatorHandoffBlock`

`operatorHandoffBlock` is the existing precedent: a module-local function
that single-sources a prompt/step shape two emitters share. Place the new
helper directly after it, in the same "shared shape" region, before
`writeAuditStep`.

Proposed shape (names negotiable, semantics not):

```ts
/**
 * The host-facing envelope every single-lane fan-out row wraps its lane
 * execution lines in: title, re-emission shortfall, the lane execution
 * lines, the bound results-path sentence (caller-supplied — the schema noun
 * is per-row content, not boilerplate), an optional mid-note (e.g. the
 * systemic-challenge empty-findings terminator), and the continue-command
 * closer this step's advance lives in. Single-sourced so the closer cannot
 * drift across rows; the lane FILE's own results-path section stays the lane
 * materializer's (`renderLaneResultsFooter`), not this helper's — this is
 * the host envelope, not the worker instruction.
 */
function renderSingleLaneDispatchEnvelope(opts: {
  title: string;
  shortfallLines: string[];
  executionLines: string[];
  /** e.g. "The executor must write the SynthesisNarrative JSON object to:" */
  writeSentence: string;
  submissionPath: string;
  continueCommand: string;
  /** Rendered between the results path and the closer, when present. */
  midNote?: string;
}): string[] {
  return [
    opts.title,
    "",
    ...opts.shortfallLines,
    ...opts.executionLines,
    "",
    opts.writeSentence,
    "",
    `  ${opts.submissionPath}`,
    "",
    ...(opts.midNote ? [opts.midNote, ""] : []),
    "When the result file exists, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
    "Read and follow only the new step prompt returned by that command.",
    "",
  ];
}
```

Design notes:

- Returns `string[]` (prompt lines), not a joined string: every caller
  `.join("\n")`s its prompt array, so the helper composes at the same level
  as `renderFanoutExecutionLines` (which also returns `string[]`).
- `shortfallLines` and `executionLines` are caller-computed arrays
  (`renderLaneShortfallLines(...)` and `renderFanoutExecutionLines({...})`
  outputs), keeping the helper free of fanout types.
- `midNote` exists for `emitSystemicChallenge`'s "An EMPTY findings array is
  the deliberate loop terminator..." paragraph should that row adopt the
  helper; the two target rows pass no `midNote`.
- The helper performs no IO, reads no disk, derives no paths. Path
  derivation stays exactly where it is today (see non-goal 3).

### 3.2 Call from `emitCriticalFlowFallback`

Inside `emitCriticalFlowFallback`, replace the inline `prompt: [...]` array
(title `"# audit-code critical-flow fallback"`, `renderLaneShortfallLines`
spread, `renderFanoutExecutionLines` spread, the
`"The executor must write the CriticalFlowFallbackResult JSON object to:"`
sentence with `fallbackResultsPath`, the closer with `continueCommand`) with:

```ts
prompt: renderSingleLaneDispatchEnvelope({
  title: "# audit-code critical-flow fallback",
  shortfallLines: renderLaneShortfallLines(fanout.shortfall),
  executionLines: renderFanoutExecutionLines({
    lanes: fanout.pendingLanes.map((lane) => ({
      label: lane.label,
      promptPath: lane.promptPath,
    })),
  }),
  writeSentence:
    "The executor must write the CriticalFlowFallbackResult JSON object to:",
  submissionPath: fallbackResultsPath,
  continueCommand,
}).join("\n"),
```

Everything else in the row — `laneSubmissionPath` derivation of
`fallbackResultsPath`, `materializeFanoutLanes` spec, `stepKind`,
`status`, `allowedCommands`, `stopCondition`, `artifactPaths:
fanout.artifactPaths`, `access`, `submissionShortfall` — is untouched.

### 3.3 Call from `emitSynthesisNarrative`

Symmetric replacement inside `emitSynthesisNarrative` with title
`"# audit-code synthesis narrative"`, write sentence
`"The executor must write the SynthesisNarrative JSON object to:"`, and
`submissionPath: narrativeResultsPath`. All other row fields untouched.

### 3.4 Decision rule for `emitCharterDelta` / `emitSystemicChallenge` / `emitCharterExtraction`

These rows share the envelope shape but differ in details:

- `emitCharterDelta`: write sentence `"The executor must write its
  CharterDeltaSubmission JSON to:"` — fits the helper as-is.
- `emitSystemicChallenge`: write sentence `"The executor must write its
  findings JSON to:"` plus the empty-findings paragraph — fits via
  `midNote`.
- `emitCharterExtraction`: richer body (blind-lane explanation paragraph,
  completed-lanes paragraph, extra `"Read and follow only..."` after the
  continue command) — does **not** fit without restructuring; leave it.

Rule: adopt the helper in `emitCharterDelta` and `emitSystemicChallenge`
**only if** a pre-change capture proves the helper output is byte-identical
to the current prompt for those rows (same procedure as 5.2). If any wording
or ordering difference appears, leave that row on its inline array — a
two-row helper shared by the item's named rows is already the win; forcing a
third row through it at the cost of host-visible wording changes violates
non-goal 5. Record whichever decision is taken in the closeout.

---

## 4. Step-by-Step Implementation Sequence

1. **Capture baseline prompts.** Run the existing harness paths that emit
   both steps and save the step-prompt files byte-for-byte:
   `tests/audit/next-step-critical-flow-fallback.test.ts` emits a
   `critical_flow_fallback` step (read `paused.prompt_path`); 
   `tests/audit/next-step-narrative.test.ts` emits a `synthesis_narrative`
   step the same way. Save both prompt files to a temp dir outside the repo
   (never a tracked path — tests must reference tracked paths only).
2. **Add `renderSingleLaneDispatchEnvelope`** after `operatorHandoffBlock`
   in `src/audit/cli/nextStepCommand.ts`, with the doc comment from 3.1.
   No other edit in this step; typecheck (`tsc`) to confirm the helper
   compiles unused (or gate with the call sites in one edit — either way,
   one commit).
3. **Rewire `emitCriticalFlowFallback`** per 3.2. Diff the emitted prompt
   against the baseline from step 1 — must be byte-identical.
4. **Rewire `emitSynthesisNarrative`** per 3.3. Same byte-identity diff.
5. **Evaluate `emitCharterDelta` / `emitSystemicChallenge`** per the 3.4
   rule; adopt or explicitly decline with a one-line comment at the declined
   row noting why (wording fit). Do not touch `emitCharterExtraction` or the
   design-review rows.
6. **Run the verification plan** (section 5). Commit as a single
   refactor commit; expected diff is roughly +30 / −30 lines in one file.

---

## 5. Verification & Regression Test Plan

### 5.1 Typecheck & lint

- `tsc` (or the repo's typecheck script) clean — the helper is fully typed;
  `shortfallLines`/`executionLines` are `string[]`, all fields required
  except `midNote`.
- ESLint on the touched file if the repo lints (the repo's post-edit hook
  runs tsc+eslint on TS edits).

### 5.2 Byte-identity of host-visible prompts (the load-bearing check)

For each of `critical_flow_fallback` and `synthesis_narrative`:

- Re-run the corresponding existing test's emission path and diff the
  resulting `prompt_path` file against the step-1 baseline: `diff` must be
  empty. This proves non-goal 5 (no host-visible change).
- Additionally diff the lane prompt files (`*_prompt` under
  `artifact_paths`) — they must also be unchanged, proving the lane
  materializer path was not disturbed.

If `emitCharterDelta` / `emitSystemicChallenge` are adopted, repeat for
those rows via their existing harness/tests (charter-delta and
systemic-challenge coverage in `tests/audit/`).

### 5.3 Existing suite (no new tests required)

Run, at minimum:

- `tests/audit/next-step-critical-flow-fallback.test.ts` — guards the
  `critical_flow_fallback` emission (prompt path, artifact paths, access
  write paths).
- `tests/audit/next-step-narrative.test.ts` — guards the
  `synthesis_narrative` emission.
- `tests/audit/next-step-helpers.test.ts` — guards
  `NEXT_STEP_EMISSION_TABLE` key set, `NEXT_STEP_EMISSION_KINDS` derivation,
  and per-row plan-shape invariants (this is where a table-shape regression
  would surface).
- `tests/audit/seam-host-only-next-step.test.ts` — guards the host-only
  seam against the table's keys.
- `tests/audit/fanout-lanes.test.ts`, `tests/shared/prompt-capability.test.ts`
  (materialize footer), `tests/audit/lane-dispatch-outcomes.test.ts` —
  guards the lane machinery the rows call into.
- Then the full suite (`npm test` / repo equivalent) before commit.

No new test file is warranted: the refactor adds no behavior, and the
byte-identity diff in 5.2 is stronger than a snapshot for a one-time
extraction. If the implementer wants a durable pin against closer drift
(the motivation in 1.2), the cheapest form is asserting in the two existing
row tests that the emitted prompt ends with the continue-command closer —
but that is optional, not required.

### 5.4 Regression signals to watch

- Any test that reads `prompt_path` content for these two steps fails →
  the helper reordered or reworded something; compare against baseline and
  fix the helper, never the test expectation.
- `next-step-helpers.test.ts` table-shape assertions fail → the edit
  escaped the row bodies (it shouldn't); revert to the prompt-array edit
  only.
- Full-suite flake protocol applies (rerun alone before calling it a
  regression; Windows lock errors are suspect flakes, not regressions).

---

## 6. Follow-Up Work (Explicitly Out of Scope Here)

1. **Unify submission-path derivation.** `emitCriticalFlowFallback`,
   `emitSynthesisNarrative`, `emitCharterDelta`, `emitSystemicChallenge`,
   and `emitEdgeReasoning` each derive their interpolated submission path via
   a private `laneSubmissionPath` call while `materializeFanoutLanes` derives
   the same path internally; `prepareContractDispatch` shows the same twin
   derivation for the contract lane. Consuming `fanout.lanes[i].resultPath`
   (or `fanout.artifactPaths`) instead of re-deriving would remove a second
   place the path can drift apart. Separate item with its own byte-identity
   proof — do not fold into this change.
2. **Closer-drift pin.** If closer drift recurs (a row edits its inline
   closer instead of using the helper, or a new row hand-rolls one), add the
   optional closer-suffix assertion from 5.3 to the row tests.
3. **Charter-extraction envelope.** `emitCharterExtraction` keeps its bespoke
   prompt body deliberately; revisit only if a third single-lane row grows
   mid-body paragraphs that suggest a richer envelope builder — not before.
