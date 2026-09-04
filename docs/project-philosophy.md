# Project philosophy — the organizing picture

A single **map** of the convictions that shape audit-tools, split by what they govern. It exists to give
one orienting read of the whole philosophy; it does **not** replace the canonical homes. Each principle's
authoritative statement lives where the doc-philosophy routes it — `CLAUDE.md` (policy/conventions/how-to),
`spec/` (architecture/design), `docs/documentation-philosophy.md` (docs governance), or project memory
(cross-session facts). This map states each conviction in one line and points at its home; when this map
and a home ever disagree, **the home wins**.

**The brief below is the single source for every condensed restatement of this philosophy.**
`README.md`'s "Philosophy" section is GENERATED from its *Product* half (`npm run
check:philosophy-brief -- --write`; the gate fails the build when the two drift), and the
`question-philosophy-gate` hook injects the whole brief when a question is about to reach the owner.
Edit a conviction here and both follow; never hand-edit the README block, and never copy these lines
into a third place.

> **Two kinds of philosophy — kept separate on purpose.**
>
> **PART A — governs the PRODUCT ITSELF.** What audit-tools *is* and how it behaves as a tool: architecture,
> contracts, invariants, design convictions. These hold no matter who builds it.
>
> **PART B — governs DEVELOPMENT of the project.** How the work gets done: working style, agent
> collaboration, code/repo discipline, docs governance, ship process. These are about *building*
> audit-tools, not about what the built thing does.
>
> A **bridge** section names the few convictions that genuinely live in both.
>
> ⚑ marks convictions that are *commonly misstated* — the map records the correct form because the wrong
> form keeps recurring.

---

# THE BRIEF — the whole philosophy in two dozen lines

The condensed form, in plain register with no internal citations, so it can be read by someone outside
the project and by an agent mid-decision. It is not a summary *of* the map below — it is the canonical
short statement, and the map is where each line is argued. When the two disagree, the fuller section
wins on nuance; the brief must then be corrected, not left as a second opinion.

<!-- BEGIN philosophy-brief — the README's Philosophy section is generated from the Product half -->

**Product — what audit-tools is.**

- The tool must be trustworthy even when the host agent is weak. Correctness is guaranteed by the tool,
  never by the host being careful or clever.
- Use mechanical, deterministic tools wherever one does the job as well as or better than a model.
- Use LLM judgment where it clearly lifts quality — bounded, scoped and recorded. The project is not
  "100% deterministic", and it is not trying to be.
- Whatever *can* be enforced in tooling *must* be, regardless of who does the work — at a boundary the
  gate actually owns. A gate states where it is authoritative, and one that guesses at a boundary
  belonging to something else is moved to the boundary that owns it, never left guessing.
- Don't grade your own homework: anything important or complex gets an independent adversarial check
  that is allowed to refuse.
- Keep tasks tightly bound and well defined, so the gap between weak and strong models shrinks.
- Batch work into logical units of reasonable size — rigor balanced against token cost, not 100 agents
  for 100 files.
- Keep everything IDE-, provider-, model-, OS-, shell- and language-agnostic: outside the product
  contract or abstracted, never baked in. The host owns semantic execution; audit-tools detects repo
  structure and normalizes analyzer output into shared contracts, never forks planning per ecosystem.
- Auditing and remediating are not two tools — they are two cases of ONE logical core, drawn read-only or
  write-and-apply. The boundary between them is continuously being dissolved, and re-introducing it is the
  most persistent mistake made against this project; a difference between the two is a policy axis of the
  shared core, almost never a reason to fork it.
- Auditing produces findings, remediation consumes them and fixes. The machine contract is the source of
  truth; the human report is its render.
- Nothing runs to completion in a single call. Each invocation does a bounded, persisted piece of work,
  so a run is resumable, parallelizable and failure-isolated.
- Scale the process to the work — depth and granularity are dials on one pipeline, never a separate
  lighter path.
- Artifacts are continuity: staleness propagates along an explicit dependency map, never ad-hoc
  freshness checks.

**Working — how the work gets done.**

- Ideal code over compatibility; delete legacy rather than carry it. Effort, complexity and refactor
  size are NOT costs — only the endpoint matters. Correctness is the only thing that gates pace.
  What lands on `main` is still the atomic replace; a temporary internal seam may exist BETWEEN
  COMMITS ON A BRANCH, provided it is gone before that branch merges and every commit is green.
- Ask on genuine ambiguity, and batch the questions. Never silently pick a default, and never quietly
  defer a decision that is the owner's.
- A needed manual flag, or a fix that amounts to "be careful next time", is a bug signal — move the
  friction into the tool instead.
- One home per fact. Single-source and extract rather than keeping two copies honest with a drift test.
- Deliverables land in a file; chat gets the path and a short digest, never the deliverable itself.
- Green at every commit, and every regression test is red-green validated before it is trusted.
- End-of-sprint cleanup runs unprompted, and every remaining step is stated with the document it lives
  in — a step that lives only in chat is lost.
- Docs capture durable concepts, not current state. Absence of a thing is not staleness. Semantic
  document review scales to what changed — the changed documents, their declared dependents, and a
  periodic sweep — never the whole corpus every pass. The end-of-sprint closeout does NOT scale: it
  runs whole, every sprint.
- Front-load the broad prior-art search before authoring anything — narrow scope is the top churn driver.
- Log friction the moment you hit it, in all its categories, without being asked.

<!-- END philosophy-brief -->

---

# PART A — governs the PRODUCT ITSELF

## The product's North Star

**The tool must be trustworthy even when the host agent is weak.** The host/auditor is a variable of any
strength, not a constant — so every correctness property is guaranteed by the tool, not by the host being
smart. Everything in Part A radiates from this. *(home: `CLAUDE.md` → auditor-agnostic robustness)*

## A1. Core architecture & workflow  ⚑

- **ONE logical core; auditing and remediating are two CASES of it.** ⚑ Not two tools that happen to
  share a library — one body of logic, *drawn* read-only (audit) or write-and-apply (remediate). The
  project is continuously **dissolving** the boundary between them, and re-introducing that boundary is
  the most persistent agent error there is: a careless pass "restores" it every time it treats a
  divergence as two domains rather than as one core with a policy axis. A genuine *category* difference
  (two different KINDS of operation) is rare; "it would become a config-shell with several knobs" is not
  a fork justification — a several-knob shared core is the correct endpoint, and it is what stops the
  two sides drifting. Legitimately per-case: only genuinely different INPUT, or the terminal
  result-routing adapter. Never the algorithm.
- **Each case emits the same shapes.** audit → findings contract; remediate → consumes + fixes. Both emit
  a machine contract (JSON, source of truth) + human render (md).
- **Obligation-driven, bounded per invocation (fold-aware drain).** Neither tool runs to completion. Each
  `next-step` derives state and drains the deterministic obligation frontier — highest-priority-first,
  folding successive bounded steps into the one call — persisting each, and halts at the first host-input
  pause, non-drainable step, or drain ceiling. "Bounded" is the fold-aware drain, not one obligation per
  call: no invocation finishes the run or crosses a host-input boundary → resumable, parallelizable,
  failure-isolated.
- **Orchestrate by priority, not a state machine.** Prefer validity over speed, deterministic over
  inferential, upstream over downstream, bounded over sweeping.
- **Artifacts are continuity; the dependency DAG is truth.** Staleness propagates along an explicit
  dependency map — never ad-hoc freshness checks.
- **Right-sized context.** Pre-digest scope/contracts/evidence into small obligation-specific packets;
  expand only when needed.
*(home: `CLAUDE.md` → Concepts; `spec/audit/orchestration-policy.md`, `spec/audit/dependency-map.md`)*

## A2. Right tool, not deterministic dogma  ⚑

**The project is NOT "100% deterministic"** — the recurring agent error. Three rules, balanced
case-by-case: (1) where a mechanical tool does the job as well or better → use the tool; (2) where a bit of
LLM judgment *strongly* lifts quality → use the LLM, bounded and recorded; (3) whatever *can* be enforced
in tooling *must* be. Rules (1)/(2) choose *who* does the work; rule (3) constrains *how* the result is
guaranteed.
- **LLM always in the loop.** Conversation-first ⇒ the host agent supplies every semantic judgment;
  never gate LLM review behind an audit-tools provider probe or internal launch capability.
  *(home: `CLAUDE.md` → Conventions & invariants)*
- **Resolve toward the durable contract.** LLM-vs-deterministic → deterministic; graph/language →
  language-neutral. *(home: `CLAUDE.md` → Preferences & standing decisions)*

*(home: `CLAUDE.md` → Concepts)*

## A3. Enforce robustness in tooling, never host discretion

Every in-boundary correctness property must be guaranteed by the tool — CLI option shape, contract validator,
renderer template, workload binding, dependency frontier, merge tolerance, write-scope enforcement. Any place
the workflow only works because a capable host *remembered / noticed / relayed / picked the right id /
verified from disk / hand-fixed a break* is a **latent failure mode** → move it into the tool. Backend choice,
concurrency, retries, and transport are deliberately host-owned; audit-tools guarantees that the emitted
workload is complete and that returned results cannot escape or forge its bindings.
"Be careful" / "my side" is never a fix; **a needed manual flag is a bug signal.**
*(home: `CLAUDE.md` → Conventions)*

## A4. Everything-agnostic by default

Provider/backend, host IDE/agent, **OS/platform**, model, shell, language/ecosystem — outside the product
contract or abstracted, never baked in. The named rules are *instances of one principle*, not a closed list.
- **Model/provider/IDE agnostic:** audit-tools owns no provider roster, model/window/price table, capability
  tier, execution adapter, or discovery path. The host owns those facts and choices; the workload carries
  only content-derived scope, complexity, risk, and token estimates.
- **Language-neutral by contract:** graph edges `from`/`to`/`kind` (+optional `direction`/`confidence`/
  `reason`); new analyzers *enrich* shared artifacts, never fork planning.
- **OS/platform-agnostic:** no platform-baked path/shell/command/line-ending assumptions in core logic;
  route through the existing abstractions. Windows-aware is the most-exercised instance, not the boundary.
*(home: `CLAUDE.md` → Conventions)*

## A5. Conversation-first  ⚑

The product IS the slash workflow inside the host conversation; the CLI is backend/fallback. Normal usage
carries no manual `--root`/provider/model flags. **Conversation-first means semantic workers belong to the host**
(which already reads arbitrary files by context) — the correct framing when a robustness argument tempts
over-caution about what the worker may read. **Conversation-first subagent execution is first-class**:
a user with a subscription but no API credits gets the full experience via host-spawned subagents, while
audit-tools emits and ingests the same provider-neutral files regardless of host.
*(home: `CLAUDE.md` → Concepts; memory: conversation-first-subagent-dispatch-first-class)*

## A6. Self-scaling pipeline, not forked paths

Scale the *process* to the work; don't fork the *path*. Two continuous dials — **adversarial depth** (floor
light, never off) and **phase granularity** (degenerate phases collapse by structure). Signal assessed
cheaply at intake (affected-file count + path-risk patterns + intent), re-assessed on evidence. Escape
hatch: optimistic-start, escalate-on-evidence. Explicitly ONE pipeline, *not* a separate lean path.
*(home: `spec/self-scaling-pipeline-design.md`)*

## A7. Contract-authoring determinism

**Tool owns structure, IDs, cross-refs, derivation, validation; the LLM authors only irreducible *judgment*
in small pre-scaffolded, write-validated slots.** The conceptual design review is the ONE place to lean
INTO judgment.
- **Split design assessment into two named modes:** *contract assessment* (invariants/boundaries) vs.
  *conceptual design critique* (philosophy/alternatives). Bare "design assessment" is too ambiguous.
- **Delegate adversarial phases to a separate agent** — an author marking own homework misses gaps.
- **Handoff = enforcement ⟂ execution ⟂ judgment:** mechanical contract builder/validator → host-owned
  execution → bounded judgment at named seams.
*(home: "Split design assessment" → `CLAUDE.md` → Preferences; memory:
delegate-adversarial-phases-to-separate-agent)*

## A8. How the tool decomposes & hands off work

- **Remediator must decompose + boundary-enforce** — the tool mechanically breaks multi-goal scope into
  bounded parallel units + boundary tests + scheduling deps, not force the host to phase by hand.
- **Decomposition co-locates source + its tests** — each node owns its source AND the tests pinning it
  (separate source/test nodes deadlock).
- **Parallel host execution over overlapping files is OPTIMISTIC, with git as the correctness authority** —
  two nodes may edit one file; the serialized accept-time cherry-pick decides collisions, and a
  wrongly-admitted pair conflicts at rebase → quarantine → retry off updated HEAD. Pre-declared
  per-file edit-region ownership was falsified: disjointness cannot be proven at decomposition time,
  so proving it would be LLM judgment where the goal is enforcement in tooling.
*(home: this brief — no other doc owns these three. The mechanisms are
`src/remediate/steps/contractPipeline.ts` (decomposition into nodes) and
`src/remediate/steps/dispatch/hostHandoff.ts` (write-scope binding + accept-time collision).)*

## A9. Multi-agent cooperative runs

Arbitrary host agents and IDEs may contribute to the SAME audit/remediation (JOIN, not isolate) — symmetric
peers, no primary/secondary. Safety comes from persisted workload/result bindings + idempotent ingestion —
no claim registry, lease, or per-IDE namespace.
*(home: `spec/multi-ide-concurrent-runs-design.md`)*

## A10. Analyzers & dependencies (the product's ingestion of external tools)

- **Own-vs-acquire; agnostic engine over a fixed bundle.** Own only truly-agnostic extractors (git-mining);
  acquire ecosystem-native tools — secret-scan (gitleaks) among them — dynamically + normalize via an
  adapter seam. Gate =
  mechanical run-safety + curated default set + per-run consent, NOT a maintained allowlist.
- **Two-tier dependency policy.** Import vetted pure-JS libs for correctness-sensitive parsing/schema/lock
  (`smol-toml`, `yaml`); own only tiny domain bits; wrap parsers so malformed input degrades to empty.
*(home: Own-vs-acquire → `CLAUDE.md` → Preferences (promoted), with the live contract in
`src/shared/analyzers/acquisitionEngine.ts` and the open live-spawn track in
`docs/backlog/forward-tracks.md`; Two-tier dependency policy → `CLAUDE.md` → Preferences;
memory: deterministic-analyzers-own-vs-acquire)*

## A11. Content sizing & the host execution boundary (product behavior)

- **Token estimates stay local and deterministic** — never API-call token counting; shared
  `estimateTokensFromBytes` is the standard. The estimate describes content size, not backend fit.
- **audit-tools does not execute or route semantic work** — it emits complete prompt-bound workloads
  with content-derived complexity, risk, scope, and token estimates. The host alone owns backend/model
  selection, concurrency, retries, context-window fit, transport, and quota.
*(home: `CLAUDE.md` → Preferences & standing decisions; `spec/audit-workflow-design.md`;
`spec/remediation-workflow-design.md`)*

---

# PART B — governs DEVELOPMENT of the project

About *how the work is done* — the agent's collaboration norms, code/repo discipline, docs governance, and
ship process. They'd change if the developer or workflow changed; they don't describe what audit-tools does.

## B1. Working style & collaboration with the agent

- **Ideal code over compatibility** — sole consumer → cleanest design, delete legacy. **Effort /
  complexity / refactor-size is NOT a cost** — only the eventual endpoint matters. Never defer or pick a
  lighter half-measure because the ideal is "a lot of work." Correctness is the only pace gate.
- **Ask on ambiguity, don't defer silently** — genuine owner-call + unclear preference → ASK (batch);
  never pick a default or silently defer.
- **Proportionality-defer needs a user signal** — "rare / only if it bites" is an assumption; name it and
  weight hands-on operational signal over an a-priori guess.
- **Caveman mode (full) active globally** — ultra-compressed telegraphic prose; keep technical precision
  (paths/commands/versions/line-refs). Owner toggles off when clarity needed.
- **Deliverables always land in a file** (repo doc or artifact dir); chat gets path + digest, never
  chat-only. *(home: `CLAUDE.md` → Preferences (ideal-code, caveman); global `~/.claude/CLAUDE.md`
  (Deliverables, caveman); memory: ask-on-ambiguity-dont-defer-silently,
  proportionality-defer-needs-user-signal — the ask/defer pair lives in memory, not repo `CLAUDE.md`)*

## B2. Ship-pipeline ownership

**The agent owns the ship pipeline** — commit → push → merge → publish → verify-live → reinstall global
bins, end-to-end by default. Never park at the push/publish boundary. Hand back only for destructive
ambiguity. Encoded in the `/ship` skill (CRLF clean-tree guard, allow-scripts
postinstall, release-CI-is-the-real-signal). *(home: `CLAUDE.md` → Release & publish; global `~/.claude/CLAUDE.md`)*

## B3. Code & repo discipline

- **Green-at-every-commit** — before any push `npm run build && npm run check` → zero errors (hook-enforced).
- **Atomic-replace ordering invariant** — every destructive change ships as a single atomic replace (new
  mechanism + deletion in one commit); never add-then-delete across commits.
- **Dead-code release gate = default-mode knip** (not `--production`, which false-positives on registry/
  alias wiring); tested-but-unwired is a periodic manual grep-zero sweep.
- **One core, two draws — the build-side consequence of A1, not a second statement of it.** Because there
  is one logical core (A1), the default is one shared core + per-mode policy/draw, never two forks kept
  "in parity": single-source the common logic in `audit-tools/shared`, each orchestrator a thin
  policy-selecting adapter — so a fix in one usually belongs in both.
- **Prefer extraction over drift-tests** — single-source two copies instead of guarding them with a drift
  test; make drift impossible. *(home: `CLAUDE.md` → Conventions/Preferences for the other B3 bullets;
  memory: prefer-extraction-over-drift-tests — not yet in CLAUDE.md)*

## B4. End-of-sprint cleanup (standing, unprompted)

The closeout runs at every sprint-end (pause/handoff/milestone), unprompted, and it runs WHOLE — it does
not scale down with the change, and there is no lightweight variant. The conviction is that; the steps
themselves are deliberately NOT restated here, because a third hand-written copy is the drift this
section's own B3 sibling forbids. *(home: *Closing out work* in
`~/.claude/portable-engineering-principles.md` for the schema; `CLAUDE.md` → Conventions for this repo's
bindings and the renderer)*

## B5. Documentation governance

- **Docs capture durable concepts, not current state** — timeless *why* and *contract* only; changelog/
  status/dated-narrative doesn't belong. Absence of a thing is not staleness.
- **One home per concept** — duplication across homes is drift; a fact belongs in its most-durable home and
  is referenced, not copied, from others.
- **Condensation bias** — fewer, denser, timeless docs; enforced by a doc-manifest gate + nightly review.
- **Universal host prompts, single-sourced** — ONE canonical prompt body rendered per-IDE, never per-IDE
  prose. *(home: `CLAUDE.md`, Conventions & invariants)*

## B6. Backlog & friction hygiene

- **Disambiguation completes or leaves** — a pass ends an item fully specced OR left as-is; never
  half-specced with residual open sub-questions (churn).
- **Front-load broad prior-art search before contract authoring** — search the *whole* repo for equivalent
  logic AND independently re-verify the target symbol's own type/shape. Narrow scope is the top churn driver.
- **Log friction the moment you hit it** — full friction walk each loop lap; log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) durably to backlog, unprompted; don't
  trust the empty mechanical set. *(Only "log friction" is homed in `CLAUDE.md` → Known friction &
  deferred fixes; "disambiguation completes or leaves" is homed in
  [`.claude/skills/disambiguate-backlog/SKILL.md`](../.claude/skills/disambiguate-backlog/SKILL.md) →
  Hard rules ("No half-specced write-backs"); "front-load broad search" is memory-only.
  Memory: front-load-broad-search-before-contract-authoring, log-all-friction-categories-every-lap)*

---

# BRIDGE — convictions that live in BOTH

A few principles are the *same taste* pointed at the product and at the dev process — named once here so
they aren't double-counted:

- **"One logical core, two cases" (A1)** is a product truth AND a build rule (B3): the product is one
  core drawn two ways, and the codebase must therefore be one core with per-mode policy, never two forks
  in parity. It is listed in both places because the boundary gets reinstated from both directions — by
  designing an "auditor feature", and by forking a file that both sides use.
- **"Enforce in tooling, never discretion" (A3)** has a developer-facing shadow: *"a needed manual flag / a
  habit-fix is a bug signal" (B1/B3)*. When building, you resolve friction by moving it into the tool, not
  by adding a step to remember.
- **"Resolve toward the durable contract" (A2)** and **"docs capture durable concepts" (B5)** are one taste
  for *timeless over transient* — applied to code contracts vs. to documentation.
- **"Decomposition co-locates source + tests" (A8)** began as a *dev* lesson (parallel worktree edits
  deadlocked) and hardened into a *product* decomposition rule — the clearest case of a development friction
  becoming a product invariant.
