# Remediation workflow design

The target design of the remediation pipeline — a declarative contract describing
the system as it is meant to work. It is **not** a status log: completion is
verified separately against the code (audits, invariant tests, the periodic drift
check), and this document is never edited to record what has or hasn't shipped or
to narrate past defects.

Companion to [`audit-workflow-design.md`](audit-workflow-design.md) — the two
share principles (complete host workloads, bound untrusted results, prompt
caching, structured output, roundtrip minimization). Shared infrastructure lives
in `audit-tools/shared` and is stated once in
[`cross-tool-alignment.md`](cross-tool-alignment.md).

---

## Pipeline order

```
intake + validation          [deterministic; validates input at manifest time]
  → synthesize + draft       [one background LLM pass: intake summary +
                              preliminary intent checkpoint + open questions]
  → intent_checkpoint        [user gate — single consolidated stop: confirm
                              scope, answer questions, set closing action]
  → review_gate              [user gate — Path A: original findings, pre-pipeline;
                              tiered by review-necessity, approve/disapprove]
  → reviewed_change_plan      [both input paths; one executable semantic plan]
      author scoped units, stable requirements and acceptance evidence
      → conceptual critique → independent critic → judge
      → revise affected meaning and re-review when required
      → deterministic workload projection
  → host_implementation_handoff [dependency-safe provider-neutral work items;
                                  commit/test evidence validation]
  → triage                   [context-carrying retries]
  → close                    [evidence-backed verification report]
```

Onto CLAUDE.md's five-state machine (`pending → planning → implementing → closing → complete`):
everything through change-plan approval is **planning**, `host_implementation_handoff` is **implementing**,
and `close` is **closing** (`pending`/`complete` bookend the run).

---

## Host execution boundary

Audit and remediation emit complete provider-neutral workloads. The host owns
all concrete execution, parallelism, and working-context choices. audit-tools
retains dependency/phase safety, deterministic metadata, prompt and baseline
bindings, strict result ingestion, commit/test corroboration, and closeout.

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

## Reviewed change plan — one subject of judgment

Both structured audit findings and conversation/document requests enter the same
planning engine. Depth follows risk and uncertainty; neither path bypasses scope,
traceability, independent review or verification.

The original findings and request remain provenance, not execution instructions.
A plan contains stable requirements, cohesive execution units, affected interfaces,
explicit read/write scopes, dependencies and acceptance assertions/commands.
Several units may address one finding, and a unit may address several findings.
A conversation request does not need an invented audit finding to become executable.

Describe changed behavior and endangered boundaries. Expand interface detail when
coordination actually requires it; do not reconstruct every untouched module's
contract merely to derive an implementation task.

### Author, challenge, revise

The author proposes the executable units and their requirements before approval.
Conceptual critique considers purpose and alternatives. An independent critic
challenges correctness and boundary assumptions; a separate judge disposes of
those counterexamples. These responsibilities remain distinct even though they
refer to the same plan rather than successive restatements of it.

A valid counterexample changes the plan, or the judge classifies it as a residual
risk that the operator explicitly accepts. Nothing records an operator override of
a counterexample the judge accepted: when the repair bound for a review cycle is
spent, the exits are a revised plan that is reviewed again, or cancelling the run.
Approval binds the exact reviewed revision. Changed meaning requires
fresh affected review; a post-approval semantic planner cannot silently change
scope, dependencies or what a unit is supposed to accomplish.

Requirements keep stable identities across insertion and reordering. An unchanged
requirement retains its assertions. Retirement or material modification is explicit;
removing a requirement from an array is not evidence that it has been satisfied.
Submissions bind their expected base revision so an old draft cannot overwrite a
newer accepted decision. Landed execution history is immutable: later design changes
produce explicit follow-up work, not deletion or replay of already accepted work.

### Tool-owned checks and derived views

The tool validates references, scope, source coverage, dependency acyclicity,
requirement coverage, assertion shape and revision bindings. Independent judgment
checks semantic adequacy; structural validity does not prove that a plan fixes a bug.
Review packets provide relevant source evidence and must distinguish supplied
claims from independently checked repository behavior.

Supporting summaries, coverage views and workload metadata are derived from the
accepted plan. They do not acquire independent editable authority. A genuine
ownership or ordering conflict is resolved in the plan's actual relationships,
not by separately repairing a second graph that dispatch does not use.

After approval, workload projection is deterministic. Current repository baseline,
prompt digests, eligible frontier and result paths are bound at dispatch; those
execution-time facts do not require another semantic design phase.

### One worker type — implementers

Workers execute approved units with their scope, requirements, dependencies and
verification instructions. There is no separate document phase or synthetic
Finding-to-block translation. Original findings remain available for reporting and
user dispositions; execution units remain the unit of implementation and retry.

---

## Review-approval gate

User-owned choices are resolved before the plan can turn them into execution or
terminal-without-change outcomes. Structured input preserves each original finding
and its explicit keep/decline decision. Conversation input presents the proposed
change and meaningful unresolved choices without manufacturing audit findings.

The tool owns complete presentation and recorded dispositions; the host supplies
judgment and rationale. Declining a source finding is an explicit outcome, never
silent loss during task grouping. A grouping or split of execution units cannot
change the user's decision about a source finding. Recorded decisions are reused
on continuation rather than repeatedly requested.

Risk-based presentation and unattended authority remain governed by the confirmed
intent checkpoint. A plan revision that changes an owner-controlled choice must
return that choice for resolution; prior approval is not blanket permission for
new scope or a different closing action.

---

## Host implementation handoff — dependency-safe and evidence-verified

The backend emits every currently eligible execution unit in one
`remediation-host-workload` artifact (revision defined by
`REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION` in `src/remediate/steps/types.ts`). Eligibility is deterministic: a
unit is emitted only after every required dependency is verified complete.
Each work item contains its obligations, declared write scope, complete prompt,
prompt digest, baseline commit, and repository-contained result path; the
workload digest binds the handoff record as a whole. Complexity, risk, and
token estimates are advisory metadata only.

The host chooses whether to use subagents, branches, or worktrees and whether to
parallelize mutually eligible items. audit-tools does not create workers, select
backends, route models, schedule waves, meter quota, or retry execution.

**Bound result ingestion.** Host-written results are untrusted. Before accepting
an item, the backend checks run/work-item/prompt/workload/baseline bindings,
changed-file scope, the reported commit against the real repository, and test
evidence against production-observed state. Fabricated commit or test claims,
stale baselines, path escapes, missing results, and unsupported legacy state are
reported explicitly and do not advance the item. Accepted replay is idempotent.

**Worktree and integration safety.** A host may isolate risky work in a worktree,
but completion is judged against the bound repository state. Dependencies are
not released until their prerequisites' landed commits and verification evidence
are corroborated. Cross-node failures re-block only the implicated items and
carry the failing evidence into the next host work item.

**Scope amendment.** Work outside a declared scope requires a new tool-owned
workload binding; a result cannot make its own widened scope self-consistent.
Contended or cross-boundary design changes revise the plan and its review binding
rather than being accepted as an incidental side effect.

**Dependency conflicts.** A genuine ownership/order cycle requires a recorded plan
revision, such as one owner for a shared primitive or an explicit mediator.
Repeated unsuccessful revisions escalate a concrete unresolved question instead
of spinning indefinitely.

**Workflow-modifying node verification.** Nodes editing the handoff, ingestion,
or orchestration engine are verified against the live built surface, not only a
stale installed bin or isolated worktree.

**Token estimation** uses the shared `estimateTokensFromBytes`: node estimates
from contract scope file sizes + spec length + pulled-in test files.

**Write scope** comes from the approved unit's `allowed_files`, normalized and
bound in the work item. A host response cannot widen its own grant.

---

## Triage — context-carrying, precisely-scoped

- **Explicit action always wins.** An explicit `action` is authoritative;
  `rationaleAsksForRetry` breaks ties only when `action` is absent. Settled user
  decisions are never reinterpreted later (close does not re-open `ignored`
  items).
- **Retries carry failure context.** A re-emitted node's new prompt includes what
  failed last time (the contract assertion, the test output tail, the precondition
  violation) — never an identical blind retry. Per-node verification makes this
  context specific rather than an opaque "worker reported blocked".
- **`halt` routes through close.** Halt sets `closing` so a partial report is
  produced for work already done; the report marks the run user-halted.
- **Execution failure stays host-owned.** A host may retry an environmental
  failure, but audit-tools records only valid bound results or an explicit
  unresolved item; it does not infer backend failure classes.
- **Report the resolution outcome.** After consuming a triage resolution, the next
  step's prompt summarizes what was retried/ignored/unblocked.

---

## Close — evidence-backed, recoverable, user-previewed

- **Closing action preview.** Before `commit`/`push`/`open-pr`/`publish` executes,
  the file list and a generated (not hardcoded) commit message are presented for
  confirmation — unless the user pre-authorized unattended closing at the intent
  checkpoint. The preview is one host boundary, not a repeatedly drained state
  transition. Approval binds the recorded action and preview; a changed preview
  is presented again.
- **One final acceptance execution window.** Close owns the tool-executed floor,
  including direct phase calls, after preview approval. When its terminal unit
  command and the combined-suite requirement select the same root-scoped
  invocation, one admitted execution satisfies both requirements. No result
  from an earlier call, worker, phase or repository is reused. Distinct commands
  and E2E, analyzer and landing operations remain distinct, as do per-item and
  intermediate phase checks. A floor failure pauses before combined-suite
  triage can re-block items; a missing executable floor never authorizes close.
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
- **Artifacts survive until explicit cleanup.** The artifacts directory (host
  workloads, specs, intermediate results) is preserved for diagnosing a failed closing
  action or e2e run; cleanup is offered when the report is presented and runs
  automatically only after a fully-green close.

---

## Cross-tool alignment (shared with the auditor)

The contract shared with the auditor — implement once, in `audit-tools/shared`
— is stated once in [`cross-tool-alignment.md`](cross-tool-alignment.md).

---

## Retained invariants

- State persistence model (file-backed, pessimistic locking) and the
  one-bounded-step-per-invocation contract.
- Independent critic → judge → revision, bounded disagreement and accepted history.
- Traceability invariant: every execution unit addresses stable requirements, with
  original source references and accepted counterexamples preserved.
- Cross-lens dedup, grounding of extracted findings, coverage ledger.
- Intent checkpoint filter semantics (severity/lens/package/theme,
  `excluded_scope`, `must_not_touch`).
- Outcomes contract (`remediation-outcomes.json`) and report rendering.
- Diagnostic capture and archival. Development reflection belongs to this repo's
  development closeout, never to an external target's product completion gate.
