# CLAUDE.md

## What this is

Single npm package (`audit-tools`) shipping two autonomous step-driven orchestrators + a shared library, split by area under `src/`. Each `next-step` call returns one backend-rendered prompt contract (JSON + markdown); host agent executes it, calls back for next. State persists to artifact dir → resumable.

- **audit-code** — audits codebases, produces findings report
- **remediate-code** — consumes that report (or free-form), applies fixes

Pipeline: audit → report → remediate.

## Concepts

When a decision is unclear, reason from these:

- **One pipeline, two halves.** audit→findings contract; remediate→consumes+fixes. Each emits machine contract (JSON) + human render (md): `audit-findings.json` / `audit-report.md`; `remediation-outcomes.json` / `remediation-report.md`. JSON = source of truth.
- **Obligation-driven, one bounded step.** Neither tool runs to completion. Each `next-step` derives state, picks highest-priority unsatisfied obligation, drains the deterministic frontier fold-aware, persists, returns — see *One bounded step per invocation*. Resumable, parallelizable, failure-isolated.
- **Right tool, not deterministic dogma.** Three rules, balanced case-by-case — the project is *not* "100% deterministic": (1) where a mechanical/deterministic tool does the job as well as or better than an LLM, use the tool; (2) where a bit of non-deterministic LLM judgment *strongly* improves quality, use the LLM — bounded and recorded (semantic review, synthesis, ambiguity resolution, low-confidence fallbacks); (3) whatever *can* be enforced in tooling must be — never rely on the LLM to follow directions when the property can be guaranteed mechanically (see *Auditor-agnostic robustness*). Rules (1)/(2) choose who does the work; rule (3) constrains how the result is guaranteed regardless of who does it.
- **Right-sized context.** Pre-digest scope/contracts/file lists/evidence/constraints so prompts stay focused and token-efficient.
- **Artifacts are continuity; dependency DAG is truth.** Staleness propagates along explicit dependency map — never ad-hoc freshness checks.
- **Language-neutral by contract.** Graph/artifact shapes language-agnostic. New language support enriches shared contracts; must not fork planning logic per ecosystem.
- **Conversation-first.** Product is the slash workflow inside host conversation; CLI is backend/fallback.

The `src/shared` area (imported as `audit-tools/shared`) single-sources step contracts, artifact/graph types, content-coherence planning, strict session intent, and provider-neutral execution records — so the two orchestrators cannot drift at the host boundary.

## Layout

**One npm package, `audit-tools`, shipping both bins.** Source is split by area under `src/`:

| Source area | bin / slash command | Role |
|---|---|---|
| `src/shared` | — | Contracts, IO, content-coherence planning, session intent, execution records, validation. Imported as `audit-tools/shared`. |
| `src/audit` | `audit-code` / `/audit-code` | Audit orchestrator. Tests: vitest (`tests/audit/*.test.ts`). |
| `src/remediate` | `remediate-code` / `/remediate-code` | Remediation orchestrator. Tests: vitest (`tests/remediate/*.test.ts`). |

## Commands

All TypeScript (ES2022, NodeNext, strict), Node 22+. From repo root:

```bash
npm install                       # install deps
npm run build                     # tsc → dist/
npm run check                     # typecheck only (no emit)
npm run check:tests               # typecheck the TEST tree too (tsconfig.test.json; in verify:checks)
npm test                          # build + vitest (audit + shared + remediate)

npx vitest run tests/audit/<file>.test.ts            # single audit test
npx vitest run tests/remediate/<file>.test.ts        # single remediate test
```

One runner: **vitest** across all three areas (`tests/audit`, `tests/shared`, `tests/remediate`),
all `.test.ts` except the one permanent holdout `tests/shared/shared-tests-invariants.test.mjs`
(a `.ts` guard cannot detect its own exclusion from the typecheck gate). `node:assert/strict` is
still permitted as an assertion library (it runs fine under vitest) for the control-flow assertions
(`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent.

**Always run `npm install` first** in a fresh clone or worktree — missing `node_modules` → `audit-tools/shared` resolves a stale `dist/` → misleading "no exported member" type errors.

### audit-code (`src/audit`)

Tests use vitest (`test`/`describe`/`it` + `expect`); `node:assert/strict` may still appear for
control-flow assertions. Nested subtests use `describe`/`it`, not `t.test`.

### remediate-code (`src/remediate`)

```bash
npm run fixtures:auditor-contract        # regenerate test fixture
node remediate-code.mjs next-step --input report.md   # dev wrapper (auto-rebuilds)
```

## `audit-tools/shared` (the `src/shared` area)

Owns: step and execution-record contracts, strict repository session intent, analyzer policy, run ledger, graph/surface/flow/risk/disposition/access types, content-coherence planning, JSON IO helpers, file locking, and validation. It owns no provider registry, execution adapter, model inventory, routing policy, quota accounting, or backend window sizing.

Imported via the `audit-tools/shared` subpath export (single package — no `@audit-tools/shared` workspace dep).

**Build is a single `tsc`** over the one package (`npm run build` → `dist/`); there are no cross-workspace build-order concerns. When changing a shared contract, rebuild + `npm run check` so both orchestrators typecheck against it.

## audit-code architecture

Obligation-driven. Each invocation **drains** the deterministic obligation frontier — highest-priority-first — folding successive bounded steps into one call, halting at a host-input pause, a non-drainable step, or the `MAX_DRAIN_STEPS` ceiling. Repeated → normalized repo understanding → bounded audit tasks → verified coverage → findings report.

**Core loop** (`src/audit/orchestrator/advance.ts` → `advanceAudit`):
1. Load artifact bundle from `.audit-tools/audit/`
2. `decideNextStep` (`src/audit/orchestrator/nextStep.ts`) — derives state, picks obligation
3. Run one deterministic executor or emit a complete provider-neutral host workload
4. Persist

Steps 2–4 **drain** — they repeat within a single `advanceAudit` call across successive deterministic obligations (the default; fold-aware, so the loop halts at every operator-interactive pause), bounded by `MAX_DRAIN_STEPS`. The call returns a single consolidated summary for the whole drain. "Bounded" therefore means *fold-aware drain of the deterministic frontier*, not one obligation per call — see *One bounded step per invocation* below.

The obligation ordering is the single-sourced `PRIORITY` array in `src/audit/orchestrator/nextStep.ts` (running `repo_manifest` → … → `friction_capture_current`); `decideNextStep` walks it and picks the highest-priority unsatisfied obligation. Backend/model choice, concurrency, retries, and failover belong entirely to the conversation host and never enter the audit graph.

Synthesis emits `audit-findings.json` (machine contract); `audit-report.md` is its render. `synthesis_narrative_current` is a bounded semantic host step for themes, executive summary, and top risks; the tool validates and ingests the returned narrative.

**Artifacts** (`.audit-tools/audit/`): the authoritative set is the `ARTIFACT_DEFINITIONS` registry in `src/audit/io/artifacts.ts` — machine contracts as `*.json`, human renders as `*.md` (synthesis emits `audit-findings.json` + its `audit-report.md` render). Read the registry for the full, current list rather than a copy here (it has drifted when copied). Review packets: partitioned JIT at dispatch, never persisted. Staleness: explicit dependency DAG (`spec/audit/dependency-map.md`, `src/audit/orchestrator/staleness.ts`, `src/audit/orchestrator/artifactMetadata.ts`).

**Entrypoint:** `audit-code.mjs` → `wrapper/audit-code-wrapper-lib.mjs`. Conversation-first: `audit-code next-step` writes `.audit-tools/audit/steps/current-step.json` + `current-prompt.md`.

**Host handoff** (`src/audit/cli/dispatch/hostHandoff.ts`): the tool writes a versioned workload, prompt digests, task bindings, and a result map beneath the run directory. The host may execute the work however it chooses. Ingestion accepts only prompt-bound results with the expected run/task identity and file coverage, records accepted results idempotently, and rejects backend/model/routing fields. audit-tools never launches the work itself.

**Schemas** (`schemas/`): `AuditResult` contract (`schemas/audit_result.schema.json`) — `task_id`, `unit_id`, `pass_id`, `lens` must match assigned task; `file_coverage[].total_lines` must match actual line counts.

**Lenses:** `correctness`, `architecture`, `maintainability`, `security`, `reliability`, `performance`, `data_integrity`, `tests`, `operability`, `config_deployment`, `observability`.

## remediate-code architecture

Accepts auditor reports or free-form feedback. Advances via bounded step prompts. Runtime deps: `commander` (CLI) and `zod` (schema validation, e.g. `src/remediate/state/types.ts`).

**State machine** (`src/remediate/steps/nextStep.ts` → `decideNextStep()`):
```
pending → planning → implementing → closing → complete
              ↕            ↕
  waiting_for_clarification  triage → waiting_for_triage
```

**Phases** (`src/remediate/phases/`):
- `plan.ts` — `RemediationPlan` with `Finding[]` + `RemediationBlock[]`; detects auditor vs. conversation input
- planning gates (there is no separate "document" phase — dissolved, N-R13): at planning, before any
  implement dispatch, a review-necessity gate (`runPlanningReviewGate`) surfaces findings tiered by
  review-need for a batched keep/decline (declined → recorded `ignored`) and an up-front ambiguity gate
  (`runPlanAmbiguityGate`) batches all scoping/judgment ambiguities into one `clarification_request`;
  planning then transitions DIRECTLY to implementing. `ItemSpec` is optional enrichment that rides the
  dispatch assignment as context — it is NOT the write scope. The enforced scope is
  `block.touched_files`, normalized into the work item's `allowed_files` by `buildWorkItem`
  (`src/remediate/steps/dispatch/hostHandoff.ts`) and re-checked against the landed diff at ingestion.
  `touched_files` is produced upstream two ways: the contract pipeline's `deriveNodeFiles` (node
  `output_files` → `files_likely_touched` → the matched module's `file_scope`), which makes it a SIBLING
  of `finding.affected_files` rather than a derivation of it; or, on the no-blocks / lean-fast-path branch
  of `normalizeExtractedPlan` (`src/remediate/steps/nextStep.ts`), copied straight from `finding.affected_files`. Both gates
  in `src/remediate/steps/nextStep.ts`; dispatch in `src/remediate/steps/dispatch.ts` (a barrel over the
  host-handoff module above).
- implement phase (dispatches implementation with test execution + verification) — in `src/remediate/steps/dispatch.ts`
- `src/remediate/phases/triage.ts` — failed items; retry vs. block
- `close.ts` — closing actions (test suites, build, lint)

**Host handoff:** `src/remediate/steps/dispatch/hostHandoff.ts` derives the dependency-ready implementation frontier and writes a complete versioned workload with bounded prompts, worktree/scope bindings, result paths, and deterministic metadata. The host owns assignment and concurrency. Ingestion revalidates the persisted binding, evidence, write scope, worktree state, and result identity before advancing any item; retired adapter-shaped state fails closed.

**State persistence** (`src/remediate/state/store.ts`): file-backed `RemediationState`, atomic temp-then-rename writes, guarded by the shared `LockedJsonStore` (`audit-tools/shared/io/lockedJsonStore.ts`, also used by analyzer policy), which wraps `withFileLock` (`audit-tools/shared/io/fileLock.ts`: exponential 50ms→500ms backoff, token-checked 30s stale-lock cleanup). The lock is single-sourced — `store.ts` adds no backoff/retry logic of its own.

**Core types** live in `src/remediate/state/types.ts`; `TestSpec` lives in `src/shared/types/contractPipeline.ts`. `src/remediate/dedup/crossLensDedup.ts` deduplicates across lenses; `src/remediate/intake.ts` orchestrates source manifest, summary, clarification resolution.

**Artifact layout:**
```
.audit-tools/
  audit/               # audit-code artifacts
  remediation/
    state.json         # state machine
    state.lock         # pessimistic lock
    intake/            # source manifest, summary, clarifications
    steps/             # current-step.json, current-prompt.md
  audit-report.md              # promoted on audit completion (human render)
  audit-findings.json          # promoted on audit completion (machine contract)
  remediation-report.md        # written on completion (human render)
  remediation-outcomes.json    # written on completion (machine contract)
```

## Release & publish

Shipping is the `/ship` skill (`.claude/skills/ship/SKILL.md`) — it owns the full land-and-publish flow,
the trap list (CRLF clean-tree guard, allow-scripts postinstall on global reinstall,
release-CI-is-the-real-signal), the release-pipeline shape, and the always-on pipeline profiling. Never
park at the push/publish boundary.

## Before implementing

The pre-implementation gate is the `/design-check` skill (`.claude/skills/design-check/SKILL.md`) — it
owns the retirement-collision check (does this add back something deliberately removed), the
independent refutation pass, and the failing-test-first handoff. Run it before non-trivial loop-core /
shared-contract / host-handoff or result-ingestion work, not after the code exists: the same catch costs an edit to a plan
instead of a rewrite. Trivial mechanical edits skip it.

## Conventions & invariants

- **Auditor-agnostic robustness — enforce in tooling, never host discretion.** The host/auditor agent is a variable of any strength, not a constant. Every workflow correctness property must be guaranteed by the tool itself — CLI option shape, contract validator, renderer template, dispatch-prompt text, scheduler logic, merge tolerance, write-scope enforcement — never by the host *remembering*, *noticing*, or *reasoning*. Any place the workflow only works because a capable host folded in guidance, relayed upstream evidence, paced dispatch safely, picked the right id, verified from disk, or hand-fixed a cross-block break is a **latent failure mode** → move it into the tool so it's impossible to get wrong. "Be careful" / "habit fix" / "my side" is never a fix; prefer changes that make the process *simpler*, not ones that add a step the host must remember. (Generalizes "Conversation-first" and "a needed manual flag is a bug signal".)
- **Conversation-first.** Normal usage: no manual `--root`, provider, model, routing, quota, or worker flags. The backend emits the next complete workload; the active host owns execution.
- **One bounded step per invocation = a fold-aware drain, not a single obligation.** "Bounded" is the *drain-with-fold-aware-halt* model: a call drains the deterministic obligation frontier (highest-priority-first, the default), folding successive steps together and halting at the first host-input pause, non-drainable step, or the `MAX_DRAIN_STEPS` ceiling. Deterministic steps that require no host judgment fold silently; anything operator-interactive breaks the fold. Neither orchestrator runs to completion in a single call, and no call crosses a host-input boundary.
- **Upstream-valid before downstream-refresh.** Don't refresh a downstream artifact until its upstream dependencies are valid (staleness ordering — see *Right tool, not deterministic dogma* for the deterministic-vs-LLM choice itself).
- **Language-neutral graph.** Edges: `from`, `to`, `kind`, optional `direction`/`confidence`/`reason`. New analyzers enrich shared artifacts, don't fork planning.
- **No execution inventory in this package.** Model identities, windows, prices, rate limits, capability tiers, and provider rosters are host concerns. Do not discover, sync, persist, or route on them inside audit-tools; emitted workloads carry only content-derived complexity, risk, token estimates, scope, and prompt bindings.
- **Everything-agnostic by default.** Provider/backend, host IDE/agent, **OS/platform**, model, shell, and language/ecosystem are outside the contract or abstracted — never baked in. The named rules (provider/model/IDE-agnostic, language-neutral, LLM-always-in-the-loop) are *instances* of ONE principle, not a closed list. **OS/platform-agnostic** specifically: no platform-baked path, shell, command, or line-ending assumptions in core logic — route them through the existing abstractions (`resolveExecArgv`, `normalizeRepoPath`, the `.audit-tools` path module, `toPromptPathToken`, and the shared execution boundary) so identical code runs on win32 / darwin / linux.
- **LLM always in the loop.** Conversation-first means the host performs every semantic obligation and returns the bound result. Never gate semantic review on provider discovery inside audit-tools.
- **Windows-aware** (the most-exercised instance of *OS-agnostic* above, not the boundary of it). Package-manager shims run through the command shell; `.cmd` / `.bat` wrappers resolve reliably through `resolveExecArgv`.
- **Host prompts are cwd-explicit.** Commands must be cwd-independent or state exact workdir. Prefer `workdir` on the tool over asking workers to `cd`.
- **PowerShell JSON generation is statement-safe.** Assign `foreach` output to a var first, then pipe to `ConvertTo-Json`.
- **Extractors emit stable, content-derived array order.** Any artifact array field must be ordered by a stable key derived from content (e.g. path-sort), never filesystem / `readdir` / iteration order. `stableStringify` preserves array order, so an incidentally-ordered array silently churns the artifact's content hash on every re-extraction → cascades phantom staleness down the dependency DAG → redundant (expensive) downstream LLM re-runs. Any new extractor emitting an incidentally-ordered array is a latent churn source.
- **Atomic-replace ordering invariant.** Every destructive change — deleting a fast path, phase, scheduler, cap, or monolithic pass — ships as single atomic replace: new mechanism + deletion in one commit. Never add-then-delete across commits.
- **Durable traps are MECHANICALLY enforced, not remembered.** A trap that can be enforced is enforced,
  and its backlog entry is DELETED rather than restated (two copies decay independently; the mechanism
  states the trap and the fix when it fires). Enforcement is a **hook** when the trap is detectable at a
  tool call, and a **contract test** when it is instead a property of the tree — a test is equally
  binding and equally self-describing, so it earns the same deletion. A trap enforced only *partly* is
  NOT deletable: state the uncovered half outright, or the covered half reads as a close (a live
  example in [`durable-traps.md`](docs/backlog/durable-traps.md) — the `.mjs` test holdout
  `checkJs:false` excludes from `check:tests`). Current guards in `.claude/hooks/`:
  `shell-trap-guard.mjs` (PreToolUse Bash/PowerShell — `codex exec` with open stdin; a `git checkout --` /
  `git restore` that would eat unstaged work; Bash-tool Windows-backslash paths, PowerShell here-strings and
  `mktemp`; a live backtick, which command-substitutes inside double quotes too, so markdown backticks in a
  quoted message are executed rather than written; agy headless flag/stdin traps; a refusal of a suite/verify
  exit code masked by a pipe),
  `tool-input-guard.mjs` (PreToolUse Edit/Write/Agent — raw control bytes in written content, Agent
  `isolation:"worktree"` on a dispatch node, a deny-once when HEAD is behind remote main),
  `session-start-guards.mjs` (SessionStart — stale-main probe, missing `node_modules`, a stale git
  `index.lock`/`shallow.lock`, offload-lane liveness so a down proxy is a known constraint at lap start
  rather than a mid-lap stall, the one leg that MUTATES the filesystem — reaping agent worktrees
  that are an ancestor of a main ref, idle ≥6h, and clean — and session registration: a
  per-`session_id` record with the tree-dirt baseline at session start, the substrate the Stop gates
  scope themselves by (a dispatched child sets `AUDIT_TOOLS_CHILD_SESSION=1` and is not registered)),
  `nightly-surface.mjs` (SessionStart — surfaces the nightly routine's open items),
  `friction-stop-gate.mjs` (Stop — the blocking friction-walk backstop; `process.exit(2)`),
  `question-philosophy-gate.mjs` (PreToolUse AskUserQuestion + Stop — a question is about to reach the owner,
  so THE BRIEF in `docs/project-philosophy.md` is EXTRACTED, never copied, and injected once per session; it
  does not suppress asking — *ask on ambiguity* still holds, and the retry goes through),
  `closeout-challenge-gate.mjs` (Stop — asks "are you sure that was all taken care of, and will the handoff
  be clear for the next agent?" with the mechanical evidence attached: uncommitted work, unpushed commits, a
  HANDOFF generated state that no longer matches the nightly queue / decision ledger or backlog,
  memory files missing from the `~/.claude/…/memory/MEMORY.md` index; capped at 2 per session; dirt present at session start is
  reported as pre-session (not yours), never challenged).
  **Guard wiring + reach are DECLARED DATA, never prose:** `scripts/guard-reach-data.mjs` registers every
  guard (gate / hook / contract-test), how it is wired, and the file set it scans — with every known
  uncovered half stated as data. `npm run check:guard-reach` (in `verify:checks`, plus an unconditional
  pre-commit leg) reconciles the registry against the tracked tree: a tracked file no row claims, a guard
  wired into no gate, or a hook / check script outside the registry is a red build. The registry — not
  this paragraph — is the authoritative list of hook contract tests (all under `tests/` because vitest
  excludes `.claude/**`, so a test beside a hook never runs in CI). **Adding a hook:** register it in `.claude/settings.json` AND add the
  `!.claude/hooks/<name>` line to `.gitignore` in the SAME commit — the commit gate blocks a settings.json
  that references a hook the commit would not carry.
- **Green-at-every-commit.** Before any push: `npm run build && npm run check` → zero errors. Hook-enforced: PreToolUse blocks `git commit` until check is green (plus the unconditional guard-reach reconciliation, and, when the staged set touches them, the doc-contract subset and `check:doc-manifest` — the checks that otherwise fail only in release CI and burn a tag); async PostToolUse typechecks edited package after TS edits (`.claude/hooks/`). A commit whose staged set touches a loop-core path (`src/shared/loopCorePaths.ts` — orchestrator, planning, host-handoff, and result-ingestion substrate) is additionally blocked until a fresh, staged-tree-bound review attestation exists (`node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> --attester-class <agent|human> --checked "<...>"`); the gate enforces attestation existence+freshness+binding, not review quality. The attestation is an attributable, tree-bound audit record — it RECORDS the attester's class (agent or human; required, plus detected agent-session env markers) and the reviewing identities, it does not and cannot enforce that a human reviewed. Destination-keyed: a `concerns` verdict without an override blocks only a commit that can land on `main`; on any other branch it is accepted (WIP preservation must not train the override into a reflex).
- **End-of-sprint cleanup — run it every sprint, unprompted.** A *sprint* = any coherent stretch of work that ends at a pause, handoff, or milestone (a shipped item, "wrap up here", switching windows). Before handing off, ALWAYS run the cleanup pass (don't wait to be asked): (1) **verify green** — `npm run build && npm run check` + the touched package's test suite, on a **clean, fully-pushed tree**; (2) **scan the sprint's diff** for dead code / orphaned helpers / stray `console`/`TODO`/debug and remove them; (3) **ensure no half-done broken state** — and call out any *deliberate* intermediate state in the handoff so it isn't mistaken for a bug; (4) **trim `docs/HANDOFF.md`** to lean + accurate (correct HEAD/commits, immediate-next-only, never a changelog); (5) **update the backlog** (`docs/backlog/`) program-of-record status; (6) **sync memory + its index**; (7) **state remaining next steps explicitly, and name the document each lives in** — the closeout (and the chat hand-back) lists each remaining item with its home: immediate next step → `docs/HANDOFF.md`; open bugs / forward tracks → `docs/backlog/open-bugs.md` / `docs/backlog/forward-tracks.md`; durable design/decisions/status → project memory + its `~/.claude/projects/…/memory/MEMORY.md` index (the external per-project host-memory store, not an in-repo file); durable how-to → `CLAUDE.md`. Never leave a remaining step implied or living only in chat. Any decision only the owner can make is ASKED in the hand-back as a direct question with its options spelled out (AskUserQuestion where available) — "your decision: see queue X / run command Y" is a pointer, not a question. Render the hand-back to the markdown scheme in [`docs/end-of-sprint-report-template.md`](docs/end-of-sprint-report-template.md) (timeless template — never commit a filled dated copy); a line or section with nothing to report is OMITTED there, never written out as "none" and never explained.

## Preferences & standing decisions

- **Ideal code over compatibility.** One user, no external consumers → cleanest design, delete deprecated/legacy paths. **Implementation effort/complexity/refactor-size is NOT a cost** — only the eventual endpoint (cleanest/most-efficient/most-robust) matters. Never defer, stage-to-avoid-work, or pick a lighter half-measure because the ideal is "a lot of work" or "a big atomic change." The only thing that gates pace is correctness (green-at-every-commit, no broken/lossy intermediate states) — that's doing it right, not avoiding the work.
- **One core, two draws — there is no auditor-logic vs remediator-logic.** There is ONE shared body of
  logic; auditing is a *draw* from it (the read-only selection) and remediating is a *draw* from it (the
  write/apply selection). So when the two sides diverge, the default is **one shared core + per-mode
  policy/draw**, NOT two forks kept "in parity." A **"domain-forced divergence" is a policy axis of the
  shared core, almost never a fork justification** — a true *category error* (two genuinely different KINDS
  of operation) is rare, and "it would become a config-shell with several knobs" is not a reason to fork
  (a several-knob shared core is the correct endpoint — it's what stops the two from drifting on the
  skeleton). Legitimately per-mode = only genuinely-different INPUT (a different draw over different
  artifacts) or the terminal/result-routing adapter, never the algorithm. Fix in one usually belongs in
  both; single-source the common core in `audit-tools/shared`, each orchestrator a thin policy-selecting
  adapter. (Realizes "One pipeline, two halves" and the dissolve-the-distinction direction.)
- **One brief, two consumers — never a second copy of the philosophy.** THE BRIEF in
  [`docs/project-philosophy.md`](docs/project-philosophy.md) is the single source for every condensed
  restatement: `README.md`'s Philosophy section is GENERATED from its *Product* half
  (`npm run check:philosophy-brief -- --write`, gated in `verify:release`) and the
  `question-philosophy-gate` hook extracts the whole brief at runtime. Edit a conviction in the brief and
  both follow. The README block was previously a hand-maintained restatement kept honest by an instruction
  to *remember* to update it — a drift test made of memory, which is the thing this project bans.
- **Docs capture durable concepts, not current state.** Timeless conceptual docs only. Exception: single handoff doc for immediate next steps. Full statement (one-home-per-concept, status-noise, condensation bias) in [`docs/documentation-philosophy.md`](docs/documentation-philosophy.md) — the canonical philosophy the nightly maintenance routine's doc leg enforces ([`docs/nightly-routine.md`](docs/nightly-routine.md)).
- **audit-tools does NOT route — it reports task metadata and the HOST dispatches** (owner directive,
  2026-08-09). The tool's job is to characterize work: per-task risk, complexity, local token
  estimates, scope and lens. Choosing *which backend runs it* — pools, capability tiers, failover,
  cost-first admission, provider rosters — is the host's, and owning any of it here is pollution.
  This is the same inversion as *Conversation-first* and *never hand-maintain a model/price table*,
  applied to selection itself: those rules say don't own the model FACTS, this one says don't own the
  CHOICE. **The cut is (d) — ZERO execution adapters, metadata only** (owner, 2026-08-09, superseding
  the same day's "one execution adapter"): the tool atomizes work and emits per-task metadata,
  mandating nothing, so every provider class, `PROVIDER_NAMES`, auto-resolution, the launch contract
  and the spawn substrate go — and **quota goes entirely** (the verb, the sources, the learned slope,
  cooldowns, RPM/TPM, reservations); a backend's allowance is never the tool's business. **The
  declared sizing window goes with them** (owner, 2026-08-09, superseding the same day's "the single
  host-declared window stays"): asked which config field should carry it, the owner rejected the
  premise — *"audit-tools should not be involved in dispatching, routing, or transport"* — and a
  config block describing a backend's context and output caps IS transport config. So the tool
  partitions on **content coherence** and reports a **token estimate**; it never partitions to fit a
  backend's window, and the host bundles for the backend only it knows. Work blocks survive; "reasonable
  size" stops meaning "fits model X". What stays is result **ingestion** (consumption, not execution)
  and the right to faithfully RECORD what the host says ran — *not routing does not mean not knowing*.
  ⚠ Consequence: `work_blocks` in `audit-findings.json` stops being a FIT CLAIM and becomes a
  coherence grouping plus an estimate.
  ⚠ Internal autonomous execution is deliberately given up. The old provider, quota, routing,
  backend-sizing, and launch substrate was retired as one architectural cut; do not recreate it.
- **A needed manual flag is a bug signal.** Fix canonical root/state resolution; do not document a workflow flag. Execution choices are host-owned inputs to neither CLI.
- **Resolve toward durable contract.** LLM-vs-deterministic → deterministic; graph/language → language-neutral contract.
- **Budget context before LLM dispatch.** Small obligation-specific packets; expand only when genuinely needed.
- **Split design assessment into two named modes.** *Contract assessment* (invariants/boundaries/obligations) vs. *conceptual design critique* (philosophy/alternatives/better directions). Bare "design assessment" = too ambiguous.
- **Caveman mode (full) active globally.** Ultra-compressed telegraphic prose across all responses and agents. the owner toggles off when clarity needed.
- **Redesign before scheduled autonomy.** Architecture stabilizes first; then build scheduled audit→remediate→PR loop once on new architecture.
- **Token/context policy lives in `~/.claude/CLAUDE.md`.** Don't duplicate here.
- **Token estimates stay local and deterministic.** Never API-call token counting in planning or host-handoff generation. No tokenizer dependency — shared `estimateTokensFromBytes` is the standard. An estimate describes content size only; it is never a backend-fit claim.
- **Two-tier dependency policy — import vetted libs for correctness-sensitive parsing/schema/lock; own only tiny domain bits.** A format whose grammar we don't fully own (TOML, YAML, lockfiles, schema validation) is *correctness-sensitive*: a hand-rolled scanner silently drops what it doesn't understand (e.g. the TOML line scanner missed inline-table / dotted-key / quoted forms → dropped dependency-graph edges). Import a vetted, pure-JS, well-maintained parser there (`smol-toml`, `yaml`) — pure-JS so OS-agnostic, no native build. Keep hand-rolled only for *tiny, fully-owned* domain bits (e.g. our `.audit-tools` path tokens, the work-block id grammar). When importing: wrap the parser so malformed input degrades to empty (the graph/extractors never throw on a bad manifest), and single-source the parse + safe accessors in one module.
- **Own-vs-acquire analyzer engine — own the agnostic extractors, acquire + normalize the rest.** OWN only truly language-agnostic extractors in-house (git-history mining); ACQUIRE ecosystem-native analyzers (clippy / rubocop / semgrep / eslint / gitleaks secret-scan) on demand and NORMALIZE their output into *leads*, never direct findings (npm-audit is not acquired — `src/audit/adapters/npmAudit.ts` is an import-normalizer over JSON someone else produced, never spawned). Every acquired-tool spawn routes through the single `admitSpawn` chokepoint, where the curated DEFAULT set is admitted WITHOUT a token and every other candidate — including pre-installed `permanent`/`ephemeral` tools — requires first-use consent — either a durable recorded `granted` decision in `.audit-tools/audit/analyzer-policy.json`, or the per-run consent token (`consentToken` on `AcquisitionEngineOptions` / `ExternalAcquisitionAdvanceOptions`, consumed by `admitSpawn`) (a mechanical run-safety gate + curated default set + first-use consent, never a maintained allowlist); a consent token authorizes ONE run and is never persisted — the guarantee is mechanical, pinned by `tests/shared/consent-token-not-persisted.test.ts` (both persisted schemas — `SessionIntentV1Schema` and `AnalyzerPolicySchema` — are `.strict()` and admit no token-shaped field, and the analyzer-policy store re-validates on write), so adding one goes red. [[deterministic-analyzers-own-vs-acquire]]
- **Dead-code release gate — default-mode knip, not `--production`.** `npm run check:deadcode`
  (runs `knip --no-config-hints`, with `include: ["exports","types","nsExports","nsTypes"]` set in
  `knip.json`; wired into `verify:release`) fails the build on any
  exported symbol with zero consumers anywhere, including tests. This gates our own source tree at release
  time — distinct from knip's separate use as an *acquired product analyzer* audit-code runs against
  repos it audits (`src/shared/analyzers/candidates.ts`). Default-mode, not the literal
  `--production` zero-non-test-consumers check, because `--production` has real false positives here — it
  can't trace every dispatch-table / re-export-alias / dynamic wiring pattern, so live dynamically
  selected functions can flag as unused and it isn't gate-able. The tested-but-unwired class
  (code exercised only by its own tests, never wired into a real call path) is instead worked as a
  periodic **manual audit**: `knip --production` → filter to symbols with zero *grep-detectable*
  production callers (grep finds the dispatch/alias cases knip misses, so a grep-zero is a reliable dead
  signal) → delete symbol + orphaned tests. Re-run when worthwhile, not on a schedule. (`runPlanPhase`
  was exactly this class — call-graph-verified dead, then deleted with its orphaned helpers + tests.)
- **Dead-code stays leads-not-verdicts — no "sound" signal (audit-code side).** Deliberately not pursuing a
  sound dead-code detector (entrypoint provenance + dynamic-import tracing) inside the *acquired-product*
  analyzer: true soundness is undecidable in a language-neutral static auditor (dynamic / dispatch /
  reflection wiring), and it fights the leads-not-verdicts architecture the per-file lens implements. knip's
  `files` / `dependencies` / unused-export output are LEADS the lens confirms or refutes against source,
  never direct findings. (Distinct from the release-gate bullet above, which gates *our own* tree.)

## Known friction & deferred fixes

Tracked in the split backlog — index [`docs/backlog.md`](docs/backlog.md), with one file per section so
each is ONE bounded read: [`open-bugs.md`](docs/backlog/open-bugs.md) (fixable defects + friction),
[`forward-tracks.md`](docs/backlog/forward-tracks.md) (design directions),
[`deferred.md`](docs/backlog/deferred.md) (blocked on data/env),
[`durable-traps.md`](docs/backlog/durable-traps.md) (standing reference, not work). Add an entry when
deferring; remove it when shipped.

**Log friction the moment you hit it** — non-obvious traps, misbehaving tools, missing affordances, shell/env quirks. One line to `docs/backlog/open-bugs.md` if it's a fixable defect, or `docs/backlog/durable-traps.md` if it's a standing environment/tooling gotcha — before moving on. 30-second note now = fix a future session can pick up.

**Entries carry a size budget** (`npm run check:backlog-budget`, in `verify:release`). Entries earn
their length, but the growth driver is post-mortem narrative accreting after the fact — that is what
pushed the single file past 1,700 lines and made every pass navigate it blind. Condense at write
time: the mechanism and the open property belong in the entry, the story belongs in `git log` or a
`docs/reviews/` record.
