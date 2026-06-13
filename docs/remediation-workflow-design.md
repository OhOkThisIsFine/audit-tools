# Remediation workflow design

The target design of the remediation pipeline — a declarative contract describing
the system as it is meant to work. It is **not** a status log: completion is
verified separately against the code (audits, invariant tests, the periodic drift
check), and this document is never edited to record what has or hasn't shipped or
to narrate past defects.

Companion to [`audit-workflow-design.md`](audit-workflow-design.md) — the two
share principles (rolling dispatch, provider confirmation, prompt caching,
structured output, roundtrip minimization). Genuinely shared infrastructure lives
in `@audit-tools/shared` and is listed under *Cross-tool alignment* in both.

---

## Pipeline order

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
      → critic → judge → repair        [bounded]
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
user include/exclude) applies to remediation identically and is implemented once,
session-level, in `@audit-tools/shared`. The confirmed provider pool drives
rolling-dispatch routing for both tools; a pool confirmed for an audit run carries
over to a remediation run in the same session.

---

## Intake

**Every entry into a run confirms the starting point with the user** — the run
never proceeds silently:

1. **Auto-discovered input.** When `audit-findings.json` is found via the default
   candidates, it is presented ("found audit output from <date>, N findings —
   use it?") rather than used silently.
2. **Pre-existing run.** Any invocation that finds existing state offers: resume,
   restart from new input, or **merge new recommendations into the existing
   plan** (synthesize additional findings into the current plan rather than
   discarding either).
3. **Pre-existing extracted plan.** The intent gate keys on run progression, not
   on the presence of an intake-summary file; no path reaches planning without a
   confirmed checkpoint.

**Input is validated at manifest-write time.** A supplied path that exists but is
malformed JSON / wrong schema is rejected in the step that collects the starting
point, not deferred to synthesis or extraction.

**Zero documentable findings is a user question, not a dead end.** A plan whose
findings were all filtered out (grounding, dedup, checkpoint filters) presents
"nothing matched your filters/scope — adjust the checkpoint, supply a different
input, or stop?" It never silently closes, and never reports a diagnostic
dead-end.

---

## Synthesis + intent checkpoint — one user-facing stop

The pre-planning sequence is two user interactions: the starting-point
confirmation (above) and a single consolidated checkpoint stop.

**The synthesis worker drafts; the user confirms.** The `synthesize_intake` pass
emits, alongside the intake summary and brief:

- a **preliminary intent checkpoint** pre-populated from the summary's goals,
  constraints, and affected files;
- its **open questions** (blocking and non-blocking) for the same stop.

The host presents one consolidated step: proposed scope + filters, the questions,
and the closing-action choice. The user's answers and confirmation produce the
final `intent_checkpoint.json` in a single roundtrip. Non-blocking open questions
are surfaced as FYI context in this stop, never silently dropped.

**Validation gates:**

- The intake summary is validated — `ready: true` with empty `goals` and no
  `affected_files` is rejected and the synthesis step re-emitted with the
  validation errors (same pattern as contract-pipeline ingestion).
- Clarification answers are validated before `applyClarificationResolution`
  consumes them (non-answers / malformed files re-emit the question step).
- Blocking `open_questions` actually block: `isIntakeReady` gates every path into
  planning (the structured seed and extraction included).

**`free_form_intent` is interpreted, not threaded.** The orchestrator interprets
`free_form_intent` to shape priority signals, block ordering, and scope emphasis
at planning time; it is never pasted verbatim into worker prompts. The
consolidated checkpoint stop shows the user how their intent was interpreted (e.g.
"prioritizing security findings; treating performance findings as best-effort").
Each clause is assessed for encodability independently; a clause that cannot be
encoded as priority/lens/scope signals is promoted to a blocking checkpoint
question and carried as an explicit machine-checkable constraint.

---

## Deterministic transitions are one step

The orchestrator advances through all pending deterministic transitions inside a
single `next-step` call, halting only at a host-delegation or user-gate
obligation. Treating a run of deterministic obligations as one bounded step is
consistent with the one-bounded-step-per-invocation contract: deterministic state
advancement (planning→implementing, all-terminal→closing, triage with no blocked
items, zero-worker fold-throughs, clarification/triage resolution consumption) is
the orchestrator's job, not a host roundtrip that performs no work.

---

## Contract pipeline — universal, multi-agent, seam-negotiating

The contract pipeline is the planning engine for **both** input paths, and its
design phase is a multi-agent seam negotiation rather than a single
self-consistent author.

### Both paths run the pipeline

- **Path A (structured `audit-findings.json`)** seeds `goal_normalization` with
  the findings ("remediate these N findings under this checkpoint") and
  `context_collection` with their affected files and evidence. Every DAG node
  traces to an auditor finding *and* a derived obligation.
- **Path B (document/conversation)** runs the pipeline from the remediation
  brief.
- Both converge at the implementation DAG.

Rationale: a fast path that implements findings "because the auditor said so",
with no obligations, no seam contracts, and no traceability, cannot support
confident parallel implementation. Routing both paths through the pipeline closes
that gap.

### Multi-agent seam negotiation

A single design agent controls both sides of every interface and never surfaces
the conflicts between them. The design phase is:

1. **Decomposition** — one agent, one pass: GoalSpec + ContextBundle → module
   list with rough responsibilities and file scope. No seam contracts yet.
2. **Per-module contract drafting** — **parallel**, one agent per module. Each
   reads the GoalSpec, its module description, and its actual repo files, and
   drafts its full `ModuleContract`: inputs, outputs, invariants, side effects,
   validation boundary, failure modes — and, critically, what it *needs from each
   neighbor* (the seam from its side).
3. **Seam reconciliation** — deterministic detection of every mismatch (module
   A's declared output ≠ module B's declared input), then LLM resolution per
   mismatch (which side adjusts, what the agreed interface becomes). Resolutions
   may be adversarially checked (propose → attack → accept) before adoption.
4. **Contract finalization** — parallel: each module agent receives the
   reconciliation report and finalizes its contract.
5. **Obligation ledger** — a first-class phase in `CONTRACT_PIPELINE_PHASE_ORDER`,
   derived largely deterministically from finalized contracts: each invariant →
   verification obligation, each seam interface → test obligation.
6. **Test/validator plan** — a distinct phase converting ledger obligations into
   concrete test specs, validators, and schemas *before any code is written*. A
   worker may flag a planned test as inapplicable only against the ledger, never
   on rationale alone.
7. **Deterministic design gates** — mechanical checks before adversarial review:
   - every module has inputs/outputs
   - every side effect has an owner
   - every invariant has a verification obligation
   - every implementation task traces to a requirement/invariant
   - every external dependency has failure semantics
   - no raw/untrusted data crosses a trust boundary unvalidated
   - **no circular interface-definition obligations** (two nodes each needing to
     define an interface the other depends on — caught before implementation)
8. **Critic → judge → repair** — bounded, archived, hash-tracked; attacks the
   negotiated contracts. When the judge omits `repair_directive`, the target is
   inferred from the failing classifications rather than defaulting to a fixed
   artifact.

Parallel-friendly phases (2, 4; plus critique alongside assessment where inputs
allow) dispatch as parallel agents in one step, not sequential next-step
roundtrips. Prompt-caching principle applies: shared prefix (GoalSpec +
ContextBundle) first, module-specific payload last.

### Metadata-enriched DAG promotion

DAG promotion carries real metadata, never placeholder values — downstream risk
classification, dispatch allowlists, and `checkAffectedFileIntegrity` all depend
on it:

- `affected_files` ← the node's `filesLikelyTouched`, sourced from the finalized
  module contract's file scope, flowing through the whole chain (contract → DAG
  node → finding → dispatch access).
- `lens` / `severity` ← derived from obligation kinds and contract content (an
  `invariant` obligation on a trust boundary is a higher tier than a structural
  cleanup); Path A nodes inherit their source finding's lens/severity.
- DAG nodes carry `preconditions` (upstream contracts' declared outputs),
  `expectedChanges`, and `verification` obligations from the ledger.
- **Write-scope vs read-scope are distinct.** `affected_files` is write-scope
  (declared outputs); read-scope is neighbor-contract + integration files.
  Create-new-file / greenfield nodes always receive a non-empty read context so
  the Read allowlist is never degenerate.

### One worker type — implementers

With contracts, obligations, file scope, and test specs established upstream,
there is no separate document phase: document is a thin deterministic translation
(DAG node + contracts → dispatch prompt), and the only worker type is
implementers executing DAG nodes. Dispatch is a single rolling loop (below) with
no document/implement two-phase state machine and no separate document
dispatch/merge commands.

---

## Risk classification & implementation preview

The gate is deterministic classify → LLM review → user preview/ack, structured
for few roundtrips and well-informed review:

- **Classification folds into the pipeline tail.** Deterministic preliminary
  classification runs as nodes complete planning; the LLM review dispatches in
  parallel with the final planning work rather than serially after it.
- **Scoped file access for the reviewer.** The LLM reviewer is metadata-only for
  `safe` and `substantive` findings, and is granted the relevant source files for
  `context_dependent` findings only — the cases where project context determines
  appropriateness.
- **Ack invalidation.** `impl_preview_acknowledged.json` carries the plan id /
  content hash it acknowledged; a force-replan or plan mutation invalidates it so
  a stale ignore-list never applies to a different plan's finding ids.
- **Preview stability.** The preview shows each node's contract obligations, which
  are stable across upstream implementation, rather than file-state assumptions,
  which are not.

---

## Dispatch — rolling, worktree-isolated, contract-verified

Adopts the audit design's rolling model (no pre-computed wave size; quota is the
only throttle; per-packet provider selection from the confirmed pool; ingestion
folded into the same logical turn) with remediation-specific additions.

**Rolling loop.** A DAG node is dispatchable when its `depends_on` nodes are
*verified-complete* (not merely merged). As each result lands: verify, merge,
update quota estimates, re-check newly-unblocked nodes, dispatch into freed
capacity. One clarification or failure affects only its own node.

**Worktree isolation.** Workers execute in per-node git worktrees, handed
worktree-rooted paths. A failed or crashed worker's tree is discarded; the main
tree is never dirtied by partial edits. Parallel nodes **may overlap in files** —
the seam is the typed contract, not file disjointness; real conflicts surface as
explicit merge conflicts and are handled openly rather than prevented by a
disjointness heuristic.

**Per-node verification before merge.** Targeted tests run in the worktree;
contract assertions check that declared outputs match actual outputs. A node that
fails verification never touches the main tree and re-enters triage with the
specific assertion/test failure as context.

**Post-merge re-verification (multi-node attribution).** After merging any node —
especially one overlapping an already-merged sibling — the MERGED surface's
targeted tests + contract assertions re-run before any dependent dispatches. On
failure, the cause is attributed to the owning module contract AND the set of
merged nodes that touched the implicated surface (bisect when ambiguous), and only
that implicated subset rolls back. "Never dirties main" is evaluated against the
realized merged tree, not merely node-against-base. Merge of node N triggers
precondition checks for N's dependents: a merged surface that doesn't match N's
declared contract is a triage signal raised *before* any dependent dispatches.
Dependent prompts are rendered at dispatch time (post-merge), never pre-rendered
against a future tree state.

**Ownership-gated `affected_files` amendment.** A worker discovering a necessary
edit outside its declared contract scope may extend write-scope only into unowned
files (in no other node's contract scope and not edited by a live parallel
sibling); an owned/contended file routes back through the deterministic seam
detect+resolve protocol. Amendment-claim registration is atomic so two siblings
cannot both claim the same unowned file. Verification and close blast-radius
attribution re-scope to the amended set.

**Cyclic-seam resolution.** When the no-circular-interface gate detects a genuine
mutual interface dependency, resolution routes to a sanctioned cycle-break: a
mediating module/type (re-checked so it cannot re-introduce a cycle), or a single
authority owning the co-defined primitive's interface (an explicit, recorded,
primitive-scoped exception). The re-decomposition loop is bounded; on exhaustion
it routes to a user decision then close — a defined terminal, never an open spin.

**Infra-modifying node verification.** Nodes editing the dispatch/merge/
orchestration engine the run itself executes are verified against the LIVE
execution surface (rebuild + exercise the new engine, not only the stale global
bin or an isolated worktree), with a defined rollback if a republished change
breaks the dispatcher; sequenced atomic-replace to stay runnable at every commit.

**Token estimation** uses the shared `estimateTokensFromBytes`: node estimates
from contract scope file sizes + spec length + pulled-in test files.

**Convention scan** is cached once per run. `collectReferencingTests` uses
deliberately-loose basename matching (false positives are harmless extra write
grants) scoped to the node's package.

---

## Triage — context-carrying, precisely-scoped

- **Explicit action always wins.** An explicit `action` is authoritative;
  `rationaleAsksForRetry` breaks ties only when `action` is absent. Settled user
  decisions are never reinterpreted later (close does not re-open `ignored`
  items).
- **Retries carry failure context.** A retried node's new prompt includes what
  failed last time (the contract assertion, the test output tail, the precondition
  violation) — never an identical re-dispatch. Per-node verification makes this
  context specific rather than an opaque "worker reported blocked".
- **`halt` routes through close.** Halt sets `closing` so a partial report is
  produced for work already done; the report marks the run user-halted.
- **Retry budget by failure class.** Environment/infra failures (worktree setup,
  provider quota, tool crash) retry cheaply on a separate budget; contract/test
  failures use the `MAX_AUTO_RETRIES`-capped path.
- **Report the resolution outcome.** After consuming a triage resolution, the next
  step's prompt summarizes what was retried/ignored/unblocked.

---

## Close — evidence-backed, recoverable, user-previewed

- **Closing action preview.** Before `commit`/`push`/`open-pr`/`publish` executes,
  the file list and a generated (not hardcoded) commit message are presented for
  confirmation — unless the user pre-authorized unattended closing at the intent
  checkpoint.
- **E2E failure transitions, never throws.** An e2e failure records output,
  re-blocks the implicated items, and transitions to triage — like the
  combined-suite failure path.
- **Selective re-block on combined failure.** A combined-suite failure is a
  cross-node interaction (every node already passed its targeted tests): it is
  attributed (failing test → owning module contract → nodes that touched it;
  bisect when ambiguous) and only the implicated nodes re-block, carrying the
  failing output as triage context.
- **Verification report carries real evidence.** Obligation traces record the
  actual per-node evidence: "obligation O-003: `npm test src/auth.test.ts` passed
  in worktree at <hash>; assertion 'invoice idempotency under retry' green." The
  report answers which requirements are satisfied, which invariants enforced,
  which tests prove them, which counterexamples repaired, which risks remain.
- **User-ignored items don't fail the run.** Intentional `ignored` /
  `inappropriate` choices are excluded from `overall_status` and reported in their
  own section.
- **Artifacts survive until explicit cleanup.** The artifacts directory (dispatch
  plans, specs, intermediate results) is preserved for diagnosing a failed closing
  action or e2e run; cleanup is offered when the report is presented and runs
  automatically only after a fully-green close.

---

## Cross-tool alignment (shared with the auditor)

- **Rolling dispatch engine lives in `@audit-tools/shared`.** Both tools use the
  same loop (quota tracking, per-packet provider selection, capacity re-check on
  result arrival) with different packet types. It exposes a consumer-neutral
  terminal: when the confirmed pool empties mid-run and the livelock guard trips,
  remediation routes the stranded subtree through close with a partial report
  (audit synthesizes on partial coverage). An explicit `waiting_for_provider`
  paused state is resumable; re-discovery surfaces only genuinely-new providers
  and never re-offers a Gate-0 settled exclusion.
- **Provider confirmation is session-level and shared** (Gate 0). One confirmation
  covers an audit→remediate pipeline run.
- **`free_form_intent` interpretation parity.** Interpret-don't-thread is the rule
  in both tools; the interpretation logic (intent → priority/lens weighting) is a
  shared concern.
- **Prompt-caching principle** (shared context first, agent-specific payload last)
  applies to seam-negotiation agents, audit design-review agents, and auditor
  workers identically.
- **Token estimation** uses the shared byte-based `estimateTokensFromBytes`.
- **Audit findings as contract-pipeline seed (Path A).** The auditor's findings
  contract stays rich enough to seed goal normalization: stable IDs, affected
  files with line evidence, lens/severity, theme links.
- **Pinned shared seam contracts.** The three shared APIs (rolling dispatch
  engine, Gate-0 provider confirmation, `free_form_intent` interpreter) are
  pinned/versioned and validated through one real consumer end-to-end before full
  fan-out.

---

## Unchanged from the prior architecture

- State persistence model (file-backed, pessimistic locking) and the
  one-bounded-step-per-invocation contract.
- Critic → judge → repair loop structure, caps, and artifact archival.
- Traceability invariant: no implementation node without an obligation or accepted
  counterexample.
- Cross-lens dedup, grounding of extracted findings, coverage ledger.
- Intent checkpoint filter semantics (severity/lens/package/theme,
  `excluded_scope`, `must_not_touch`).
- Outcomes contract (`remediation-outcomes.json`) and report rendering.
- Agent reflections (Process Feedback) flow.
