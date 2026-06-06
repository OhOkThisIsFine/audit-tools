# Backlog — known friction, deferred fixes & future product directions

A living log of things to fix or build later, so they are not lost between
sessions. This is also the home for deferred product-design specs that are still
too early to encode as implementation contracts.

**Remove an entry once it ships** — this is a to-do list, not a status log. When
an item needs design detail, record durable contracts, gates, and principles
rather than "where the code is today."

## Known friction (agent / dev experience)

- **`t.mock.module` is unusable in audit-code tests.** audit-code runs tests via
  `node --import tsx/esm --test`; `t.mock.module` needs
  `--experimental-test-module-mocks` and conflicts with the tsx/esm loader, so it
  throws `t.mock.module is not a function`. Use a dependency-injection point
  instead (e.g. `cmdWorkerRun(argv, deps)` in
  `src/cli/workerRunCommand.ts`) rather than module-graph mocking.
- **Remediation block scopes can omit companion contract files.** A block adding
  `lens_breakdown` to the generated audit findings summary had write access for
  the shared type and synthesis code but not `packages/audit-code/schemas/`, even
  though `audit_findings.schema.json` has `additionalProperties:false` on
  `summary`. Implementation workers need schema files included whenever a public
  artifact contract changes.
- **Backslash escaping / arg serialization.** Inline `node -e "…\\…"` (regexes,
  Windows paths) gets mangled by shell backslash handling — write a small script
  file instead of inlining. Separately, the Workflow tool's `args` can arrive as a
  JSON *string* rather than a parsed object, so `args.foo` is `undefined`; defend
  with `const a = typeof args === 'string' ? JSON.parse(args) : args`.
- **The `Bash` tool mangles Windows backslash paths.** A plain command like
  `node C:\…\audit-code.mjs merge-and-ingest …` run through `Bash` drops the
  backslashes (`C:\a\b` → `C:ab` → MODULE_NOT_FOUND). Use the `PowerShell` tool for
  Windows-absolute-path commands, or forward slashes (Node accepts `C:/…`). The
  orchestrators now emit POSIX-slash commands for this reason (`renderCommand`), so
  the trap is mainly for hand-typed paths. The `opentoken wrap` step-JSON mangling
  friction graduated to a command-class wrap policy — control-plane commands are
  wrap-exempt, encoded in the dispatch prompts + memory
  `opentoken-wrap-mangles-orchestrator-prompts`.
- **Fresh git worktrees lack `node_modules`.** A newly created worktree resolves
  `@audit-tools/shared` against a stale `dist/` → spurious "no exported member"
  type errors. Run `npm install` in the worktree before `npm run check`.
- **New default-on orchestrator behavior breaks existing fixtures.** Turning the
  dispatch canary on by default changed `prepare-dispatch` first-contact output
  and broke end-to-end fixtures that assumed a single-round, all-packets dispatch;
  the fix was seeding `dispatch.canary:false` in the test helper. Any new
  default-on behavior needs a sweep of existing fixtures, or should ship
  default-off until they catch up.
- **audit-code `node --test` needs the tsx loader.** Bare
  `node --test packages/audit-code/tests/*.test.mjs` fails with
  `ERR_MODULE_NOT_FOUND` because the `.mjs` tests import built `.ts` via `.js`
  specifiers. Use the canonical `node --import tsx/esm --test …`, as in the
  package's `test` script. This is a trap when running one test file by hand or
  telling a subagent to "run node --test".
- **The `Bash` and `PowerShell` tools share one working directory.** A `cd` inside
  a `Bash` call changes the directory the next `PowerShell` call runs in, so a
  later `npm run check -w packages/<pkg>` fails with *No workspaces found* because
  the path doubles. Use a subshell `(cd … && …)` in Bash, or pass absolute paths
  and `Set-Location` the repo root explicitly, rather than relying on per-tool CWD.
- **PowerShell block output cannot be piped inline after a `foreach` statement.**
  A shape like `foreach (...) { ... } | ConvertTo-Json` throws "An empty pipe
  element is not allowed"; assign the loop output first (`$out = foreach (...) {
  ... }`) and pipe `$out`.
- **Dirty remediation test files can mask block verification.** In shared
  worktrees, broad focused runs may fail on pre-existing edited tests unrelated to
  the block; record the broad failure and run the new/changed tests by name so
  worker evidence stays attributable.

## Deferred fixes (product bugs)

### audit-code + remediate-code: add a lightweight scope and intent checkpoint

Both orchestrators should confirm scope before expensive planning or multi-agent
dispatch. After deterministic intake, each tool should propose the scope it
intends to operate on, explain suspicious inclusions and exclusions, and let the
user accept the default or provide compact overrides. The default path should be
one low-friction confirmation, not an extended interview.

The checkpoint should combine deterministic checks with bounded LLM judgment over
the deterministically discovered intake. Deterministic intake can identify
folders, packages, generated outputs, vendored dependencies, build artifacts,
existing `.audit-tools` state, candidate input documents, finding severities,
lenses, and work-block counts. The LLM layer should reason about whether that
discovered shape looks like the intended product scope: e.g. whether
`node_modules`, `dist`, vendored code, archived experiments, scratch folders,
stale audit artifacts, or adjacent packages should be included, excluded, or
called out for the user's decision.

The prompt should receive a pre-digested scope summary, not a broad repo/report
dump. For audit-code, the proposal should cover repo/folder boundaries,
ignored/generated areas, selected lenses, and operator guidance such as "focus on
API contracts" or "skip tests." For remediate-code, it should cover selected input
documents/contracts, finding filters by severity/theme/package/lens, files or
packages that must not be touched, and free-form remediation intent. Persist the
accepted scope and user intent as a durable artifact, feed it into planning and
worker prompts, and include skipped scope in the final report so omissions are
explicit.

This checkpoint also subsumes the separate "ask for user approval for intake
object(s)" idea: even when a perfectly structured and non-stale
`audit-findings.json` exists, remediate-code should still propose candidate
inputs before planning. Prefer the canonical auditor contract when present, but
also look through `docs/` and similar folders for plausible remediation inputs,
summarize the candidates, and let the user add conversational direction.

### remediate-code host-dispatch gaps

- **Provider `queryLimits` is deferred because it has near-zero value today.** The
  canonical dispatch call site already treats an absent method and a `null` return
  identically (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so
  null-returning stubs change nothing at runtime. Revisit only if a provider gains
  a real proactive rate-limit endpoint. This belongs with heterogeneous,
  quota-aware dispatch.

### remediate-code: structured `audit-findings.json` fast path skips intake

Default input discovery prefers `audit-findings.json` over `audit-report.md`,
which is right because JSON is the source of truth. The remaining problem is that
structured input calls planning directly and bypasses the intake summary,
briefing, clarification, and scope gate. A clean "remediate everything" hand-off
is fine for small contracts, but a large contract gives the operator no chance to
choose "high severity only," filter by theme/package/lens, or exclude scratch
units.

Resolve this through the shared scope and intent checkpoint. Structured input
should stay lossless, but it should still allow selectable work blocks,
severity/theme/package filters, excluded paths, and conversational remediation
intent before `runPlanPhase`.

### remediate-code: `fileIntegrity` chokes on directory `affected_files`

A finding's `affected_files` entry can be a directory path (for example,
`packages/audit-code/schemas/`), and `checkFileIntegrity` tries to hash it as a
file, producing a non-fatal `EISDIR` error. Planning continues but the integrity
hash is silently absent for that item. Skip directory paths, recurse into them, or
normalize/reject directory `affected_files` during plan intake.

### remediate-code: implementation dispatch can produce an unworkable mega-block

`buildWorkBlocks` uses a file-based union-find, so hub files such as `cli.ts`,
`plan.ts`, `index.ts`, and `io/artifacts.ts` can transitively merge hundreds of
otherwise independent findings into one block. The implement phase dispatches one
worker per block to serialize edits to shared files, so a hub-heavy codebase can
produce a single prompt far beyond a model's practical apply budget.

The real write-conflict graph is usually sparse: most findings touch disjoint
files and can run in parallel; only hub-file conflicts need serialization. Fixes
to consider:

- cap block size and split large blocks into serialized sub-waves keyed on actual
  per-file conflict components
- budget implement prompts and page findings
- treat hub files as a dedicated serial lane while parallelizing the rest
- reuse the contract-governed `ImplementationDAG` model below, where tasks trace
  to obligations and parallelism is blocked only by real contract/file conflicts

### remediate-code: redesign implementation preview for clarity and rigidity

Standardize the preview across providers and IDEs by rendering a deterministic
format based on renamed tiers. Rather than asking the user to approve or deny only
tier 3 items, ask the user to identify any findings to ignore. Allow
conversational feedback, and include pros/cons for each finding so the user can
make an informed decision.

### audit-code: no way to re-synthesize a clean `audit-findings.json` after promotion

Synthesis promotes `audit-findings.json` to the repo root and prunes the
intermediate audit inputs, so a later deterministic synthesis fix cannot
regenerate the existing contract without a full re-audit. Consider an
`audit-code resynthesize` command that re-runs the deterministic synthesis tail
over an existing `audit-findings.json`, or retain the minimal inputs needed to
re-synthesize.

The command should cover deterministic tail work such as stable finding IDs,
work-block generation, schema validation, and markdown rendering. It should not
re-run semantic audit review.

### audit-code: fold pending `requeue_tasks` into the dispatch planner

`requeue_tasks.json` mandatory-coverage gaps with `status: pending` appear zero
times in `review_packets.json` and are never folded into `buildPendingAuditTasks`,
so some files and critical-flow test files are never re-audited. Folding
`bundle.requeue_tasks` into the pending set is loop-safe because requeue does not
gate `audit_tasks_completed`, and a dispatched task is excluded the next round via
`completedTaskIds`.

The change needs care: requeue tasks carry no `file_line_counts`, and the
first-contact generation path in `prepareDispatchArtifacts` writes pending tasks
without `addFileLineCountHints`. The fold-in must also hint line counts, or packet
`total_lines` and result validation will be wrong. This deserves a focused change
plus end-to-end dispatch validation.

### audit-code: confine auditor subagents to their assigned result paths

Review subagents should only emit results through `submit-packet`, which writes
the backend-assigned per-task result file under the run directory. In practice
they can scatter stray files across the workspace: ad-hoc packet result files at
the repo root, files with accidental names, and mangled Windows path filenames
created when bash eats backslashes in redirected absolute paths. `merge-and-ingest`
ignores these as spurious, so they do not corrupt audit state, but they pollute
the repo and could in principle clobber a real path.

The dispatch plan already carries each packet's `access.write_paths`, but that is
advisory unless the host can enforce per-subagent file access. Fixes:

- make packet prompts explicit that the only permitted write is through
  `submit-packet`, with no scratch/temp files outside the run directory
- where the host supports file-access restriction, pre-approve only the packet's
  write paths
- have workers pipe results to `submit-packet` over stdin, or write to a relative
  temp path inside the run directory, instead of constructing absolute shell
  redirection paths

Principle: an auditor should never be able to write a random file to a random
location.

## Features to add later

### Contract-governed implementation pipeline

Build a contract-governed planning path inside `remediate-code` for free-form
feature, implementation, and change requests. Put artifact shapes, traceability
types, and validation helpers in `@audit-tools/shared` only once both
orchestrators need them. Do not create a third package until the contract shapes
stabilize.

The product is not "an agent that writes code." It is an orchestration layer that
converts intent into artifacts that can be validated, attacked, repaired,
implemented, and traced.

#### Workflow boundary

Keep remediation and new implementation as separate user-facing entry paths, but
converge them into the same internal contract shape once intake is complete.

Remediation starts from a defect claim: "this is wrong." The source of truth is
an audit finding, user feedback item, failing behavior, or other issue claim. The
early questions are whether the finding is valid, what fix satisfies it, and
which evidence proves the defect is resolved.

New implementation starts from intent: "build this." The source of truth is the
user goal plus repo conventions. The early questions are what the goal means,
what behavior is in scope, what design should exist, and which acceptance
criteria prove success.

After normalization, both should flow through the same core artifacts:

```text
remediation finding -> GoalSpec -> DesignSpec -> ObligationLedger -> ImplementationDAG
new idea request    -> GoalSpec -> DesignSpec -> ObligationLedger -> ImplementationDAG
```

The distinction is a soft boundary around intake and product framing, not a hard
boundary in implementation machinery.

#### Core pipeline

Treat LLM output like raw input: useful, but untrusted until normalized and
validated.

```text
User goal
  -> GoalSpec
  -> ContextBundle
  -> Candidate DesignSpec
  -> Conceptual Design Critique
  -> DesignSpec
  -> ObligationLedger
  -> Contract Assessment
  -> Critic Counterexamples
  -> Judge Classification
  -> Repair Obligations
  -> Implementation DAG
  -> Bounded Implementation
  -> Verification Report
```

Every transition writes an artifact. Downstream artifacts are stale when any
upstream dependency changes. Every invocation does exactly one bounded step.

#### Product principles

1. Every important requirement, invariant, side effect, and risk becomes a
   traceable artifact.
2. No implementation task exists without traceability to a requirement,
   invariant, or accepted counterexample.
3. Deterministic validators run before LLM critics and before implementation.
4. Conceptual critique may propose better designs, but accepted changes must be
   reflected in the contract before implementation.
5. Critics produce concrete counterexamples, not vague concerns.
6. Accepted counterexamples repair the contract first, then generate tests or
   validators, then generate implementation work.
7. Implementation proceeds one bounded task or wave at a time.
8. Completion requires a verification report that maps requirements, invariants,
   counterexamples, tasks, changed files, and command evidence.

Non-goals:

- do not infer project architecture from the user goal alone
- do not allow unstructured design prose to drive implementation
- do not accept "tests pass" as sufficient proof of completion
- do not use an LLM when a schema, graph check, command, or validator can decide
- do not ask the user for choices already settled by repo conventions or the
  standing decisions log

#### Assessment terminology

Avoid the bare phrase "design assessment" when a prompt or artifact needs
precision. There are two distinct modes:

- **Contract assessment** asks whether the design has clear modules, trust
  boundaries, side-effect owners, invariants, failure semantics, and verification
  obligations. It is concrete, traceable, and mostly deterministic. Its output can
  become audit findings, repair obligations, or implementation tasks.
- **Conceptual design critique** asks whether the design is good, coherent,
  elegant, strategically aligned, philosophically sound for the project, and
  whether there are better ways to solve the problem. It is creative and
  comparative. Its output becomes adopted design changes, explicitly deferred
  ideas, or residual risks; it must not silently mutate the contract.

For audit-code, contract assessment finds missing or broken obligations in the
existing system. Conceptual design critique evaluates the larger architecture,
taste, philosophy, and possible better directions. The depth of conceptual design
critique should eventually be operator-selectable: shallow can mean one
large-context critic; deep can mean multiple independent critics followed by a
synthesis step.

#### Artifact layout

When embedded in remediate-code, prefer:

```text
.audit-tools/
  remediation/
    contract/
      goal_spec.json
      context_bundle.json
      candidate_design_spec.json
      conceptual_design_critique.json
      design_spec.json
      obligation_ledger.json
      contract_assessment_report.json
      counterexamples.json
      judge_report.json
      repair_obligations.json
      implementation_dag.json
      task_results.jsonl
      verification_report.json
      verification_report.md
      steps/
        current-step.json
        current-prompt.md
```

If this later becomes a standalone implementation workflow, the same artifact
names can move under `.audit-tools/implementation/`. The artifact names and
dependency relationships should remain stable.

All IDs are stable strings. IDs should be deterministic where possible, such as
`REQ-001`, `INV-001`, `CE-001`, and `TASK-001`.

#### Artifact contracts and gates

- **`GoalSpec`** normalizes user intent before design work starts. It contains
  objective, requirements, non-goals, constraints, acceptance criteria, ambiguity
  log, and source summary. It is invalid if a `must` requirement has no
  acceptance criterion, an acceptance criterion verifies no requirement, or a
  `needs_user` ambiguity blocks design.
- **`ContextBundle`** captures the repo context the design must obey. It names
  modules, public APIs, schemas/types, state owners, tests, critical flows,
  commands, conventions, constraints, and evidence. Design cannot begin unless
  named modules, tests, and public surfaces have evidence refs.
- **`Candidate DesignSpec`** drafts the design before conceptual critique. It
  defines module responsibilities, inputs, outputs, validation boundaries, side
  effects, dependencies, invariants, failure modes, risks, and requirement
  traces. It is not yet the implementation contract.
- **`ConceptualDesignCritique`** evaluates whether the candidate is the right
  design. It contains philosophy assessment, alternatives, recommendations,
  adopted recommendation IDs, deferred ideas, and residual risks. `must`
  recommendations must be adopted into `DesignSpec` or explicitly rejected with
  rationale before contract assessment.
- **`DesignSpec`** becomes the implementation contract. It defines modules, data
  flows, invariants, side effects, dependencies, risks, and requirement trace
  links. Every boundary answers: what is raw or untrusted, what is validated, and
  what type or value proves it.
- **`ObligationLedger`** maps claims to executable verification obligations. It
  contains test, schema, validator, typecheck, lint, runtime-command, or
  manual-review obligations. No requirement, invariant, side effect, accepted
  counterexample, or implementation task may be orphaned from this ledger.
- **`ContractAssessmentReport`** checks whether the design is complete enough to
  attack and implement. It contains checks, blocking issues, warnings, and
  `complete`. Blocking issues become repair obligations. `complete` must be true
  before adversarial counterexample review or implementation task generation.
- **`Counterexamples`** records concrete attacks against design claims. Each
  counterexample names the exact claim being attacked, gives a scenario and
  evidence, states impact, and suggests contract repair. Vague risks are rejected
  by schema or judge policy.
- **`JudgeReport`** classifies counterexamples as `accepted`, `out_of_scope`,
  `duplicate`, `invalid`, or `residual_risk`. Accepted counterexamples must name
  required contract repairs.
- **`RepairObligations`** bridges accepted counterexamples back into the
  contract. It produces changed design and obligation-ledger entries before tasks
  are generated, preserves IDs where meaning is unchanged, and adds trace links
  to accepted counterexamples.
- **`ImplementationDAG`** plans bounded implementation work. It contains tasks
  with purpose, trace links, likely files, preconditions, expected changes,
  verification obligation IDs, dependencies, and max scope. No task may lack
  traceability, and no cross-module task may run in parallel with another task
  touching the same contract surface.
- **`TaskResults`** records bounded implementation outcomes. Each result records
  changed files, commands run, passing/failing evidence, deviations, and blockers
  for one task or wave. Failed verification leaves work resumable or blocked
  without marking unrelated obligations complete.
- **`VerificationReport`** proves completion. It maps requirements, invariants,
  accepted counterexamples, implementation tasks, changed files, and commands to
  evidence. `complete=false` if any `must` requirement, invariant, accepted
  counterexample, or task lacks passing evidence.

#### Contract assessment gates

Run these checks before the critic and again before implementation. Most should
be deterministic; any LLM assistance must be bounded to explaining or repairing a
failed check.

- every module has inputs and outputs
- every input that accepts raw data has a validation boundary
- every side effect has exactly one owner
- every invariant has a verification obligation
- every requirement has at least one acceptance criterion
- every acceptance criterion traces to a requirement
- every external dependency has failure semantics
- no raw data crosses a trusted boundary
- every implementation task traces to a requirement, invariant, or accepted
  counterexample
- every task verification entry points to an obligation
- stale downstream artifacts are refreshed before use

#### Conceptual critique gates

Run conceptual design critique after a candidate design exists and before the
design becomes the implementation contract. The critique should ask:

- is this design aligned with the project's stated philosophy?
- is the project philosophy itself coherent for the goal?
- is there a simpler, more durable, or more expressive design?
- are there better module boundaries or user-facing concepts?
- are we preserving an existing pattern that should be challenged?
- are we introducing accidental complexity to satisfy a local concern?

Conceptual critique is allowed to be imaginative. It is not allowed to bypass
traceability. Adopted recommendations must be reflected in `DesignSpec`;
deferred ideas must be recorded as deferred ideas or residual risks.

#### Orchestration obligations

The next-step selector should prefer the highest-priority valid obligation:

1. repair invalid state
2. normalize or refresh `GoalSpec`
3. collect or refresh `ContextBundle`
4. produce or refresh candidate `DesignSpec`
5. run conceptual design critique
6. adopt, reject, or defer conceptual critique recommendations
7. finalize or refresh `DesignSpec`
8. produce or refresh `ObligationLedger`
9. run contract assessment
10. dispatch critic counterexample review
11. classify counterexamples
12. repair accepted counterexamples
13. generate or refresh `ImplementationDAG`
14. implement the next ready bounded task or task wave
15. run targeted verification
16. run closing verification
17. render `VerificationReport`
18. report completion or blockers

Every invocation should do exactly one bounded step.

#### Agent prompt roles

Prompts should be rendered from artifacts and schemas, not copied as long
free-form prose. Each role receives only the artifacts it needs plus the relevant
repo files.

- **Goal normalizer:** create only valid `GoalSpec` JSON. Preserve user intent,
  separate requirements from non-goals, derive acceptance criteria, and log only
  ambiguities where reasonable engineers could build materially different
  behavior. Do not design code.
- **Context collector:** create only valid `ContextBundle` JSON. Ground every
  module, API, schema/type, state owner, test, command, convention, and constraint
  in evidence. Do not propose implementation changes.
- **Designer:** create only valid candidate `DesignSpec` JSON from `GoalSpec` and
  `ContextBundle`. Define responsibilities, boundaries, side effects,
  dependencies, invariants, failure modes, and requirement traces. Do not
  generate tasks.
- **Conceptual design critic:** create only valid `ConceptualDesignCritique`
  JSON. Challenge the design creatively and comparatively while staying grounded
  in the goal, context, repo philosophy, and standing decisions. Do not rewrite
  the design.
- **Conceptual critique resolver:** adopt, reject, or defer every critique
  recommendation, then produce the final `DesignSpec` and a disposition summary.
  Adopted recommendations must be reflected in the contract; deferred ideas must
  not become hidden obligations.
- **Obligation planner:** create only valid `ObligationLedger` JSON. Map every
  requirement, invariant, side effect, and design risk to executable verification
  where possible.
- **Contract assessor:** create only valid `ContractAssessmentReport` JSON.
  Prefer deterministic checks, cite evidence, and emit blocking issues for
  missing or contradictory obligations. Do not propose broad alternative designs
  or tasks.
- **Critic:** create only valid `Counterexample[]` JSON. Attack specific claim IDs
  with concrete scenarios, evidence, impact, and suggested contract repairs.
- **Judge:** create only valid `JudgeReport` JSON. Accept plausible in-scope
  violations even when repair is inconvenient. Accepted counterexamples must name
  repairs.
- **Contract repairer:** update `DesignSpec` and `ObligationLedger` so every
  accepted counterexample is repaired by a changed invariant, boundary, failure
  mode, side-effect rule, test, schema, validator, or command.
- **Task planner:** create only valid `ImplementationDAG` JSON. Split unrelated
  modules or invariants, list likely files and expected changes, and link every
  task to verification obligation IDs.
- **Implementer:** implement exactly one ready task or bounded wave. Add or update
  tests, validators, schemas, and code needed for that task's obligations. Run
  targeted verification and return a `TaskResult`.
- **Closer:** create `VerificationReport`. Map every requirement, invariant,
  accepted counterexample, task, file change, and command to evidence. Mark
  incomplete when required evidence is missing or failing.

#### MVP build sequence

Build the pipeline in slices that each preserve the one-step contract.

1. **Contracts and schemas.** Add TypeScript types, JSON Schemas, validation
   helpers, and traceability tests for `GoalSpec`, `ContextBundle`, `DesignSpec`,
   `ConceptualDesignCritique`, `ObligationLedger`, `ContractAssessmentReport`,
   `Counterexample`, `JudgeReport`, `ImplementationDAG`, and
   `VerificationReport`. Invalid orphan claims fail validation; valid minimal
   artifacts pass; schema and TypeScript contracts agree on required fields.
2. **Artifact store and staleness.** Add read/write helpers, a dependency map, and
   stale-artifact detection. Changing `GoalSpec` stales all downstream artifacts;
   changing `ContextBundle` stales candidate design, critique, final design,
   obligations, assessment, counterexamples, DAG, tasks, and verification;
   changing candidate design stales critique and final design; changing final
   design stales obligations, assessment, counterexamples, DAG, tasks, and
   verification. Incomplete runs resume from durable artifacts.
3. **Next-step selector.** Add obligation selection for the priority order above,
   return backend-rendered prompt contracts for LLM steps, and run deterministic
   validation without LLM dispatch. Each invocation chooses one bounded valid step,
   and invalid upstream state blocks downstream work.
4. **Prompt renderers.** Render prompts for each role with required input artifacts
   and expected output schemas. Prompt snapshots should include relevant artifact
   IDs and schema names, and no prompt should ask an agent to complete multiple
   pipeline phases.
5. **Implementation task execution.** Convert ready `ImplementationDAG` tasks into
   bounded implementation prompts, run targeted commands attached to verification
   obligations, and persist task results as JSONL. A task cannot complete without
   evidence for its verification IDs; unrelated tasks remain untouched.
6. **Closing report.** Aggregate requirement, invariant, counterexample, task,
   file, and command evidence. Render `verification_report.json` and a
   human-facing Markdown report. Completion is true only when all required traces
   are satisfied; residual risks are explicit and attributable.

#### Integration with audit-code

In audit-code, use this pipeline in an observational posture. The auditor should
discover and attack existing or implied contracts; it should not turn the whole
implementation pipeline into an audit run.

Recommended fit:

```text
audit-code:
  discovers existing contracts
  extracts implied invariants and trust boundaries
  runs contract assessment against the current repo
  uses adversarial counterexamples as audit evidence
  reports missing obligations, broken invariants, and residual risks
```

Strong integration points:

- structure and graph enrichment infer modules, public surfaces, state owners,
  side effects, critical flows, and trust boundaries
- contract assessment checks validation boundaries, side-effect ownership,
  failure semantics, and verification obligations
- audit planning generates tasks from contract gaps, not only from files and
  lenses
- adversarial review asks reviewers for counterexamples against inferred claims
  and invariants
- coverage accounting tracks which critical invariants were verified, not only
  which files and lenses were reviewed
- synthesis distinguishes bugs, contract gaps, missing verification obligations,
  accepted counterexamples, conceptual critique findings, and residual risks

Conceptual design critique can also fit the auditor as a separate optional lane.
Its output is not the same as a defect finding; report it as design critique,
recommended direction, deferred idea, or residual strategic risk.

#### Integration with remediate-code

For free-form remediation or feature requests, insert the contract pipeline
before the existing `document -> implement -> close` flow:

```text
plan
  -> contract-goal
  -> contract-context
  -> candidate-design
  -> conceptual-design-critique
  -> final-design
  -> contract-obligations
  -> contract-assessment
  -> contract-critic
  -> contract-repair
  -> implementation-dag
  -> document/implement/close
```

Auditor-produced `audit-findings.json` can keep its deterministic fast path, but
it should still pass through the scope and intent checkpoint. The full contract
pipeline is most valuable when input is a user goal or free-form change request
rather than a structured finding contract.

#### Completion definition

The pipeline is complete only when:

- `GoalSpec`, `ContextBundle`, `ConceptualDesignCritique`, `DesignSpec`,
  `ObligationLedger`, `ContractAssessmentReport`, `ImplementationDAG`, and
  `VerificationReport` are valid and current
- every `must` requirement has passing evidence
- every adopted conceptual recommendation is reflected in the final design
- every invariant has an enforced obligation
- every accepted counterexample is repaired or recorded as residual risk
- every implementation task is terminal
- all required verification commands pass
- the final report records changed files, command evidence, residual risks, and
  traceability

If any condition fails, the run remains incomplete and resumable state is
retained.

### User-selected lenses

Let the operator choose which audit lenses run instead of always running the full
set. Consider having a base set of lenses that always run so obligations requiring
multiple perspectives are still satisfied.

### Heterogeneous multi-agent dispatch

Build on `computeDispatchCapacity({ pools, pendingItemTokens })` in
`@audit-tools/shared`, which sizes dispatch just in time and sums concurrent slots
across `CapacityPool`s. Remaining work toward a heterogeneous fleet:
per-packet provider assignment, partitioning `pendingItemTokens` across pools,
host-model detection, and building a real second pool such as an IDE model or
another CLI provider.

### Right-size LLM context and limit unnecessary conversation output

Agents should get everything needed for their bounded obligation and no more.
Deterministic artifacts should pre-digest repo shape, contracts, evidence, file
lists, constraints, and scope decisions into task-specific packets instead of
handing workers broad repo/report dumps. Many agents also emit multiple visible
steps describing their discovery of project principles. Where possible, condense
steps to eliminate round trips, perform actions via the mechanical backend, and
keep both prompts and visible conversation output focused on the work at hand.
