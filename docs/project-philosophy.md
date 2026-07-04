# Project philosophy — the organizing picture

A single **map** of the convictions that shape audit-tools, split by what they govern. It exists to give
one orienting read of the whole philosophy; it does **not** replace the canonical homes. Each principle's
authoritative statement lives where the doc-philosophy routes it — `CLAUDE.md` (policy/conventions/how-to),
`spec/` (architecture/design), `docs/documentation-philosophy.md` (docs governance), or project memory
(cross-session facts). This map states each conviction in one line and points at its home; when this map
and a home ever disagree, **the home wins**.

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

# PART A — governs the PRODUCT ITSELF

## The product's North Star

**The tool must be trustworthy even when the host agent is weak.** The host/auditor is a variable of any
strength, not a constant — so every correctness property is guaranteed by the tool, not by the host being
smart. Everything in Part A radiates from this. *(home: `CLAUDE.md` → auditor-agnostic robustness)*

## A1. Core architecture & workflow

- **One pipeline, two halves.** audit → findings contract; remediate → consumes + fixes. Each emits a
  machine contract (JSON, source of truth) + human render (md).
- **Obligation-driven, one bounded step per invocation.** Neither tool runs to completion. Each `next-step`
  derives state, picks the highest-priority unsatisfied obligation, does one bounded unit, persists,
  returns → resumable, parallelizable, failure-isolated.
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
- **LLM always in the loop.** Conversation-first ⇒ the host agent is always the provider; never gate LLM
  review behind "if a provider exists."
- **Resolve toward the durable contract.** LLM-vs-deterministic → deterministic; graph/language →
  language-neutral. *(home: `CLAUDE.md` → Concepts; memory: right-tool-not-deterministic-dogma)*

## A3. Enforce robustness in tooling, never host discretion

Every correctness property must be guaranteed by the tool — CLI option shape, contract validator, renderer
template, dispatch-prompt text, scheduler logic, merge tolerance, write-scope enforcement. Any place the
workflow only works because a capable host *remembered / noticed / reasoned / relayed / paced / picked the
right id / verified from disk / hand-fixed a break* is a **latent failure mode** → move it into the tool.
"Be careful" / "my side" is never a fix; **a needed manual flag is a bug signal.**
*(home: `CLAUDE.md` → Conventions; memory: enforce-robustness-in-tooling-not-host-discretion)*

## A4. Everything-agnostic by default

Provider/backend, host IDE/agent, **OS/platform**, model, shell, language/ecosystem — ALL runtime-discovered
or contract-abstracted, never baked in. The named rules are *instances of one principle*, not a closed list.
- **Model/provider/IDE agnostic:** no hardcoded model names/windows/tier-maps; a hardcoded model table is a
  bug.
- **Language-neutral by contract:** graph edges `from`/`to`/`kind` (+optional `direction`/`confidence`/
  `reason`); new analyzers *enrich* shared artifacts, never fork planning.
- **OS/platform-agnostic:** no platform-baked path/shell/command/line-ending assumptions in core logic;
  route through the existing abstractions. Windows-aware is the most-exercised instance, not the boundary.
*(home: `CLAUDE.md` → Conventions; memory: model-provider-ide-agnostic)*

## A5. Conversation-first  ⚑

The product IS the slash workflow inside the host conversation; the CLI is backend/fallback. Normal usage
carries no manual `--root`/provider/model flags. **Conversation-first means the worker IS the host agent**
(which already reads arbitrary files by context) — the correct framing when a robustness argument tempts
over-caution about what the worker may read. **Conversation-first subagent dispatch is first-class**,
co-equal with CLI/provider: a user with a subscription but no API credits gets the full experience via
host-spawned subagents. *(home: `CLAUDE.md` → Concepts; memory: conversation-first-subagent-dispatch-first-class)*

## A6. Self-scaling pipeline, not forked paths

Scale the *process* to the work; don't fork the *path*. Two continuous dials — **adversarial depth** (floor
light, never off) and **phase granularity** (degenerate phases collapse by structure). Signal assessed
cheaply at intake (affected-file count + path-risk patterns + intent), re-assessed on evidence. Escape
hatch: optimistic-start, escalate-on-evidence. Explicitly ONE pipeline, *not* a separate lean path.
*(home: `spec/self-scaling-pipeline-design.md`; memory: self-scaling-pipeline-not-forked-paths)*

## A7. Contract-authoring determinism

**Tool owns structure, IDs, cross-refs, derivation, validation; the LLM authors only irreducible *judgment*
in small pre-scaffolded, write-validated slots.** The conceptual design review is the ONE place to lean
INTO judgment.
- **Split design assessment into two named modes:** *contract assessment* (invariants/boundaries) vs.
  *conceptual design critique* (philosophy/alternatives). Bare "design assessment" is too ambiguous.
- **Delegate adversarial phases to a separate agent** — an author marking own homework misses gaps.
- **Dispatch = enforcement ⟂ driving ⟂ judgment:** mechanical broker (single chokepoint) → thin non-judging
  driver → bounded judgment at named seams.
*(home: `spec/contract-authoring-determinism-design.md`; memory: contract-authoring-determinism-direction,
delegate-adversarial-phases-to-separate-agent, dispatch-enforcement-driving-judgment-separation)*

## A8. How the tool decomposes & dispatches work

- **Remediator must decompose + boundary-enforce** — the tool mechanically breaks multi-goal scope into
  bounded parallel units + boundary tests + scheduling deps, not force the host to phase by hand.
- **Decomposition co-locates source + its tests** — each node owns its source AND the tests pinning it
  (separate source/test nodes deadlock).
- **Parallel dispatch over overlapping files is the goal** — disjoint-file split is an interim crutch;
  target = per-file edit-region ownership + disjoint-hunk merge.
*(home: memory: remediator-must-decompose-and-boundary-enforce, decomposition-colocate-source-and-tests,
parallel-dispatch-overlapping-files-is-goal)*

## A9. Multi-agent cooperative runs

Arbitrary agents/IDEs/providers contribute to the SAME audit/remediation (JOIN, not isolate) — symmetric
peers, no primary/secondary. Needs per-run state namespaces + task-claim locking, not single-writer state.
*(home: `spec/multi-ide-concurrent-runs-design.md`; memory: multi-ide-concurrent-runs-design)*

## A10. Analyzers & dependencies (the product's ingestion of external tools)

- **Own-vs-acquire; agnostic engine over a fixed bundle.** Own only truly-agnostic extractors (git-mining,
  secret-scan); acquire ecosystem-native tools dynamically + normalize via an adapter seam. Gate =
  mechanical run-safety + curated default set + per-run consent, NOT a maintained allowlist.
- **Two-tier dependency policy.** Import vetted pure-JS libs for correctness-sensitive parsing/schema/lock
  (`smol-toml`, `yaml`); own only tiny domain bits; wrap parsers so malformed input degrades to empty.
*(home: `CLAUDE.md` → Preferences; memory: deterministic-analyzers-own-vs-acquire)*

## A11. Quota & token policy (product behavior)

- **Token estimates stay local and deterministic** — never API-call token counting; shared
  `estimateTokensFromBytes` is the standard; learned RPM/TPM limits authoritative.
- **Quota awareness must pace, not just observe** — don't burn the window in parallel and all hit the wall
  at once; quota death is a retryable pause, not a failure. Red line: never IDE-GUI automation.
*(home: `spec/dispatch-token-budget-gate.md`, `docs/quota-dispatch-design.md`; memory: quota-dispatch-vision, cross-provider-quota-matrix)*

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
  chat-only. *(home: `CLAUDE.md` → Preferences; global `~/.claude/CLAUDE.md`; memory:
  prefer-ideal-code-no-backcompat, ask-on-ambiguity-dont-defer-silently, proportionality-defer-needs-user-signal)*

## B2. Ship-pipeline ownership

**The agent owns the ship pipeline** — commit → push → merge → publish → verify-live → reinstall global
bins, end-to-end by default. Never park at the push/publish boundary. Hand back only for destructive
ambiguity. Encoded in the `/ship` skill (CLAUDECODE unset for gates, CRLF clean-tree guard, allow-scripts
postinstall, release-CI-is-the-real-signal). *(home: `CLAUDE.md`; global `~/.claude/CLAUDE.md`; memory:
agent-owns-ship-pipeline)*

## B3. Code & repo discipline

- **Green-at-every-commit** — before any push `npm run build && npm run check` → zero errors (hook-enforced).
- **Atomic-replace ordering invariant** — every destructive change ships as a single atomic replace (new
  mechanism + deletion in one commit); never add-then-delete across commits.
- **Dead-code release gate = default-mode knip** (not `--production`, which false-positives on dispatch/
  alias wiring); tested-but-unwired is a periodic manual grep-zero sweep.
- **Keep the two orchestrators in parity** — a fix in one usually belongs in both; shared logic →
  `audit-tools/shared`.
- **Prefer extraction over drift-tests** — single-source two copies instead of guarding them with a drift
  test; make drift impossible. *(home: `CLAUDE.md` → Conventions/Preferences; memory:
  knip-deadcode-gate-default-mode, prefer-extraction-over-drift-tests)*

## B4. End-of-sprint cleanup (standing, unprompted)

Every sprint-end (pause/handoff/milestone): verify green on a clean pushed tree → scan the diff for dead
code/debug/TODO → no half-done broken state (call out deliberate intermediate) → trim HANDOFF → update
backlog → sync memory + index → **state remaining steps and name each one's home doc** ("nothing pending"
or an explicit list: immediate-next → HANDOFF; bugs/tracks → backlog; durable design → memory+index;
how-to → `CLAUDE.md`). *(home: `CLAUDE.md` → Conventions; global `~/.claude/CLAUDE.md`; memory:
end-of-sprint-cleanup-standing-step)*

## B5. Documentation governance

- **Docs capture durable concepts, not current state** — timeless *why* and *contract* only; changelog/
  status/dated-narrative doesn't belong. Absence of a thing is not staleness.
- **One home per concept** — duplication across homes is drift; a fact belongs in its most-durable home and
  is referenced, not copied, from others.
- **Condensation bias** — fewer, denser, timeless docs; enforced by a doc-manifest gate + nightly review.
- **Universal host prompts, single-sourced** — ONE canonical prompt body rendered per-IDE, never per-IDE
  prose. *(home: `docs/documentation-philosophy.md`; memory: spec-degradation-and-doc-staleness,
  universal-host-prompts-single-source)*

## B6. Backlog & friction hygiene

- **Disambiguation completes or leaves** — a pass ends an item fully specced OR left as-is; never
  half-specced with residual open sub-questions (churn).
- **Front-load broad prior-art search before contract authoring** — search the *whole* repo for equivalent
  logic AND independently re-verify the target symbol's own type/shape. Narrow scope is the top churn driver.
- **Log friction the moment you hit it** — full friction walk each loop lap; log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) durably to backlog, unprompted; don't
  trust the empty mechanical set. *(home: `CLAUDE.md`; memory: disambiguation-completes-or-leaves,
  front-load-broad-search-before-contract-authoring, log-all-friction-categories-every-lap)*

---

# BRIDGE — convictions that live in BOTH

A few principles are the *same taste* pointed at the product and at the dev process — named once here so
they aren't double-counted:

- **"Enforce in tooling, never discretion" (A3)** has a developer-facing shadow: *"a needed manual flag / a
  habit-fix is a bug signal" (B1/B3)*. When building, you resolve friction by moving it into the tool, not
  by adding a step to remember.
- **"Resolve toward the durable contract" (A2)** and **"docs capture durable concepts" (B5)** are one taste
  for *timeless over transient* — applied to code contracts vs. to documentation.
- **"Decomposition co-locates source + tests" (A8)** began as a *dev* lesson (parallel worktree edits
  deadlocked) and hardened into a *product* decomposition rule — the clearest case of a development friction
  becoming a product invariant.
