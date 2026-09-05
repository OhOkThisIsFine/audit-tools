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
npm run check:scripts             # typecheck the .mjs trees (scripts/, wrapper/, .claude/hooks/, dispatch/, the two root entries — tsconfig.scripts.json; in verify:checks, pre-commit leg)
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

Obligation-driven: **ONE obligation registry, ONE drain, ONE lock hold** (CX-02). The registry
DERIVES from the single-sourced `PRIORITY` array (`src/audit/orchestrator/nextStep.ts`, running
`repo_manifest` → … → `friction_capture_current`) — never a second hand-enumerated list — and each
id carries its per-obligation host-boundary POLICY: a pure branch classifier both draws share
(`src/audit/orchestrator/obligationPolicy.ts`), plus, in the full fold only, the consuming body.
Two draws run the shared obligation engine over that one registry:

- **The full `next-step` fold** (`src/audit/cli/nextStepHelpers.ts` → `runDeterministicForNextStep`)
  acquires the artifact-tree lock ONCE (`withArtifactTreeHold`), loads the bundle once, and drains
  in memory — each deterministic dispatch is one `runSingleAdvanceStep` on the CARRIED bundle
  (never a reload; a mid-fold reload reads the fold's own unwritten state and rolls it back). A
  consumed host submission is STAGED first — renamed into the run's submission-staging directory
  before it is parsed or applied; the fold then COMMITS once at its boundary (`commitFold`: the pruned core-artifact
  write, design-review snapshots, staged deletions, and their deferred `accepted` ledger events) on
  EVERY exit including the throw path, which also persists dispatch-local failure attribution.
  Markers (`steps/deterministic-progress.json`), handoff, quarantine, and the durable analyzer
  stores stay mid-fold by design — the delivered property is one CORE write boundary, not one
  persist boundary. The cycle guards live in the fold's ctx and observe per deterministic dispatch.
- **The plan draw** (`audit-code plan`, and any unforced `advanceAudit`) is the deterministic-only
  draw: classify each engine-selected obligation, run deterministic arms, HALT at the first
  boundary that needs host work or would consume or persist host input. It never consumes a
  submission and never emits a host step of its own.

The per-invocation cap is the engine's charged-execution budget
(`maxExecutions = MAX_DRAIN_STEPS`, unit: obligation executions — policy transitions included), stopped
structurally (`stopped: "budget"`, resumable); the derived transition bound
(`engineMaxTransitions()`) is the backstop that can no longer fire first. A forced
`preferredExecutor` runs EXACTLY ONE step and never enters the drain. Backend/model choice,
concurrency, retries, and failover belong entirely to the conversation host and never enter the
audit graph.

Synthesis emits `audit-findings.json` (machine contract); `audit-report.md` is its render. `synthesis_narrative_current` is a bounded semantic host step for themes, executive summary, and top risks; the tool validates and ingests the returned narrative.

**Artifacts** (`.audit-tools/audit/`): the authoritative set is the `ARTIFACT_DEFINITIONS` registry in `src/audit/io/artifacts.ts` — machine contracts as `*.json`, human renders as `*.md` (synthesis emits `audit-findings.json` + its `audit-report.md` render). Read the registry for the full, current list rather than a copy here (it has drifted when copied). Review packets: partitioned JIT at dispatch, never persisted. Staleness: explicit dependency DAG (`spec/audit/dependency-map.md`, `src/audit/orchestrator/staleness.ts`, `src/audit/orchestrator/artifactMetadata.ts`).

**Entrypoint:** `audit-code.mjs` → `wrapper/audit-code-wrapper-lib.mjs`. Conversation-first: `audit-code next-step` writes `.audit-tools/audit/steps/current-step.json` + `current-prompt.md`.

**Host handoff** (`src/audit/cli/dispatch/hostHandoff.ts`; it and its remediate twin share their substrate through `audit-tools/shared`): the tool writes a versioned workload, prompt digests, task bindings, and a result map beneath the run directory. The host may execute the work however it chooses. Ingestion accepts only prompt-bound results with the expected run/task identity and file coverage, records accepted results idempotently, and rejects backend/model/routing fields. audit-tools never launches the work itself.

**Schemas** (`schemas/`): `AuditResult` contract (`schemas/audit_result.schema.json`) — `task_id`, `unit_id`, `pass_id`, `lens` must match assigned task; `file_coverage[].total_lines` must match actual line counts.

**Lenses:** the eleven-lens vocabulary is single-sourced in `src/shared/types/lens.ts` (`LensSchema`) — read it there, never from a copy. A hand copy of this list drifted once before and wrongly rejected a lens; that module's header records the incident.

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
  planning then transitions DIRECTLY to implementing. There is no per-item specification artifact —
  `ItemSpec` was deleted outright (owner, 2026-08-25) after the N-R13 ratification, because nothing in
  production ever wrote one. The enforced write scope is
  `block.touched_files`, normalized into the work item's `allowed_files` by `buildWorkItem`
  (`src/remediate/steps/dispatch/hostHandoff.ts`) and re-checked against the landed diff at ingestion.
  `touched_files` is produced upstream two ways: the contract pipeline's `deriveNodeFiles` (node
  `output_files` → `files_likely_touched` → the matched module's `file_scope`), which makes it a SIBLING
  of `finding.affected_files` rather than a derivation of it; or, on the no-blocks branch of
  `normalizeExtractedPlan` (`src/remediate/steps/nextStep.ts`) — reached by a plan supplied from OUTSIDE
  the pipeline — copied straight from `finding.affected_files`. Both gates
  in `src/remediate/steps/nextStep.ts`; dispatch in `src/remediate/steps/dispatch/` (the
  host-handoff module above — the re-export barrel was deleted, CY-03; import the submodules directly).
- implement phase (dispatches implementation with test execution + verification) — in `src/remediate/steps/dispatch/`
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
- **Universal host prompts, single-sourced.** Each shipped loader has ONE canonical prompt body (`skills/<bin>/<bin>.prompt.md`); every IDE/host asset is RENDERED from it (`src/shared/hostAssets.ts`), never authored per IDE. Fix the body and regenerate; a hand edit to a rendered asset is drift. (This is the canonical home of the conviction; `docs/project-philosophy.md` maps to it.)
- **One bounded step per invocation = a fold-aware drain, not a single obligation.** "Bounded" is the *drain-with-fold-aware-halt* model: a call drains the deterministic obligation frontier (highest-priority-first, the default), folding successive steps together and halting at the first host-input pause, non-drainable step, or the charged-execution budget (`MAX_DRAIN_STEPS` obligation executions, the engine's `maxExecutions` — a structured resumable pause, never a throw). Deterministic steps that require no host judgment fold silently; anything operator-interactive breaks the fold. Neither orchestrator runs to completion in a single call, and no call crosses a host-input boundary.
- **Upstream-valid before downstream-refresh.** Don't refresh a downstream artifact until its upstream dependencies are valid (staleness ordering — see *Right tool, not deterministic dogma* for the deterministic-vs-LLM choice itself).
- **Language-neutral graph.** Edges: `from`, `to`, `kind`, optional `direction`/`confidence`/`reason`. New analyzers enrich shared artifacts, don't fork planning.
- **No execution inventory in this package.** Model identities, windows, prices, rate limits, capability tiers, and provider rosters are host concerns. Do not discover, sync, persist, or route on them inside audit-tools; emitted workloads carry only content-derived complexity, risk, token estimates, scope, and prompt bindings.
- **Everything-agnostic by default.** Provider/backend, host IDE/agent, **OS/platform**, model, shell, and language/ecosystem are outside the contract or abstracted — never baked in. The named rules (provider/model/IDE-agnostic, language-neutral, LLM-always-in-the-loop) are *instances* of ONE principle, not a closed list. **OS/platform-agnostic** specifically: no platform-baked path, shell, command, or line-ending assumptions in core logic — route them through the existing abstractions (`resolveExecArgv`, `normalizeRepoPath`, the `.audit-tools` path module, `toPromptPathToken`, and the shared execution boundary) so identical code runs on win32 / darwin / linux.
- **LLM always in the loop.** Conversation-first means the host performs every semantic obligation and returns the bound result. Never gate semantic review on provider discovery inside audit-tools.
- **Windows-aware** (the most-exercised instance of *OS-agnostic* above, not the boundary of it). Package-manager shims run through the command shell; `.cmd` / `.bat` wrappers resolve reliably through `resolveExecArgv`.
- **Host prompts are cwd-explicit.** Commands must be cwd-independent or state exact workdir. Prefer `workdir` on the tool over asking workers to `cd`.
- **PowerShell JSON generation is statement-safe.** Assign `foreach` output to a var first, then pipe to `ConvertTo-Json`.
- **Extractors emit stable, content-derived array order.** Any artifact array field must be ordered by a stable key derived from content (e.g. path-sort), never filesystem / `readdir` / iteration order. `stableStringify` preserves array order, so an incidentally-ordered array silently churns the artifact's content hash on every re-extraction → cascades phantom staleness down the dependency DAG → redundant (expensive) downstream LLM re-runs. Any new extractor emitting an incidentally-ordered array is a latent churn source.
- **Atomic-replace ordering invariant.** Every destructive change — deleting a fast path, phase, scheduler, cap, or monolithic pass — ships as single atomic replace: new mechanism + deletion in one commit. Never add-then-delete across commits. **Scoped to `main` (owner, 2026-08-27, PH-04 accepted narrowly):** a temporary internal seam MAY exist between commits on a branch, provided every commit is green and the seam is gone before that branch merges. The endpoint and what lands on `main` are unchanged — this buys a large replace an intermediate review checkpoint, not a staged landing.
- **A gate states the boundary it OWNS (owner, 2026-08-27, PH-05 accepted in part).** *Whatever can be
  enforced in tooling must be* stands. What is added is an authority test, and only that: a new gate
  names the boundary at which it is authoritative, and a gate that GUESSES at a boundary owned by
  something else is moved to the boundary that owns it rather than left guessing. The named instance is
  `pre-commit-gate.mjs` parsing arbitrary shell text to locate git's own boundary. The cost half of
  PH-05 — a gate must also clear an avoided-defect-versus-false-positive bar — was NOT accepted: a
  working gate's avoided defects are unobservable, so that test cannot be applied honestly.
- **Durable traps are MECHANICALLY enforced, not remembered.** A trap that can be enforced is enforced,
  and its backlog entry is DELETED rather than restated (two copies decay independently; the mechanism
  states the trap and the fix when it fires). Enforcement is a **hook** when the trap is detectable at a
  tool call, and a **contract test** when it is instead a property of the tree — a test is equally
  binding and equally self-describing, so it earns the same deletion. A trap enforced only *partly* is
  NOT deletable: state the uncovered half outright, or the covered half reads as a close (a live
  example in [`durable-traps.md`](docs/backlog/durable-traps.md) — the `.mjs` test holdout
  `checkJs:false` excludes from `check:tests`). The guards live in `.claude/hooks/`; what each fires
  on and refuses is stated in its registry row and its own header, never in this paragraph
  (a dispatched child sets `AUDIT_TOOLS_CHILD_SESSION=1` and is exempt from the session-scoped Stop gates).
  **Guard wiring + reach are DECLARED DATA, never prose:** `scripts/guard-reach-data.mjs` is the
  authoritative registry of every guard (gate / hook / contract-test); read the registry for what it
  records about each, never a copy here. `npm run check:guard-reach` (in `verify:checks`, plus an unconditional
  pre-commit leg) reconciles the registry against the tracked tree: a tracked file no row claims, a guard
  wired into no gate, or a hook / check script outside the registry is a red build. The registry — not
  this paragraph — is the authoritative list of hook contract tests (all under `tests/` because vitest
  excludes `.claude/**`, so a test beside a hook never runs in CI). **Adding a hook:** register it in `.claude/settings.json` AND add the
  `!.claude/hooks/<name>` line to `.gitignore` in the SAME commit — the commit gate blocks a settings.json
  that references a hook the commit would not carry.
- **Green-at-every-commit.** Before any push: `npm run build && npm run check` → zero errors. Hook-enforced: PreToolUse blocks `git commit` until check is green, plus the pre-commit leg set — the legs and their staged-set triggers are DERIVED from the guard registry (`scripts/guard-reach-data.mjs`, via `buildPreCommitLegs`); read the registry, never a list here — it is what catches the checks that otherwise fail only in release CI and burn a tag. Async PostToolUse typechecks edited package after TS edits (`.claude/hooks/`). A commit whose staged set touches a loop-core path (`src/shared/loopCorePaths.ts` — orchestrator, planning, host-handoff, and result-ingestion substrate) is additionally blocked until a fresh, staged-tree-bound review attestation exists (`node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> --attester-class <agent|human> --checked "<...>"`); the gate enforces attestation existence+freshness+binding, not review quality. The attestation is an attributable, tree-bound audit record — it RECORDS the attester's class (agent or human; required, plus detected agent-session env markers) and the reviewing identities, it does not and cannot enforce that a human reviewed. Destination-keyed: a `concerns` verdict without an override blocks only a commit that can land on `main`; on any other branch it is accepted (WIP preservation must not train the override into a reflex).
- **End-of-sprint cleanup — run it every sprint, unprompted.** A *sprint* = any coherent stretch of
  work that ends at a pause, handoff, or milestone (a shipped item, "wrap up here", switching
  windows). **The steps, their order and their count live in ONE place — *Closing out work* in
  `~/.claude/portable-engineering-principles.md`, mirrored to
  `C:/Code/portable-engineering-principles.md`. Read them there.** What follows is only what that
  schema cannot know: this repo's BINDINGS for the steps that name a destination. It is not a second
  statement of the schema, so it can neither drift from it nor be read instead of it.
  - **Verify green** = `npm run build && npm run check` plus the touched area's suite, on a clean,
    fully-pushed tree.
  - **Route durable facts:** open bugs and friction → [`docs/backlog/open-bugs.md`](docs/backlog/open-bugs.md);
    forward tracks → [`docs/backlog/forward-tracks.md`](docs/backlog/forward-tracks.md); a standing
    environment or tooling gotcha → [`docs/backlog/durable-traps.md`](docs/backlog/durable-traps.md);
    durable design, decisions and status → project memory **and** its
    `~/.claude/projects/…/memory/MEMORY.md` index (the external per-project host-memory store, not an
    in-repo file); durable how-to → `CLAUDE.md`. Bring the backlog's program-of-record status current.
  - **The status doc** is [`docs/HANDOFF.md`](docs/HANDOFF.md) — lean and accurate, correct
    HEAD/commits, immediate-next only, never a changelog. It is also where the immediate next step
    lives when the closeout states what remains.
  - **RENDER the hand-back** — `node scripts/render-closeout.mjs --in <closeout.json>` (`--template`
    for a blank input), documented in
    [`docs/end-of-sprint-report-template.md`](docs/end-of-sprint-report-template.md). It refuses until
    every section declared in `scripts/closeout-sections-data.mjs` states content or the literal
    `"none"`, then OMITS the silent ones — so the report stays short AND a dropped section cannot hide
    as a short one. Never hand-write it: the Stop challenge reads the record the renderer writes, and
    that record is bound to the worktree CONTENT and to the session that rendered it — so neither a
    later commit of what the report described nor an earlier session's render satisfies it. Never
    commit a filled dated copy.
  - ⚠ **The `/closeout` skill's steps 1-2 do NOT apply here.** They record and check a
    <!-- doc-citation-exempt: machine-wide file in ~/.agent-config, not tracked in this repo -->
    `verify-green.mjs` ledger; this repo owns the equivalent (`suiteGreenStamp` plus the closeout Stop
    gate). Do not double-wire them. Every other step of that skill applies as written.

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
  2026-08-09: ZERO execution adapters, metadata only). The tool characterizes work — per-task risk,
  complexity, local token estimates, scope, lens — and partitions on **content coherence**; choosing
  which backend runs it, and every provider, quota, sizing, and launch fact behind that choice, is
  the host's. A backend's context or output cap is transport config and never enters the tool, so
  `work_blocks` in `audit-findings.json` is a coherence grouping plus an estimate, never a fit
  claim. What stays is result **ingestion** (consumption, not execution) and the right to faithfully
  RECORD what the host says ran — *not routing does not mean not knowing*.
  ⚠ The old provider, quota, routing, backend-sizing, and launch substrate was retired as ONE
  architectural cut; do not recreate it. Provenance (the three same-day supersessions): git log,
  2026-08-09.
- **A needed manual flag is a bug signal.** Fix canonical root/state resolution; do not document a workflow flag. Execution choices are host-owned inputs to neither CLI.
- **Resolve toward durable contract.** LLM-vs-deterministic → deterministic; graph/language → language-neutral contract.
- **Budget context before LLM dispatch.** Small obligation-specific packets; expand only when genuinely needed.
- **Split design assessment into two named modes.** *Contract assessment* (invariants/boundaries/obligations) vs. *conceptual design critique* (philosophy/alternatives/better directions). Bare "design assessment" = too ambiguous.
- **Caveman mode (full) active globally.** Ultra-compressed telegraphic prose across all responses and agents. the owner toggles off when clarity needed.
- **Redesign before scheduled autonomy.** Architecture stabilizes first; then build scheduled audit→remediate→PR loop once on new architecture.
- **Token/context policy lives in `~/.claude/CLAUDE.md`.** Don't duplicate here.
- **Token estimates stay local and deterministic.** Never API-call token counting in planning or host-handoff generation. No tokenizer dependency — shared `estimateTokensFromBytes` is the standard. An estimate describes content size only; it is never a backend-fit claim.
- **Two-tier dependency policy — import vetted libs for correctness-sensitive parsing/schema/lock; own only tiny domain bits.** A format whose grammar we don't fully own (TOML, YAML, lockfiles, schema validation) is *correctness-sensitive*: a hand-rolled scanner silently drops what it doesn't understand (e.g. the TOML line scanner missed inline-table / dotted-key / quoted forms → dropped dependency-graph edges). Import a vetted, pure-JS, well-maintained parser there (`smol-toml`, `yaml`) — pure-JS so OS-agnostic, no native build. Keep hand-rolled only for *tiny, fully-owned* domain bits (e.g. our `.audit-tools` path tokens, the work-block id grammar). When importing: wrap the parser so malformed input degrades to empty (the graph/extractors never throw on a bad manifest), and single-source the parse + safe accessors in one module.
- **Own-vs-acquire analyzer engine — own the agnostic extractors, acquire + normalize the rest.** OWN only truly language-agnostic extractors in-house (git-history mining); ACQUIRE ecosystem-native analyzers on demand and NORMALIZE their output into *leads*, never direct findings (npm-audit is not acquired — an npm-audit JSON report enters as imported external-analyzer input, `src/audit/cli/importExternalAnalyzerCommand.ts`, never a spawn). Every acquired-tool spawn routes through the single `admitSpawn` chokepoint: a recorded operator `declined` refuses OUTRIGHT and no consent token overrides it; the curated DEFAULT set is admitted without a token; every other candidate requires the PER-RUN consent token. **Consent binds the ACQUIRED-analyzer role, not the binary** — the same executable invoked as repo-local tooling is admitted by the decline-only local gate (`admitLocalSpawn`, `src/audit/orchestrator/localCommands.ts`). **The two consent lifetimes are asymmetric by design:** a DECLINE is durable; a GRANT binds the run that asked and dies with it. Both halves are mechanical, pinned by `tests/shared/consent-token-not-persisted.test.ts` (a grant has no durable shape to be written into) — the full argument lives in that test and [[deterministic-analyzers-own-vs-acquire]], not here. The candidate registry lives in `src/shared/analyzers/candidates.ts` (the remediation verify draw re-runs the same pinned spec; audit re-exports through `src/audit/extractors/analyzers/registry.ts`), and `verifyAnalyzerLeads` (`src/remediate/phases/closeVerifyAnalyzerLeads.ts`) is a close-gate verify leg, never a `CLOSING_ACTIONS` entry. Decided-against acquisitions: [`durable-traps.md`](docs/backlog/durable-traps.md).
- **Dead-code release gate — default-mode knip, not `--production`.** `npm run check:deadcode`
  (runs `knip --no-config-hints`, with `include: ["files","exports","types","nsExports","nsTypes"]` set in
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
each is ONE bounded read: [`open-bugs.md`](docs/backlog/open-bugs.md) (fixable defects + friction, at
high/medium severity or untagged), [`minor-bugs.md`](docs/backlog/minor-bugs.md) (the same thing at LOW
severity — split off 2026-08-28 on size alone, not on standard; re-tagging an entry moves it),
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
