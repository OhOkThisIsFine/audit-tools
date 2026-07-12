# Remediation workflow design

The target design of the remediation pipeline — a declarative contract describing
the system as it is meant to work. It is **not** a status log: completion is
verified separately against the code (audits, invariant tests, the periodic drift
check), and this document is never edited to record what has or hasn't shipped or
to narrate past defects.

Companion to [`audit-workflow-design.md`](audit-workflow-design.md) — the two
share principles (rolling dispatch, provider confirmation, prompt caching,
structured output, roundtrip minimization). Genuinely shared infrastructure lives
in `audit-tools/shared` and is listed under *Cross-tool alignment* in both.

---

## Pipeline order

```
provider_confirmation        [user gate — shared with audit; session-level]
  → intake + validation      [deterministic; validates input at manifest time]
  → synthesize + draft       [one background LLM pass: intake summary +
                              preliminary intent checkpoint + open questions]
  → intent_checkpoint        [user gate — single consolidated stop: confirm
                              scope, answer questions, set closing action]
  → review_gate              [user gate — Path A: original findings, pre-pipeline;
                              tiered by review-necessity, approve/disapprove]
  → contract_pipeline        [BOTH paths; multi-agent seam negotiation;
                              Path B review_gate fires at the planning point within]
      decomposition
      → per-module contract drafting   [parallel]
      → seam reconciliation            [deterministic detect + LLM resolve]
      → contract finalization          [parallel]
      → critique                       [conceptual design critique]
      → obligation ledger              [largely deterministic]
      → cyclic seam resolution         [breaks circular interface-definition obligations]
      → test/validator plan
      → deterministic design gates
      → assessment                     [contract assessment: invariants/boundaries/obligations]
      → critic → judge → repair        [bounded]
      → implementation DAG             [metadata-enriched promotion]
  → rolling_dispatch         [quota-routed, worktree-isolated, per-node
                              verification, ingestion folded in]
  → triage                   [context-carrying retries]
  → close                    [evidence-backed verification report]
```

Onto CLAUDE.md's five-state machine (`pending → planning → implementing → closing → complete`):
everything through the `contract_pipeline` phases is **planning**, `rolling_dispatch` is **implementing**,
and `close` is **closing** (`pending`/`complete` bookend the run).

---

## Gate 0 — Provider confirmation (shared with audit)

The audit design's Gate 1 (provider discovery, capability tiers, quota state,
user include/exclude) applies to remediation identically and is implemented once,
session-level, in `audit-tools/shared`. The confirmed provider pool drives
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
- Clarification answers are validated before `applyPlanClarificationResolution`
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

### Both paths run the pipeline — except the lean fast-path exception

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

**Exception, superseding this section:** [`self-scaling-pipeline-design.md`](self-scaling-pipeline-design.md)
is the newer design-of-record and specs a bounded lean fast path
(`src/remediate/steps/leanFastPath.ts`) that lets a qualifying Path-A run (small,
grounded, high-confidence, non-systemic finding set) skip the adversarial
contract-design loop while still rejoining the normal plan→implement→close
machinery (deterministic grounding, block derivation, file-hash integrity,
verify-before-merge) — it does not skip traceability or verification, only the
expensive negotiation phases. The fast path runs a mandatory light adversarial
pass (`interpretLeanLightReviewVerdict`) before proceeding, escalating to the
full pipeline on any concern — no longer a bare skip. Treat this section's
"both paths run the [full] pipeline" as the default; the lean fast path is the
sanctioned, narrowly-scoped exception, not a contradiction of the rationale
above.

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
5. **Critique** — conceptual design critique of the finalized contracts (the
   philosophy/alternatives/better-directions lens, distinct from the mechanical
   contract-assessment phase below).
6. **Obligation ledger** — a first-class phase in `CONTRACT_PIPELINE_PHASE_ORDER`,
   derived largely deterministically from finalized contracts: each invariant →
   verification obligation, each seam interface → test obligation.
7. **Cyclic seam resolution** — its own phase in `CONTRACT_PIPELINE_PHASE_ORDER`,
   breaking circular interface-definition obligations surfaced by the ledger
   (distinct from the deterministic *check* for the same condition below).
8. **Test/validator plan** — a distinct phase converting ledger obligations into
   concrete test specs, validators, and schemas *before any code is written*. A
   worker may flag a planned test as inapplicable only against the ledger, never
   on rationale alone.
9. **Deterministic design gates** — mechanical checks before adversarial review:
   - every module has inputs/outputs
   - every side effect has an owner
   - every invariant has a verification obligation
   - every implementation task traces to a requirement/invariant
   - every external dependency has failure semantics
   - no raw/untrusted data crosses a trust boundary unvalidated
   - **no circular interface-definition obligations** (two nodes each needing to
     define an interface the other depends on — caught before implementation)
10. **Assessment** — contract assessment (invariants/boundaries/obligations),
    a required input to both the critic and the judge below.
11. **Critic → judge → repair** — bounded, archived, hash-tracked; attacks the
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

## Review-approval gate

Between the findings and the contract pipeline, every judgment-heavy finding is
presented to the user for an explicit approve/disapprove **before** the pipeline
can mark it terminal-without-change. This is the single review surface per run —
it replaces the classic per-block implementation preview, which fired *after* the
pipeline had collapsed the original findings into implementation-DAG nodes and so
let design-review / free-form findings bundled inside a quality-tail node be
bulk-dispositioned invisibly. The gate operates before that collapse.

- **Tool owns structure; host owns judgment.** The tool deterministically buckets
  each finding by *review-necessity* — `strategic` (a design/architecture or
  cross-cutting call that is the user's to make), `concrete` (a real fix with some
  latitude, worth a yes/no), or `mechanical` (obvious, low-risk, FYI) — and
  guarantees each item is shown and tiered. The host fills only the semantic
  pros/cons when presenting; it can never decide *whether* an item is surfaced.
- **Fires before the contract pipeline, at the path-appropriate point.** Path A
  (structured findings) gates the ORIGINAL findings at intake, over the filtered
  survivors (deduped, evidence-bearing, path-grounded, checkpoint-kept), before the
  pipeline collapses them into DAG nodes. Path B (document/conversation) has no
  pre-pipeline finding set — its findings are derived inside the pipeline — so it
  is gated at the planning point over the deduped/grounded node findings. One
  review surface either way; the presence of a recorded decision prevents any
  double review.
- **Disapproval is a recorded terminal disposition, never a silent close.** A
  declined finding (by id or by whole tier) is excluded from the pipeline AND
  recorded as an explicit `ignored` disposition carrying the reason — the exact
  failure this gate exists to prevent. The default is to act: the gate lets the
  user REMOVE items, so an absent or empty resolution approves everything.
- **Idempotent, at most once per run.** The gate halts to collect the decision
  (`review_request.json` → `review_resolution.json`), then consumes it into a
  durable record (`review_decision.json`); once recorded it proceeds directly on
  every subsequent step and never re-halts. Unattended (autonomous) runs never
  halt — they auto-approve only the lowest-risk findings and re-emit the rest as a
  re-consumable deliverable, with no durable rejection.

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
  provider quota, tool crash) retry cheaply on a separate budget
  (`MAX_AUTO_RETRIES_INFRA`); contract/test failures use the tighter
  `MAX_AUTO_RETRIES_CONTRACT`-capped path — two distinct constants, not one
  shared budget.
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

- **Shared admission math; per-orchestrator pause lifecycle.** The dispatch *admission
  decision* — quota tracking, per-packet provider selection, capacity re-check on result
  arrival — is single-sourced in `audit-tools/shared` (`computeDispatchAdmission`), and both
  tools drive it with different packet types. The *pause lifecycle* wrapped around that
  decision is per-orchestrator: the audit side owns the `waiting_for_provider` resumable
  paused state, remediation owns its own analogous `quota_paused` mechanism. Both expose a
  consumer-neutral terminal: when the confirmed pool empties mid-run and the livelock guard
  trips, remediation routes the stranded subtree through close with a partial report (audit
  synthesizes on partial coverage). Re-discovery surfaces only genuinely-new providers and
  never re-offers a Gate-0 settled exclusion. (Unifying the full pause-lifecycle shell across
  both tools — beyond the shared admission math — is tracked as open work in `docs/backlog.md`.)
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
