# Remediation workflow design decisions

Agreed decisions from a full walkthrough of the remediation pipeline (2026-06-10).
These are forward-looking design targets, not current state.
Implement against this document; remove entries as they ship.

Companion to [`audit-workflow-design.md`](audit-workflow-design.md) — the two
documents share principles (rolling dispatch, provider confirmation, prompt
caching, structured output, roundtrip minimization) and where infrastructure is
genuinely shared it belongs in `@audit-tools/shared`. Cross-tool items are
listed at the end of both documents.

---

## Pipeline order (target)

```
provider_confirmation        [user gate — shared with audit; session-level]
  → intake + validation      [deterministic; validates input at manifest time]
  → synthesize + draft       [one background LLM pass: intake summary +
                              preliminary intent checkpoint + open questions]
  → intent_checkpoint        [user gate — single consolidated stop: confirm
                              scope, answer questions, set closing action]
  → contract_pipeline        [BOTH paths; multi-agent seam negotiation]
      decomposition
      → per-module contract drafting   [parallel]
      → seam reconciliation            [deterministic detect + LLM resolve]
      → contract finalization          [parallel]
      → obligation ledger              [largely deterministic]
      → test/validator plan
      → deterministic design gates
      → critic → judge → repair        [bounded, existing]
      → implementation DAG             [metadata-enriched promotion]
  → risk_preview             [user gate — classification folded in]
  → rolling_dispatch         [quota-routed, worktree-isolated, per-node
                              verification, ingestion folded in]
  → triage                   [context-carrying retries]
  → close                    [evidence-backed verification report]
```

---

## Gate 0 — Provider confirmation (shared with audit)

The audit design's Gate 1 (provider discovery, capability tiers, quota state,
user include/exclude) applies to remediation identically and should be
implemented once, session-level, in `@audit-tools/shared`. The confirmed
provider pool drives rolling-dispatch routing for both tools. A pool confirmed
for an audit run carries over to a remediation run in the same session.

---

## Intake

**Always confirm the starting point with the user.** Today the run silently
proceeds in three cases that must all become explicit user choices:

1. **Auto-discovered input.** When `audit-findings.json` is found via default
   candidates, present it ("found audit output from <date>, N findings — use
   it?") instead of proceeding silently.
2. **Pre-existing run in progress.** Currently the resume-vs-restart choice
   surfaces only when `--input` is passed (`handleInputConflict`); a bare
   re-invocation silently resumes. Any invocation that finds existing state
   must offer: resume, restart from new input, or **merge new recommendations
   into the existing plan** (a new option — synthesize additional findings into
   the current plan rather than discarding either).
3. **Pre-existing extracted plan.** The `extracted-plan.json` fast path in
   `decideNextStepInner` (nextStep.ts ~1817) builds and saves a plan without an
   intake summary, so the `confirm_intent` gate (which keys on
   `intake/intake-summary.json`, ~1763) never fires. The intent gate must key on
   run progression, not on the summary file's existence — no path may reach
   planning without a confirmed checkpoint.

**Validate input at manifest-write time.** A supplied path that exists but is
malformed JSON / wrong schema currently defers failure to synthesis or
extraction. Validate when the source manifest is built and surface problems in
the same step that collects the starting point.

**Zero-findings planning state is a user question, not a dead end.** A plan
whose findings were all filtered out (grounding, dedup, checkpoint filters)
currently falls through every dispatch condition to `handleUnhandledState`
(`allItemsTerminal` requires `items.length > 0`, so an empty item map matches
nothing). Add an early check: `planning` with zero documentable findings →
present "nothing matched your filters/scope — adjust the checkpoint, supply a
different input, or stop?" — never silently close, never report a diagnostic
dead-end.

---

## Synthesis + intent checkpoint — one user-facing stop

Today the pre-planning sequence costs up to four separate user interactions
(collect starting point → synthesize [background] → confirm intent →
clarifications). Collapse to **two**: the starting-point confirmation (above)
and a single consolidated checkpoint stop.

**The synthesis worker drafts; the user confirms.** The `synthesize_intake`
pass must emit, alongside the intake summary and brief:

- a **preliminary intent checkpoint** pre-populated from the summary's goals,
  constraints, and affected files (today `buildConfirmIntentStep` shows a bare
  schema and the host re-derives everything from scratch);
- its **open questions** (blocking and non-blocking) for the same stop.

The host then presents one consolidated step: proposed scope + filters, the
questions, and the closing-action choice. The user's answers and confirmation
produce the final `intent_checkpoint.json` in a single roundtrip. Non-blocking
open questions are surfaced as FYI context in this stop rather than silently
dropped.

**Validation gates:**

- The intake summary itself is validated — `ready: true` with empty `goals`
  and no `affected_files` is rejected and the synthesis step re-emitted with
  the validation errors (same pattern as contract-pipeline ingestion).
- Clarification answers are validated before `applyClarificationResolution`
  consumes them (non-answers / malformed files re-emit the question step).
- Verify blocking `open_questions` actually block: `isIntakeReady` gates the
  structured fast path and extraction, and that gating must hold for every
  path into planning.

**`free_form_intent` is interpreted, not threaded.** Align with the audit
design: the orchestrator interprets `free_form_intent` to shape priority
signals, block ordering, and scope emphasis at planning time. It is not pasted
verbatim into worker prompts (today it is threaded raw into remediation worker
prompts). The consolidated checkpoint stop should show the user how their
intent was interpreted (e.g. "prioritizing security findings; treating
performance findings as best-effort").

---

## Batched deterministic transitions

Mirror of the audit design's batch-deterministic block. The orchestrator
advances through **all** pending deterministic transitions inside a single
`next-step` call, halting only at a host-delegation or user-gate obligation.
The `state_transition` step kind ("the state changed — re-run next-step")
disappears: planning→documenting folds, all-terminal→closing, triage with no
blocked items, zero-worker dispatch fold-throughs, and clarification/triage
resolution consumption all currently burn a full host roundtrip to perform no
work. Deterministic state advancement is the orchestrator's job, not the
host's.

---

## Contract pipeline — universal, multi-agent, seam-negotiating

This is the largest change. The contract pipeline stops being a Path-B-only
preamble and becomes the planning engine for **both** input paths, and its
design phase is restructured from a single self-consistent author into a
multi-agent seam negotiation.

### Both paths run the pipeline

- **Path A (structured `audit-findings.json`)** seeds `goal_normalization`
  with the findings ("remediate these N findings under this checkpoint") and
  `context_collection` with their affected files and evidence. Every DAG node
  traces to an auditor finding *and* a derived obligation. The current direct
  `runPlanPhase` fast path (intakeResolver.ts ~260) is removed.
- **Path B (document/conversation)** continues to run the pipeline from the
  remediation brief, as today.
- Both converge at the implementation DAG. The legacy `extract_findings` step,
  already unreachable (the contract pipeline intercepts every non-structured
  ready intake), is deleted.

The audit-derived rationale: the fast path produces findings that get
implemented "because the auditor said so," with no obligations, no seam
contracts, and no traceability. Closing that gap is what makes confident
parallel implementation possible.

### Multi-agent seam negotiation replaces the single design pass

A single design agent controls both sides of every interface and therefore
never surfaces the conflicts between them. Replace the monolithic `design`
phase with:

1. **Decomposition** — one agent, one pass: GoalSpec + ContextBundle → module
   list with rough responsibilities and file scope. No seam contracts yet.
2. **Per-module contract drafting** — **parallel**, one agent per module (this
   is where the old document worker's depth-of-focus lives now). Each agent
   reads the GoalSpec, its module description, and its actual repo files, and
   drafts its full `ModuleContract`: inputs, outputs, invariants, side
   effects, validation boundary, failure modes — and, critically, what it
   *needs from each neighbor* (the seam from its side).
3. **Seam reconciliation** — deterministic detection of every mismatch
   (module A's declared output ≠ module B's declared input), then LLM
   resolution per mismatch (which side adjusts, what the agreed interface
   becomes). Resolutions may be adversarially checked (propose → attack →
   accept) before adoption.
4. **Contract finalization** — parallel: each module agent receives the
   reconciliation report and finalizes its contract.
5. **Obligation ledger** — derived largely deterministically from finalized
   contracts: each invariant → verification obligation, each seam interface →
   test obligation. Promote `obligation_ledger` to a first-class phase in
   `CONTRACT_PIPELINE_PHASE_ORDER` (today it is a special-cased precondition
   of `assessment`, contractPipeline.ts ~259).
6. **Test/validator plan** — a distinct phase converting ledger obligations
   into concrete test specs, validators, and schemas *before any code is
   written*. Today `tests_to_write` is invented by document workers at
   dispatch time — LLM judgment where a planned obligation should be. A
   worker may still flag a planned test as inapplicable, but that claim is
   validated against the ledger rather than accepted on rationale alone.
7. **Deterministic design gates** — mechanical checks before adversarial
   review (currently absent; validators only check JSON shape):
   - every module has inputs/outputs
   - every side effect has an owner
   - every invariant has a verification obligation
   - every implementation task traces to a requirement/invariant
   - every external dependency has failure semantics
   - no raw/untrusted data crosses a trust boundary unvalidated
   - **no circular interface-definition obligations** (two nodes each needing
     to define an interface the other depends on — the one seam case that
     must be caught before implementation)
8. **Critic → judge → repair** — unchanged in structure (bounded, archived,
   hash-tracked), now attacking negotiated contracts rather than one agent's
   story. Fix the repair-directive fallback: when the judge omits
   `repair_directive`, infer the target from the failing classifications
   instead of unconditionally defaulting to `design_spec`
   (contractPipeline.ts ~309).

Parallel-friendly phases (2, 4; plus critique alongside assessment where
inputs allow) should be dispatched as parallel agents in one step, not as
sequential next-step roundtrips. Prompt-caching principle applies: shared
prefix (GoalSpec + ContextBundle) first, module-specific payload last.

### Metadata-enriched DAG promotion

`promoteImplementationDagToExtractedPlan` currently hardcodes
`lens: "correctness"`, `severity: "medium"`, `affected_files: []` for every
node (contractPipeline.ts ~668-674). This starves everything downstream: risk
classification starts blind, document/implement prompts render empty
Files/Read allowlists (a logged backlog friction), and
`checkAffectedFileIntegrity` is a silent no-op. Instead:

- `affected_files` ← the node's `filesLikelyTouched`, which itself comes from
  the finalized module contract's file scope. This field must flow through
  the entire chain (contract → DAG node → finding → dispatch access).
- `lens` / `severity` ← derived from obligation kinds and contract content
  (an `invariant` obligation on a trust boundary is not the same tier as a
  structural cleanup); Path A nodes inherit their source finding's
  lens/severity.
- DAG nodes carry `preconditions` (upstream contracts' declared outputs),
  `expectedChanges`, and `verification` obligations from the ledger.

### The document phase dissolves

With contracts, obligations, file scope, and test specs established upstream,
the per-finding document worker has nothing left to invent. Document becomes a
thin deterministic translation (DAG node + contracts → dispatch prompt). One
worker type remains: implementers executing DAG nodes. The
document/implement two-phase state machine, its separate dispatch/merge
commands, and the documented→implementable handoff collapse into the rolling
dispatch loop below.

Until the dissolution ships, two interim fixes to the existing document phase
(both logged backlog friction): render files named in the finding summary into
the Files field and Read allowlist when `affected_files` is empty, and stop a
single clarification request from freezing all other findings (per-result
ingestion handles this naturally under rolling dispatch; under waves, carve
the clarified finding out instead of flipping global state to
`waiting_for_clarification`).

---

## Risk classification & implementation preview

Keep the gate (deterministic classify → LLM review → user preview/ack) but
restructure for fewer roundtrips and better-informed review:

- **Fold classification into the pipeline tail.** The deterministic
  preliminary classification runs as nodes complete planning, not as a
  separate post-documentation step; the LLM review dispatches in parallel
  with the final planning work rather than serially after it.
- **Scoped file access for the reviewer.** The LLM reviewer stays
  metadata-only for `safe` and `substantive` findings (token burn is the
  reason it reads no source today), but is granted the relevant source files
  for `context_dependent` findings only — those are exactly the cases where
  project context determines appropriateness.
- **Ack invalidation.** `impl_preview_acknowledged.json` carries the plan id
  / content hash it acknowledged; a force-replan or plan mutation invalidates
  it so stale ignore-lists can never apply to a different plan's finding ids.
- **Drop the redundant "Ignore Choices" list** from the preview prompt — the
  tiered tables already carry every finding.
- **Wave-staleness in the preview** (user approves later-dependency work whose
  context will have changed) is addressed structurally by seam contracts: the
  preview shows each node's contract obligations, which are stable across
  upstream implementation, rather than file-state assumptions, which are not.

---

## Dispatch — rolling, worktree-isolated, contract-verified

Adopts the audit design's rolling model (wave_size removed; quota the only
throttle; per-packet provider selection from the confirmed pool; ingestion
folded into the same logical turn) with remediation-specific additions:

**Rolling loop.** A DAG node is dispatchable when its `depends_on` nodes are
*verified-complete* (not merely merged). As each result lands: verify, merge,
update quota estimates, re-check newly-unblocked nodes, dispatch into freed
capacity. One clarification or failure affects only its own node.

**Worktree isolation returns.** Workers execute in per-node git worktrees.
The prior abandonment was a prompt/path bug (workers were handed
repo-root-relative paths and edited the main tree), not an architectural
failure; prompts must render worktree-rooted paths. Consequences:

- A failed or crashed worker's tree is discarded; the main tree is never
  dirtied by partial edits.
- The `claimedWritePaths` wave-time disjointness heuristic and silent
  block-deferral disappear. Parallel nodes **may overlap in files** — the seam
  is the typed contract, not file disjointness. Real conflicts surface as
  explicit merge conflicts and are handled openly instead of prevented
  heuristically.
- **Per-node verification before merge** (the missing per-step check from the
  original contract-pipeline spec): targeted tests run in the worktree;
  contract assertions check that declared outputs match actual outputs; a
  node that fails verification never touches the main tree and re-enters
  triage with the specific assertion/test failure as context.
- Merge of node N triggers precondition checks for N's dependents: if the
  merged surface doesn't match N's declared contract, that is a triage signal
  raised *before* any dependent dispatches — replacing the "sibling-task
  drift" backlog friction (stale prompts reconciled by hand) with a
  contract-checked seam. Dependent prompts are rendered at dispatch time
  (post-merge), never pre-rendered against a future tree state.

**Token estimation parity with the auditor.** Replace the flat
`ESTIMATED_FINDING_OVERHEAD_TOKENS` / `ESTIMATED_BLOCK_BASE_TOKENS` constants
with byte-based estimates via the shared `estimateTokensFromBytes`: node
estimates from contract scope file sizes + spec length + pulled-in test files.

**Misc.** Cache the `detectRepoConventions` scan once per run (it currently
re-runs per dispatch call). Keep the deliberately-loose basename matching in
`collectReferencingTests` (false positives are harmless extra write grants)
but scope it to the node's package to avoid pulling unrelated modules' tests.

---

## Triage — context-carrying, precisely-scoped

- **Explicit action always wins.** `rationaleAsksForRetry` may break ties only
  when `action` is absent; today an explicit `action: "ignore"` whose
  rationale happens to contain retry-words is retried anyway (triage.ts ~121).
  The same scan also silently re-opens `ignored` items during close
  (`reblockRetryableIgnoredItems`) — remove that path entirely; close must not
  reinterpret settled user decisions.
- **Retries carry failure context.** A retried node's new prompt includes what
  failed last time (the contract assertion, the test output tail, the
  precondition violation) — never an identical re-dispatch of the prompt that
  just failed. Per-node verification (above) is what makes this context
  specific instead of an opaque "worker reported blocked".
- **`halt` routes through close.** Today halt jumps straight to `complete`
  (triage.ts ~117), skipping the close phase — no tests, no report for the
  work already done. Halt must set `closing` so a partial report is produced;
  the report marks the run user-halted.
- **Retry budget by failure class.** Distinguish environment/infra failures
  (worktree setup, provider quota, tool crash — retry cheaply, separate
  budget) from contract/test failures (the `MAX_AUTO_RETRIES`-capped path).
- **Report the resolution outcome.** After consuming a triage resolution,
  the next step's prompt summarizes what was retried/ignored/unblocked rather
  than emitting a bare re-run-next-step transition.

---

## Close — evidence-backed, recoverable, user-previewed

- **Closing action preview.** Before `commit`/`push`/`open-pr`/`publish`
  executes, present the file list and a generated (not hardcoded
  `"Auto-remediation complete"`) commit message for confirmation — unless the
  user pre-authorized unattended closing at the intent checkpoint.
- **E2E failure transitions, never throws.** Today an e2e failure throws from
  `runE2eTests` (close.ts ~559) — no state transition, no report, state stuck
  in `closing`. Route it like the combined-suite failure: record output,
  re-block, transition to triage.
- **Selective re-block on combined failure.** Re-blocking *every* resolved
  item on a combined-suite failure (close.ts ~516) destroys signal. With
  per-node verification, every node already passed its targeted tests, so a
  combined failure is a cross-node interaction: attribute it (failing test →
  owning module contract → nodes that touched it; bisect when ambiguous) and
  re-block only the implicated nodes, carrying the failing output as triage
  context.
- **Verification report carries real evidence.** Obligation traces currently
  record bare ID strings with pass/fail inherited from the combined suite.
  Per-node verification supplies the actual evidence: "obligation O-003:
  `npm test src/auth.test.ts` passed in worktree at <hash>; assertion
  'invoice idempotency under retry' green." The report answers the original
  spec's questions: which requirements satisfied, which invariants enforced,
  which tests prove them, which counterexamples repaired, which risks remain.
- **User-ignored items don't fail the run.** `overall_status` currently
  fails when any item is non-resolved, including deliberate `ignored` /
  `inappropriate` choices (close.ts ~865, ~965). Intentional skips are
  excluded from the overall verdict and reported in their own section.
- **Artifacts survive until explicit cleanup.** Close currently deletes the
  artifacts directory unconditionally (close.ts ~1150), destroying dispatch
  plans, specs, and intermediate results needed to diagnose a failed closing
  action or e2e run. Keep the artifacts directory (or move it to a
  timestamped archive) and offer cleanup as part of presenting the report;
  delete automatically only after a fully-green close.

---

## Verified current-code defects

Fix these regardless of redesign sequencing (all verified against source
2026-06-10):

| Defect | Location |
|---|---|
| `extracted-plan.json` fast path bypasses `confirm_intent` (gate keys on intake summary existence) | nextStep.ts ~1763 vs ~1817 |
| `planning` + zero documentable findings falls to `handleUnhandledState` (`allItemsTerminal` requires non-empty items) | nextStep.ts ~1860, ~220 |
| Silent resume of existing run when no `--input` passed | nextStep.ts (conflict only via `handleInputConflict`) |
| No validation of input at manifest-write time | intakeResolver.ts |
| No validation gate on intake summary content | intakeResolver.ts ~203 |
| DAG promotion hardcodes lens/severity/empty affected_files | contractPipeline.ts ~668 |
| `obligation_ledger` special-cased rather than first-class phase | contractPipeline.ts ~259 |
| Judge repair fallback unconditionally targets `design_spec` | contractPipeline.ts ~309 |
| Dead `extract_findings` step (contract pipeline always intercepts) | nextStep.ts ~1342 |
| One clarification request blocks all findings (`waiting_for_clarification` is global) | dispatch.ts ~1020 |
| Document worker read access = `affected_files` only (empty for CP findings) | dispatch.ts ~344 |
| Flat token estimates instead of shared byte-based estimation | dispatch.ts ~774, ~1192 |
| `rationaleAsksForRetry` overrides explicit `ignore` action | triage.ts ~121 |
| `halt` skips close phase (state jumps to `complete`) | triage.ts ~117 |
| Identical prompt re-dispatched on retry (no failure context) | triage.ts ~37 |
| `reblockRetryableIgnoredItems` reinterprets settled ignores at close | close.ts ~980 |
| E2E failure throws instead of transitioning | close.ts ~559 |
| Combined-suite failure re-blocks every resolved item | close.ts ~516 |
| Ignored/inappropriate items fail `overall_status` | close.ts ~865 |
| Hardcoded commit message; no pre-commit preview | close.ts ~448 |
| Artifacts dir deleted before closing-action failure can be diagnosed | close.ts ~1150 |
| Preview ack has no plan-identity binding (stale ack honored after replan) | nextStep.ts ~1019 |
| `impl_preview_acknowledged` "Ignore Choices" duplicates the tables | nextStep.ts ~954 |

---

## Cross-tool alignment (changes that touch the auditor / shared)

- **Rolling dispatch engine lives in `@audit-tools/shared`.** Both tools need
  the same loop (quota tracking, per-packet provider selection, capacity
  re-check on result arrival). Build once; the audit design's dispatch section
  and this document's dispatch section are the same engine with different
  packet types.
- **Provider confirmation is session-level and shared** (see Gate 0). One
  confirmation covers an audit→remediate pipeline run.
- **`free_form_intent` interpretation parity.** The audit design already
  specifies interpret-don't-thread; remediation aligns (this doc). The
  interpretation logic (intent → priority/lens weighting) is a shared concern.
- **Prompt-caching principle** (shared context first, agent-specific payload
  last) applies to seam-negotiation agents exactly as to audit design-review
  agents and auditor workers.
- **Token estimation**: remediation adopts the auditor's byte-based
  `estimateTokensFromBytes`; any improvements land in shared.
- **Audit findings as contract-pipeline seed (Path A)** implies the auditor's
  findings contract stays rich enough to seed goal normalization: stable IDs,
  affected files with line evidence, lens/severity, theme links — all already
  present; preserve them through any audit-side refactor.

## Hardening decisions (adversarial review, 2026-06-10)

Surfaced while planning the implementation of this redesign through independent
critic→judge rounds (13 accepted gaps across three rounds). Each becomes its own
implementation node with its own test spec — never a buried clause inside a
larger block.

- **Post-merge re-verification gate (multi-node attribution).** After merging
  any node — especially one overlapping an already-merged sibling — re-run the
  MERGED surface's targeted tests + contract assertions before any dependent
  dispatches. On failure, attribute to the owning module contract AND the set of
  merged nodes that touched the implicated surface (bisect when ambiguous,
  mirroring close's selective re-block) and roll back ONLY that implicated
  subset, not just the last-merged node. "Never dirties main" is evaluated
  against the realized merged tree, not merely node-against-base.
- **Ownership-gated `affected_files` amendment.** A worker discovering a
  necessary edit outside its declared contract scope may unilaterally extend
  write-scope only into unowned files (in no other node's contract scope and not
  edited by a live parallel sibling); an owned/contended file routes back through
  the deterministic seam detect+resolve protocol (re-scope or serialize).
  Verification and close blast-radius attribution re-scope to the amended set.
  (Amendment-claim registration must be atomic so two siblings cannot both claim
  the same currently-unowned file.)
- **Cyclic-seam resolution.** When the no-circular-interface gate detects a
  genuine mutual interface dependency, route to a sanctioned cycle-break: a third
  mediating module/type (re-checked so it cannot re-introduce a cycle) OR a
  single authority owning the co-defined primitive's interface (an explicit,
  recorded, primitive-scoped exception to the no-single-owner rule). Bounded
  re-decomposition loop; on exhaustion, route to a user decision then close — a
  defined terminal, never an open spin.
- **Write-scope vs read-scope in DAG promotion.** `affected_files` (write-scope /
  declared outputs) is distinct from read-scope (neighbor-contract + integration
  files). Create-new-file / greenfield nodes always receive a non-empty read
  context so the Read allowlist is never degenerate — closing the empty-allowlist
  friction at its structural root.
- **Infra-modifying node verification.** Nodes editing the dispatch/merge/
  orchestration engine the run itself executes are verified against the LIVE
  execution surface (rebuild + exercise the new engine, not only the stale global
  bin or an isolated worktree), with a defined rollback if a republished change
  breaks the dispatcher; sequenced atomic-replace to stay runnable at every
  commit.
- **Shared with the audit redesign** (see its Hardening section): the
  consumer-neutral dispatch terminal (remediation's stranded subtree routes
  through close with a partial report), the `waiting_for_provider` paused state,
  the per-clause `free_form_intent` escape hatch, and the pinned shared APIs +
  shared↔consumer integration checkpoint.

---

## Unchanged

- State persistence model (file-backed, pessimistic locking) and the
  one-bounded-step-per-invocation contract
- Critic → judge → repair loop structure, caps, and artifact archival
- Traceability invariant: no implementation node without an obligation or
  accepted counterexample
- Cross-lens dedup, grounding of extracted findings, coverage ledger
- Intent checkpoint filter semantics (severity/lens/package/theme,
  excluded_scope, must_not_touch)
- Outcomes contract (`remediation-outcomes.json`) and report rendering
- Agent reflections (Process Feedback) flow
