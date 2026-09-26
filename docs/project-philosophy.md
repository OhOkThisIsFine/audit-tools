# Project philosophy — the organizing picture

A single **map** of the convictions that shape audit-tools. It exists to give one orienting read of the
whole philosophy; it does **not** replace the canonical homes. The map has two halves, and one does the
work: **THE BRIEF** is the canonical short statement of the whole philosophy, and the **link table** below
it routes each conviction to the ONE home that argues it — `CLAUDE.md` (policy/conventions/how-to),
`spec/` (architecture/design), `docs/documentation-philosophy.md` (docs governance), or project memory
(cross-session facts). The table is a pointer map, never a second copy: it names a conviction's home
rather than re-stating the conviction, so when this table and a home ever disagree, **the home wins**.

**The brief is the single source for every condensed restatement of this philosophy.**
`README.md`'s "Philosophy" section is GENERATED from its *Product* half (`npm run
check:philosophy-brief -- --write`; the gate fails the build when the two drift), and the
`question-philosophy-gate` hook injects the whole brief when a question is about to reach the owner.
Edit a conviction here and both follow; never hand-edit the README block, and never copy these lines
into a third place.

---

# THE BRIEF — the whole philosophy in two dozen lines

The condensed form, in plain register with no internal citations, so it can be read by someone outside
the project and by an agent mid-decision. It is the canonical short statement; the link table below is
where each line's fuller argument lives. When the two disagree, the fuller home wins on nuance; the brief
must then be corrected, not left as a second opinion.

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
- Audits leave source files unchanged by default: formatting is an explicit per-run opt-in,
  a dry run never formats, and analyzer consent — grants and declines alike — binds only
  the run that was asked, so every run asks again.
- Nothing runs to completion in a single call. Each invocation does a bounded, persisted piece of work,
  so a run is resumable, parallelizable and failure-isolated.
- Scale the process to the work — depth and granularity are dials on one pipeline, never a separate
  lighter path.
- Artifacts are continuity: staleness propagates along an explicit dependency map, never ad-hoc
  freshness checks.
- The tool splits multi-goal scope into bounded parallel units — each owning its source and its tests —
  with boundary tests and scheduling dependencies; the host never phases work by hand.
- Parallel host execution over overlapping files is optimistic: two units may touch one file, the
  serialized accept-time write-scope binding decides collisions, and a wrongly-admitted pair conflicts
  at rebase and quarantines for retry.

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

# Where each conviction lives — concept → canonical home

The brief above is the canonical short statement of the whole philosophy; this table routes each
conviction to the ONE home that argues it. It names homes, it does not restate convictions — so a
conviction edited at its home makes nothing here stale, and when a row and its home disagree, the home
wins. Cross-session facts live in project memory; durable how-to lives in `CLAUDE.md`.

| Concept | Canonical home |
|---|---|
| Auditor-agnostic robustness; enforce-in-tooling; a gate states the boundary it owns | `CLAUDE.md` → Conventions & invariants |
| Right tool — mechanical vs bounded LLM judgment; resolve toward the durable contract | `CLAUDE.md` → Concepts |
| One logical core, two draws (audit / remediate) | `CLAUDE.md` → Preferences & standing decisions |
| Obligation-driven, fold-aware bounded step; resumable / parallelizable / failure-isolated | `CLAUDE.md` → Concepts |
| Machine contract is source of truth; human render is its render | `CLAUDE.md` → Concepts |
| Audits read-only by default; per-run analyzer consent | `CLAUDE.md` → Preferences (three analyzer convictions) |
| Everything-agnostic (provider / model / IDE / OS / shell / language) | `CLAUDE.md` → Conventions & invariants |
| Conversation-first; the host owns semantic execution | `CLAUDE.md` → Concepts / Conventions |
| Orchestrate by priority; content coherence; right-sized context | `spec/audit/orchestration-policy.md` |
| Staleness along an explicit dependency DAG | `spec/audit/dependency-map.md`; `CLAUDE.md` → Concepts |
| Self-scaling pipeline (adversarial-depth and phase-granularity dials) | `spec/self-scaling-pipeline-design.md` |
| Contract-authoring determinism; split design assessment into two modes | `CLAUDE.md` → Preferences |
| Decomposition, boundary tests, write-scope binding (brief's own three) | `src/remediate/steps/contractPipeline.ts`; `src/remediate/steps/dispatch/hostHandoff.ts` |
| Multi-host cooperative runs — JOIN, no primary/secondary | `spec/multi-ide-concurrent-runs-design.md` |
| Own-vs-acquire analyzers; two-tier dependency policy | `CLAUDE.md` → Preferences |
| Token estimates local and deterministic; no execution/router inventory | `CLAUDE.md` → Preferences; `spec/audit-workflow-design.md` |
| Ideal code over compatibility; atomic-replace ordering | `CLAUDE.md` → Preferences / Conventions |
| Ask on ambiguity, batched; never pick a default | `CLAUDE.md` → Preferences (memory) |
| Green at every commit; red-green regression validation | `CLAUDE.md` → Conventions & invariants |
| One home per concept; prefer extraction over drift-tests | `docs/documentation-philosophy.md` |
| Docs capture durable concepts, not current state | `docs/documentation-philosophy.md` |
| End-of-sprint closeout runs whole, unprompted | `~/.claude/portable-engineering-principles.md` (schema); `CLAUDE.md` → Conventions (bindings) |
| Ship pipeline — the agent owns commit→push→publish end-to-end | `CLAUDE.md` → Release & publish; `/ship` skill |
| Deliverables land in a file | `CLAUDE.md` → Preferences |
| Front-load broad prior-art search; log friction the moment you hit it | `CLAUDE.md` → Known friction & deferred fixes; memory |
