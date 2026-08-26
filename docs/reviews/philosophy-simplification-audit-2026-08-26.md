# Philosophy and design-choice simplification audit — 2026-08-26

This is a companion to
[`complexity-reduction-audit-2026-08-26.md`](complexity-reduction-audit-2026-08-26.md).
That review asks where the implementation repeats itself. This review asks the earlier
question: **which governing choices make that machinery necessary, and which choices can be
restated so the simplest implementation is also the correct one?**

No production code changed during this review.

## Method and evidence boundary

- **Evidence tier:** task-directed Verify intent, with a disclosed Codebase Memory fallback.
- **Codebase Memory project:** `C-Code-audit-tools`; latest known full generation
  `2026-08-26T17:51:08Z`.
- **Live graph:** the Codebase Memory UI daemon reported 20,897 nodes and 69,858 edges. Its
  full `/api/layout` projection was downloaded read-only and used to confirm symbols, module
  sizes, and cross-file relationships.
- **Coverage limitation:** native MCP graph schemas remained absent and
  `codebase-memory-mcp cli` remained cohort-locked, so formal `check_index_coverage` did not
  execute. The full layout contained 43 of 46 material evidence paths. `package.json` and the
  two material `.claude/hooks/*.mjs` files were verified by exact source because the layout did
  not expose them; the recorded missed-graph set contained none of the other material paths.
- **Repository scale relevant to this review:** 31 `check:*` npm scripts; 37 steps in
  `verify:checks`; 25 custom script-backed checks totaling 5,197 lines; and an observed
  hook/guard/check support set of 38 files totaling about 10,160 lines. These counts are
  symptoms and prioritization evidence, not findings by themselves.

The review read the canonical instructions and philosophy, the audit/remediation workflow
specifications, current handoff/backlog state, guard and release tooling, host installers,
nightly state readers, and the existing structural and slim-down reviews. It also used three
independent read-only review lanes: philosophy/document topology, workflow-policy mechanisms,
and product architecture.

## Executive conclusion

The product philosophy gets the difficult boundaries mostly right: machine contracts are
authoritative, host execution is untrusted, routing remains outside the package, work is
resumable, and high-risk work deserves independent review. Keep those.

The avoidable complexity comes from four absolute formulations:

1. implementation identity is treated as proof of conceptual unity;
2. every mechanically detectable rule is presumed worth a hard gate;
3. adversarial ceremony and host-turn boundaries are a fixed floor rather than a risk response; and
4. endpoint purity discounts transition reversibility, reviewability, and blast radius.

The elegant endpoint is **authoritative data plus small lifecycle adapters**. It is not a
universal policy DSL, one mega-validator, or a several-knob state machine shared by unrelated
phases.

## Recommendations at a glance

| ID | Priority | Choice to change | Elegant endpoint |
|---|---:|---|---|
| PH-01 | High | “One core” means one algorithm | One protocol and shared pure primitives; two honest bounded contexts |
| PH-02 | High | Self-scaling policy both requires and forbids collapsing low-tier adversarial phases | Make its risk and granularity dials authoritative |
| PH-03 | High | A shared bounded `advance()` sits beneath an audit-specific outer drain | Evolve it into the single `advanceUntilBlocked` contract |
| PH-04 | High | Endpoint purity discounts transition reviewability and blast radius | Optimize lifetime cost while keeping a clean endpoint |
| PH-05 | High | Everything enforceable must become a hard gate | An authority and lifecycle-cost test for every gate |
| PH-06 | High | Preserve secondary inventories and prove parity | Delete or derive them from the executable source on demand |
| PH-07 | High | HANDOFF and closeout are manually narrated state | Minimal generated handoff plus session-bound, mechanically derived closeout |
| PH-08 | Medium | Every document receives the same semantic review ceremony | Continuous deterministic lint; semantic review by change and risk |
| PH-09 | Medium | Similar host/governance surfaces grow parallel implementations | Typed descriptors and strict shared read models with thin adapters |
| PH-10 | Medium | “Own the pipeline” is partly a prose obligation | One resumable command owns publish, live verification, reinstall, and smoke |

## Detailed findings

### PH-01 — Replace “one algorithmic core” with one protocol and shared pure primitives

**Choice creating the complexity.** `docs/project-philosophy.md:102-110` says audit and
remediation are one body of logic, permits only input and terminal-routing differences, and
declares a per-case algorithm illegitimate. `CLAUDE.md:235-245` repeats the direction, while
`README.md:3-10` presents two independently useful tools. The implementations also have different
safety semantics:

- audit uses a priority obligation walk (`src/audit/orchestrator/nextStep.ts`);
- remediation owns mutation, phase locks, clarification, triage, merge, quarantine, and
  recovery semantics (`src/remediate/steps/nextStep.ts`;
  `src/remediate/index.ts:186-303`);
- the exact-source slim-down review establishes that partial audit coverage may be abandoned
  while half-applied remediation may not, and that the two `decideNextStep` machines are genuine
  category differences (`docs/reviews/slimdown-review-2026-07-28.md:659-671`);
- the conceptual-design review explicitly retains separate clarification operations when their
  resolution semantics differ (`spec/conceptual-design-review-design.md:247-253`).

The graph prioritizes this question: audit CLI advancement is split across
`nextStepCommand.ts` (1,488 physical lines) and `nextStepHelpers.ts` (2,827), while remediation's
`nextStep.ts` is 4,402. Those sizes are prioritization evidence, not proof that the policies should
be separate. The semantic and safety differences above supply that proof. Forcing them into one
configurable algorithm would move the branches into a larger abstraction without removing their
distinct obligations.

**Elegant endpoint.** Share the workload/result envelope, persistence and content keys, locking,
host-result binding, validation primitives, and reusable rendering primitives. Keep separate audit
and remediation state-transition policies. Call this **one protocol, two bounded contexts**.

**Concrete consequence.** Narrow the existing “one-core dissolution lap” in
`docs/backlog/forward-tracks.md:132-141` to shared handoff substrate and pure primitives. Do not
make remediation conform to audit's obligation walk merely to satisfy the metaphor. This agrees
with the structural audit's rejection of full host-handoff unification.

### PH-02 — Apply the self-scaling policy to low-tier host-turn ceremony

**Choice creating the complexity.** The intended policy already has the right risk distinction:
low risk gets an inline self-check with no independent subagent, while high risk earns independent
critique, counterexample, and judge work (`spec/self-scaling-pipeline-design.md:43-46`). Its
granularity dial also says coherent or degenerate phases should collapse when failure isolation
does not pay for the boundary (`:55-65`).

The same specification then requires critic and judge phases even at light depth and says they may
never collapse (`:48-53`). The measured consequence is seven gated phase/host turns for a clean
low-tier run (`:21-26`). The complexity comes from that internal policy contradiction, not from
independent subagents at low tier.

**Elegant endpoint.** Make the existing risk and granularity dials authoritative. Low-tier
scrutiny can live in the inline self-check or a coherent authoring workload; it need not pay
separate critic and judge round trips. High-risk work keeps independently bound critique,
counterexample, and judgment. Batch only roles that are ready at the same frontier:
counterexample and judge work still depends on validated upstream artifacts and remains
sequenced.

This is a conformance correction to the stated self-scaling design, not a new low/medium/high
review policy.

### PH-03 — Evolve the existing engine into `advanceUntilBlocked`

**Choice creating the complexity.** “One bounded step” means multiple things. `CLAUDE.md:17`
calls it one step; `CLAUDE.md:89` and `CLAUDE.md:178` redefine it as a fold-aware drain of many
deterministic obligations; the audit CLI then adds branch and emission drains around the shared
engine. The terminology makes nested loops look like separate contract requirements.

The missing primitive is not new. `src/shared/engine/obligationEngine.ts:170-293` already provides
bounded `advance()`: it repeatedly selects and executes transition obligations, stops at an emit
or completion, and reports structured `cycle` or `bound` non-convergence.

**Elegant endpoint.** Rename and evolve that operation into the single advancement contract,
`advanceUntilBlocked`. Preserve its cycle/bound safeguards, but make completion, interaction,
external work, and budget stops explicit enough that callers do not reinterpret `step: null` or
wrap the engine in another drain. Never cross an external-input boundary. Once the shared result
can express every legitimate stop, remove the audit-specific outer drain identified by CX-02.

This is a contract clarification and consolidation of machinery that already exists, not a second
advancement engine.

### PH-04 — Optimize lifetime cost and transition safety, not endpoint purity alone

**Choice creating the complexity.** The current philosophy values the cleanest, most-efficient,
most-robust steady state, requires green commits, forbids broken or lossy intermediate states, and
uses atomic replacement for destructive transitions (`CLAUDE.md:188`; `:229`; `:234-245`). It
therefore addresses transition correctness. The narrower problem is that it deliberately excludes
implementation effort and refactor size from endpoint choice. Its one-commit atomic-replacement
constraint can reduce reversibility and reviewability for large internal migrations.

**Elegant endpoint.** Keep “no legacy in the finished design” and optimize total lifetime cost:

- count steady-state cognitive and runtime cost;
- count migration risk, reviewability, reversibility, and blast radius;
- use small green commits and reversible internal seams where they reduce those risks;
- keep every commit green, and forbid externally visible dual or lossy paths throughout;
- remove every temporary internal seam before the branch or release reaches its clean endpoint.

Refactor size must not veto a better endpoint. It should influence the safest route to it.

### PH-05 — Give every hard gate an authority and lifecycle-cost test

**Choice creating the complexity.** “Whatever can be enforced in tooling must be” appears in
`docs/project-philosophy.md:44-49` and `CLAUDE.md:176`. It has no materiality, authority, false-
positive, or maintenance-cost qualifier. The live result is 31 `check:*` scripts, a 37-step
`verify:checks`, a 1,108-line guard-reach registry describing 86 guards, and substantial
Claude-specific command parsing and session enforcement.

The sharpest example is `.claude/hooks/pre-commit-gate.mjs`: it parses arbitrary shell text,
`cd`, `git -C`, multiple history-writing verbs, and bypass tokens merely to infer whether Git is
about to create history. The staged-tree checks are valuable; reimplementing a shell parser to
find Git's boundary is not.

**Elegant endpoint.** Admit a hard gate only when all four are true:

1. the invariant protects product/release correctness or a repeated costly failure;
2. the gate runs at the narrowest authoritative boundary;
3. detection is stable enough to fail closed without heuristic prose or shell parsing; and
4. expected avoided defect cost exceeds false-positive and maintenance cost.

Put staged-tree policy in a host-neutral repository command invoked from Git/CI. Let Claude,
Codex, IDE, and shell hooks provide earlier feedback, never unique correctness. Rules that fail
the test should be advisory, sampled, or removed. This is a gate budget, not permission to weaken
the host-result bindings at the product boundary.

### PH-06 — Delete secondary inventories instead of proving them equal

**Choice creating the complexity.** Two substantial checks retain parts of a secondary metadata
plane over executable source:

- `package.json:54` owns the executable gate sequence. `STEP_GLOSS` in
  `scripts/gate-enumeration-data.mjs:17-35` keeps a parallel membership-keyed description set,
  while `scripts/check-gate-enumeration.mjs:27-45` correctly derives order from the executable
  source. The shipping workflow still renders the duplicate enumeration.
- Guard reach mixes derivable identity and wiring with declarations that source inspection cannot
  infer. `scripts/check-guard-reach.mjs:14-33` and `:175-205` distinguish repository-discovered
  existence/reachability from explicit semantic reach, uncovered halves, and nonstandard
  contract-test claims.

The philosophy-document topology is the counterexample to retain:
`docs/project-philosophy.md:3-15` is a non-authoritative map whose linked homes own detailed
contracts; its brief separately owns condensed principle wording rendered into README and
agent-facing excerpts (also `docs/documentation-philosophy.md:19-24` and `CLAUDE.md:246-253`).
That is the desired single-source arrangement.

**Elegant endpoint.**

- Delete the generated shipping enumeration and invoke `npm run verify:checks` directly. Retain
  human descriptions only if a named consumer needs them, colocated with the executable
  declaration. Profiling can derive step names and order, but cannot invent descriptions.
- Derive guard identity, on-disk existence, npm reachability, and hook registration. Retain
  explicit semantic reach claims, uncovered halves, and nonstandard contract-test metadata; delete
  only the `GUARDS` identity/wiring fields recoverable from repository sources.

Delete each parity mechanism with the duplicate it protects. Do not replace the inventories with a
universal policy DSL; that would preserve the same secondary plane in abstract syntax.

### PH-07 — Generate a minimal HANDOFF and derive closeout's mechanical facts

**Choice creating the complexity.** `docs/HANDOFF.md:3-4` promises immediate state and next action
only. At the start of this review, its hand-written region instead held release-run history, a
multi-commit consolidation narrative, and closeout-repair history; the live
`HANDWRITTEN_CREEP_RULES` check still accepted it. That changelog creep was removed before this
report was published.

Closeout duplicates much of the same repository state manually. The renderer, section registry,
Stop hook, and related tests exceed the size justified by the small amount of irreducibly human
input. Prior measurement found that 19 of 29 sessions hand-wrote a closeout despite 63 renderer
invocations (`docs/reviews/closeout-generation-failure-2026-08-26.md:17-18`). The current cadence
also defines any pause or window switch as a sprint end requiring the full rendered closeout
(`CLAUDE.md:230`; `docs/project-philosophy.md:287-292`).

**Elegant endpoint.** Make HANDOFF a small generated projection of stable local facts:

- repository/package version and synchronization state from the local checkout;
- one optional structured transient note;
- a generated nightly-decision pointer;
- the `▶`-pinned backlog pointers.

Do not make a tracked projection depend on a live registry query:
`scripts/release-and-publish.mjs:27-30` and `:448-456` show that registry observation is
network-, latency-, and error-prone. Published availability can be rendered best-effort at display
time rather than committed as canonical state.

Record `head_at_start` in the existing session registry and derive commits, changed documents,
cleanliness, pushed state, and next-step pointers for closeout. Require author input only for
verification claims not present in a trusted run record, deliberate intermediate state, friction,
and owner decisions. Store the result under the session identity rather than a repo-global
`latest.json`, and never infer that a test passed from a timestamp.

Reserve the full closeout for an ownership handoff, release, or meaningful milestone. A routine
pause gets a lightweight persisted checkpoint. This changes cadence as well as generation; merely
generating the current ceremony would automate excess.

### PH-08 — Scale semantic documentation review by change and risk

**Choice creating the complexity.** Documentation governance correctly separates deterministic
lint from judgment. A reviewer and adversary inspect every in-scope item; a judge resolves only
contested items (`docs/doc-review-guidelines.md:54-65`). The ledger and pipeline are intentionally
exhaustive over the declared corpus (`:258-317`). The authoritative scope plan for this review
covers 55 documents and 1,852 semantic items.

The tree-wide count is misleading here: the 210-document manifest includes all 88 review records
under `docs/reviews/`, which are already excluded from semantic review by construction
(`docs/doc-review-guidelines.md:206-222`; `:252-256`). The cost multiplier is exhaustive
item-level review inside the remaining conceptual corpus.

**Elegant endpoint.** Retain the existing exclusion for historical evidence and run deterministic
status-noise, manifest, generated-copy, citation, and link checks continuously. Run semantic review
on:

- changed conceptual documents and their declared dependents;
- documents affected by a changed principle or contract;
- high-risk or contested edits, with an independent reviewer and judge where needed;
- a periodic rotating corpus sample or full sweep, rather than every ordinary nightly pass.

Retain periodic full coverage because a changed-document pass can miss an unchanged dependent
whose assumptions became stale.

### PH-09 — Use typed descriptors and strict shared views for parallel secondary surfaces

Several smaller duplications share one cause: each presentation or host adapter reconstructs the
same policy rather than consuming an authoritative read model.

**Host installation.** `scripts/audit/postinstall.mjs` (322 lines) and
`scripts/remediate/postinstall.mjs` (292 lines) separately implement wildcard migration and
OpenCode configuration around the same shared installer; their verify CLIs are thin 48/55-line
adapters. Introduce a `HostAssetPlan` descriptor containing sources, permissions, transforms, and
optional MCP/desktop features. One installer and verifier execute it. Audit's extra desktop/MCP
behavior remains a policy row, not forced equality.

**Nightly state.** `answer.mjs`, `render-inbox.mjs`, `nightly-surface.mjs`, and
`generate-handoff-roadmap.mjs` each assemble open items, decisions, and settled/actionable
partitions. Expose one strict `readNightlyView(root)` for presentation consumers; keep the
permissive reader only inside regeneration/write recovery.

**Small governance vocabularies.** The friction taxonomy is repeated in the production TS tuple,
the Stop hook, and closeout registry. Project-memory directory derivation is repeated with
different path-normalization rules. Put each in one pre-build data module and give TypeScript,
hooks, and scripts thin adapters.

This is intentionally narrower than a plugin framework. Each descriptor removes parallel
secondary representations while preserving lifecycle-specific error behavior.

### PH-10 — Make one resumable command own the full ship pipeline

**Choice creating the complexity.** Project philosophy says the agent owns commit, push, merge,
publish, live verification, and global reinstall (`docs/project-philosophy.md:265-270`). The
release script ends after registry visibility, while the `/ship` skill leaves global reinstall,
postinstall, and binary smoke checks to agent prose. A delayed release event has already caused a
manual recovery path (`docs/backlog/open-bugs.md:9-20`).

**Elegant endpoint.** Add an idempotent `ship.mjs` or extend the release command so one resumable
state record owns:

1. gated commit/ref verification;
2. tag/release/publish creation exactly once;
3. delayed CI/release observation without mistaking latency for absence;
4. registry verification;
5. reinstall with allowed lifecycle scripts; and
6. smoke checks for both global binaries and installed host assets.

Never automatically retry destructive tag or release creation. Resume only observation and
completion phases. Move YAML critical-path profiling out of release correctness into a
best-effort reporting helper.

## Concrete code reductions exposed by the philosophy review

These complement CX-01 through CX-07 in the structural audit. They are places where the code
already has enough evidence to apply the project's better principles—one authoritative contract,
no legacy for its own sake, and bounded execution—without waiting for the strategic wording
changes above.

### DC-01 — Delete the producerless provenance plane

`src/shared/types/executionRecord.ts` defines and publicly exports `ExecutionRecordV1Alpha1` and
its Zod schema, but bounded production search over `src/`, `scripts/`, and `wrapper/` finds no
tracked schema call, producer, or consumer beyond the shared barrel. Separately, `src/shared/types/runLedger.ts` and
`src/audit/supervisor/runLedger.ts` define and read `run-ledger.json`; status and operator handoff
advertise it, but no tracked production writer exists.

`run.log.jsonl` is real telemetry, not an authoritative replacement. `RunLogger` can be disabled,
becomes a no-op when no path is configured, and intentionally swallows append failures
(`src/shared/observability/runLog.ts:4-6`; `:38-39`; `:65-79`). It also does not supply every old
ledger field.

Retire the unused execution-record and run-ledger plane at an explicit contract boundary. Then
choose the durability semantics honestly:

- make `status.recent_runs` explicitly best-effort telemetry derived only from fields the real log
  records; or
- if status needs durable provenance, add an authoritative structured terminal event and writer.

Do not synthesize missing ledger fields or call the current log authoritative. The risk is broader
than status JSON: `audit-tools/shared` public exports, `spec/cross-tool-alignment.md`,
operator-handoff paths, tests, and documentation all describe parts of this surface. Verify those
consumers together, then remove or version the contract atomically.

### DC-02 — Use one strict, versioned remediation-state schema at read and write

The remediation state shape currently has several partial authorities. `src/remediate/state/store.ts:113-212`
contains a hand-written partial load validator; `:245-260` parses bytes but does not establish the
full contract; `:286-311` mutates and replaces state. Host handoff separately narrows state and
`RemediationStateKeySet` duplicates keys. The shared store already supports an optional
`validate` hook and invokes it on writes (`src/shared/io/lockedJsonStore.ts:46-50`;
`:120-123`), but this state store does not use one full schema symmetrically.

Define one Zod discriminated-union `RemediationStateSchema` with an explicit
`contract_version`. Parse it on every read and through the existing write-validation hook on every
mutate/replace. Use the inferred type for host narrowing and delete the key set, partial
validators, casts, and add/strip adapters. Handle pre-version state through one explicit migration
or invalidation release. This closes the “write now, fail on the next invocation” gap.

### DC-03 — Make the shared step schema describe and validate emitted bytes

`src/shared/io/stepContractWriter.ts:193-207` defines the shared contract only as a TypeScript
interface, and the writer injects `agent_id` at `:303-320`. Audit's strict `StepArtifactSchema`
omits `agent_id`, so its own emitted artifact cannot parse; a test explicitly works around the
mismatch (`tests/shared/submission-path-is-tool-owned.test.ts:23-25`). Remediation hand-validates
the same base independently. This exact defect is already program-of-record
(`docs/backlog/open-bugs.md:785-789`).

Create one shared Zod `BaseStepSchema` that includes `agent_id`; each draw extends it with its
`step_kind` and real policy fields. Pass the concrete schema into the writer and parse the fully
constructed value before persistence. Without runtime parsing, the current
`as unknown as TStep` cast and `extraFields` can recreate schema/byte drift
(`src/shared/io/stepContractWriter.ts:303-322`).

`allowed_mcp_tools` is declared in audit's `StepArtifactSchema` and covered by producer tests
(`src/audit/cli/steps.ts:70-101`; `tests/audit/steps-write-current-step.test.ts:167-201`), but a
bounded tracked production search finds no reader after artifact emission. That absence does not
rule out an installed host capability. Inspect installed host assets before deleting it. If no host
consumer exists, remove it at the same versioned contract bump; otherwise represent the external
capability explicitly and test that boundary.

### DC-04 — Delete the pre-split design-review compatibility lane

The live audit still polls `design_review_legacy` alongside contract and conceptual review
(`src/audit/cli/laneSubmissions.ts:77`; `src/audit/cli/nextStepHelpers.ts:1129-1156`). Old
`reviewed` state is interpreted as both modern passes and preserved across structure refresh.

Legacy artifacts do not currently fail a strict schema, so deletion needs an explicit resume
endpoint. Keep only the two current judgment types, then either make the absence of modern flags
leave both modern obligations unmet and force a rerun, or version the persisted state and
invalidate pre-split review state at load. Do not silently translate one legacy verdict into two
different judgments.

This verifies and supersedes the earlier slim-down review's direction
(`docs/reviews/slimdown-review-2026-07-28.md:512-538`); its approximate 230-line/12-file estimate
was not re-established and should not be treated as current scope. The risk covers every resumed
pre-split artifact directory, not only audits visibly in flight. Fixtures, quarantine/merge
behavior, and operator-facing rerun messaging must move with the lane.

### DC-05 — Make submission provenance an ordinary runtime-validated record

`SubmissionLedgerRead` is an array intersection with hidden non-enumerable `.events` and
`.dropped` properties so old callers still observe `[]`
(`src/shared/submission/submissionLedger.ts:123-176`). Recovery acceptance then deduplicates by
asking whether a free-text event message contains a landed commit
(`src/remediate/steps/dispatch/hostHandoff.ts:2212-2253`).

Return `{ events, dropped }` directly and decode events with a Zod discriminated union. An
`accepted_via_recovery` event should carry structured `baseline_commit` and `landed_commit` fields.
The current reader accepts any object with the matching version without validating `kind` or
required fields (`src/shared/submission/submissionLedger.ts:213-238`); invalid-shape lines should
be classified in `dropped`.

Because the ledger is persisted NDJSON, add an event version and an explicit decoder/migration for
older lines. The consumer set is small only inside the tracked repository:
`readSubmissionLedger` is exported through published `audit-tools/shared`
(`src/shared/index.ts:489-498`; `package.json:12-20`). Treat the return-shape change as an external
API contract and migrate it deliberately. Identity should never be parsed back out of a message.

### DC-06 — Make the contract envelope strict, then test whether host views can be derived

The remediation contract pipeline can create up to 30 payload-bearing files for fifteen artifacts:
a plain `<name>.input.json` host staging/read view and an accepted `<name>.json` envelope
(`src/remediate/contractPipeline/artifactStore.ts:1-24`; `:150-166`). Tool-derived artifacts can
place the same payload in both, yielding up to fifteen duplicated payloads (`:244-263`).

Those paths do not currently claim equal authority. The plain file is an untrusted host staging/read
view; the envelope is the accepted canonical form. The proven defect is narrower: envelope
authority is split among a TypeScript interface, a permissive `isEnvelope`, and generic
unvalidated reads (`:79-105`; `:286-303`), while the CLI accepts bare or wrapped forms
(`src/remediate/index.ts:385-391`).

Retain the envelope and validate it with one strict Zod schema at every canonical read and write.
Shape validation is insufficient: bind `artifact_name` to the requested name/filename and
recompute `content_hash` over `payload` before selecting a semantic projection
(`src/remediate/contractPipeline/artifactStore.ts:98-106`; `:195-199`; `:279-288`). Preserve and
validate dependency metadata as part of the same contract.

Making the host view ephemeral or deriving it from the envelope is a design hypothesis, not an
established deletion. First verify prompt-path, resume, staleness, quarantine, and host-lifecycle
requirements. If those checks show the plain view need not survive acceptance, delete or derive it
in one atomic migration; otherwise document its bounded staging role and stop treating the two
paths as interchangeable.

### DC-07 — Reconcile convergence semantics and bound systemic challenge

The conceptual-design spec describes convergence after an unspecified `N` consecutive dry rounds;
it defines neither a value nor configuration (`spec/conceptual-design-review-design.md:79-80`;
`:175-179`). Runtime instead converges on the first round with zero novel findings, including a
non-empty submission whose findings were all seen before
(`src/audit/orchestrator/systemicChallengeExecutor.ts:28-43`; `:97-121`). Novelty already uses the
content-derived `findingReEmissionKey`
(`src/audit/systemic/systemicChallengeLoop.ts:68-70`; `:89-112`), superseding the earlier
worker-ID concern. Bounded source search found no total-round ceiling; that open defect is already
recorded at `docs/backlog/open-bugs.md:791-803`.

Choose and encode one convergence rule: either define the required number of consecutive
zero-novelty rounds or make the current single-round rule normative. Separately from reconciling the dry-round rule, introduce a finite,
risk-scaled total-round budget as a new policy and persist an explicit terminal status such as
`"converged" | "exhausted" | "omitted"`. A cap can miss a late insight, so allow a deliberately
authorized deeper budget. The default must still be mechanically finite.

## Small, low-risk deletions and consolidations

These do not need a new architecture program:

- delete comment-only `N-X06`; replace the `N-R13` historical family across source, specs, and
  tests with a semantic document-phase name; replace runtime-visible `N-R21` with a named
  diagnostic and explicit resolution action, updating producer, prompt, and tests atomically
  (`docs/glossary-ids.md:13-19`; `:66-72`;
  `src/remediate/validation/contractPipelineGates.ts:223`);
- delete the release-gate restatement and make `/ship` invoke the executable list directly;
- share project-memory path/index resolution between the citation check and closeout hook;
- single-source friction IDs and labels for product, hook, and closeout consumers; and
- expose one strict nightly presentation view before changing any individual consumer again.

## Complexity to retain

- **Machine JSON plus generated Markdown.** It serves machine and human consumers without dual
  authorship.
- **Prompt SHA, run/work-item identity, baseline commit, scope, required-test corroboration,
  locking, and idempotent replay.** These constrain a genuinely untrusted host boundary.
- **Provider/model/OS neutrality and host-owned routing.** These delete volatile execution
  inventory from the package.
- **Persisted artifacts and semantic dependency hashes.** Simplify their representation, but do
  not replace them with timestamps or ad hoc freshness checks.
- **Separate contract and conceptual review.** They are different judgment kinds. Batch or
  risk-scale execution; do not merge their semantics.
- **Distinct audit charter-clarification and remediation item-clarification payloads and
  transitions.** Reuse the generic pause/binding pattern, but keep separate types and status
  transitions because their resolution semantics differ
  (`spec/conceptual-design-review-design.md:247-256`).
- **Independent review for high-risk changes.** PH-02 removes a fixed ceremony floor, not
  adversarial review where it pays for itself.
- **The semantic audit-result validator.** Per-worker remediation prose and cross-record rules are
  not equivalent to Zod shape validation
  (`docs/reviews/slimdown-review-2026-07-28.md:668-672`).
- **Separate focused backlog validators.** They already share entry grammar; a mega-validator
  would obscure distinct baselines and remediation messages.

## Rejected attractive abstractions

- A universal policy engine for pre-commit, CI, Stop hooks, docs, backlog, and release. Their
  lifecycle and fail-open/fail-closed semantics differ.
- One audit/remediation state schema or one mega state machine. Share constructors and boundary
  primitives, not domain payload policy.
- A plugin framework merely to split the external-analyzer registry. Module boundaries and one
  typed registry are enough.
- Event sourcing as a replacement for the artifact DAG. It moves rather than removes the
  dependency and replay proofs.
- Full host-handoff unification. Share scanning, binding, validation, and persistence primitives;
  keep per-case acceptance and mutation policy.

## Suggested order

1. **Correct contracts that contradict emitted/runtime reality:** DC-01 through DC-05 and the
   structural cycle defect CX-01.
2. **Change the policy multipliers before further convergence work:** PH-01, PH-02, PH-03, and
   PH-05.
3. **Delete governance duplication:** PH-06, minimal HANDOFF/derived closeout in PH-07, then the
   small single-source items.
4. **Take the larger migrations deliberately:** DC-06, host installer descriptors, and the
   resumable ship command.
5. **Change semantic cadence last:** PH-08 after measuring changed-doc review and periodic-sweep
   miss rates.

The highest-leverage decision is PH-01. If “one core” continues to mean one algorithm, future
cleanup will repeatedly build configurable abstractions around real domain differences. If it
means one protocol and shared pure primitives, the rest of the simplifications become easier to
judge on evidence rather than loyalty to a metaphor.
