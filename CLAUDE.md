# CLAUDE.md

## What this is

Single npm package (`audit-tools`) shipping two autonomous step-driven orchestrators + a shared library, split by area under `src/`. Each `next-step` call returns one backend-rendered prompt contract (JSON + markdown); host agent executes it, calls back for next. State persists to artifact dir → resumable.

- **audit-code** — audits codebases, produces findings report
- **remediate-code** — consumes that report (or free-form), applies fixes

Pipeline: audit → report → remediate.

## Concepts

When a decision is unclear, reason from these:

- **One pipeline, two halves.** audit→findings contract; remediate→consumes+fixes. Each emits machine contract (JSON) + human render (md): `audit-findings.json` / `audit-report.md`; `remediation-outcomes.json` / `remediation-report.md`. JSON = source of truth.
- **Obligation-driven, one bounded step.** Neither tool runs to completion. Each `next-step` derives state, picks highest-priority unsatisfied obligation, does one bounded unit, persists, returns. Resumable, parallelizable, failure-isolated.
- **Right tool, not deterministic dogma.** Three rules, balanced case-by-case — the project is *not* "100% deterministic": (1) where a mechanical/deterministic tool does the job as well as or better than an LLM, use the tool; (2) where a bit of non-deterministic LLM judgment *strongly* improves quality, use the LLM — bounded and recorded (semantic review, synthesis, ambiguity resolution, low-confidence fallbacks); (3) whatever *can* be enforced in tooling must be — never rely on the LLM to follow directions when the property can be guaranteed mechanically (see *Auditor-agnostic robustness*). Rules (1)/(2) choose who does the work; rule (3) constrains how the result is guaranteed regardless of who does it.
- **Right-sized context.** Pre-digest scope/contracts/file lists/evidence/constraints so prompts stay focused and token-efficient.
- **Artifacts are continuity; dependency DAG is truth.** Staleness propagates along explicit dependency map — never ad-hoc freshness checks.
- **Language-neutral by contract.** Graph/artifact shapes language-agnostic. New language support enriches shared contracts; must not fork planning logic per ecosystem.
- **Conversation-first.** Product is the slash workflow inside host conversation; CLI is backend/fallback.

The `src/shared` area (imported as `audit-tools/shared`) single-sources step contract, artifact/graph types, quota model — so the two orchestrators can't drift.

## Layout

**One npm package, `audit-tools`, shipping both bins** (A12 collapsed the former 3-package monorepo). Source is split by area under `src/`:

| Source area | bin / slash command | Role |
|---|---|---|
| `src/shared` | — | Contracts, IO, quota, provider types, validation. Imported as `audit-tools/shared`. |
| `src/audit` | `audit-code` / `/audit-code` | Audit orchestrator. Tests: vitest (`tests/audit/*.test.mjs`). |
| `src/remediate` | `remediate-code` / `/remediate-code` | Remediation orchestrator. Tests: vitest (`tests/remediate/*.test.ts`). |

## Commands

All TypeScript (ES2022, NodeNext, strict), Node 20+. From repo root:

```bash
npm install                       # install deps
npm run build                     # tsc → dist/
npm run check                     # typecheck only (no emit)
npm test                          # build + vitest (audit + shared + remediate)

npx vitest run tests/audit/<file>.test.mjs           # single audit test
npx vitest run tests/remediate/<file>.test.ts        # single remediate test
```

One runner: **vitest** across all three areas (`tests/audit`, `tests/shared`, `tests/remediate`).
The node:test split was retired — audit/shared `.test.mjs` files now use vitest `test`/`describe`/`it`
+ `expect`; `node:assert/strict` is still permitted as an assertion library (it runs fine under
vitest) for the control-flow assertions (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that
have no clean `expect` equivalent.

**Always run `npm install` first** in a fresh clone or worktree — missing `node_modules` → `audit-tools/shared` resolves a stale `dist/` → misleading "no exported member" type errors.

### audit-code (`src/audit`)

```bash
npm test
npx vitest run tests/audit/next-step.test.mjs
npm run verify:release
npm run smoke:packaged-audit-code        # AUDIT_CODE_VERBOSE=1 for verbose
```

Tests use vitest (`test`/`describe`/`it` + `expect`); `node:assert/strict` may still appear for
control-flow assertions. Nested subtests use `describe`/`it`, not `t.test`.

### remediate-code (`src/remediate`)

```bash
npm test
npm run build && npx vitest run tests/remediate/next-step-*.test.ts
npm run verify:release
npm run fixtures:auditor-contract        # regenerate test fixture
node remediate-code.mjs next-step --input report.md   # dev wrapper (auto-rebuilds)
```

## `audit-tools/shared` (the `src/shared` area)

Owns: step contract, session config, run ledger, graph/surface/flow/risk/disposition/access types, JSON IO helpers, validation, `FreshSessionProvider` interface, quota subsystem (rate limiting, sliding window, 429/524/TPM/RPM error parsing, learned limits). Each orchestrator keeps its own `providers/` + `quota/` wiring but conforms to shared contracts.

Imported via the `audit-tools/shared` subpath export (single package — no `@audit-tools/shared` workspace dep).

**Build is a single `tsc`** over the one package (`npm run build` → `dist/`); there are no cross-workspace build-order concerns. When changing a shared contract, rebuild + `npm run check` so both orchestrators typecheck against it.

## audit-code architecture

Obligation-driven. Each invocation executes the highest-priority valid next step. Repeated → normalized repo understanding → bounded audit tasks → verified coverage → findings report.

**Core loop** (`src/audit/orchestrator/advance.ts` → `advanceAudit`):
1. Load artifact bundle from `.audit-tools/audit/`
2. `decideNextStep` (`src/audit/orchestrator/nextStep.ts`) — derives state, picks obligation
3. Dispatch to one executor
4. Persist + return execution summary

The priority chain in `nextStep.ts`: `provider_confirmation` → `repo_manifest` → `file_disposition` → `auto_fixes_applied` → `syntax_resolved` → `external_analyzers_current` → `structure_artifacts` → `graph_enrichment_current` → `design_assessment_current` → `intent_checkpoint_current` → `design_review_contract_completed` → `design_review_conceptual_completed` → `planning_artifacts` → `audit_tasks_completed` → `audit_results_ingested` → `runtime_validation_current` → `synthesis_current` → `synthesis_narrative_current` → `friction_capture_current`

Synthesis emits `audit-findings.json` (machine contract); `audit-report.md` is its render. `synthesis_narrative_current` layers LLM narrative (themes/exec summary/top risks); omits cleanly without provider.

**Artifacts** (`.audit-tools/audit/`): `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `graph_bundle.json`, `critical_flows.json`, `risk_register.json`, `coverage_matrix.json`, `audit_tasks.json`, `task_affinity_graph.json`, `audit_results.jsonl`, `runtime_validation_report.json`, `audit-findings.json`, `synthesis-narrative.json`. Review packets: partitioned JIT at dispatch, never persisted. Staleness: explicit dependency DAG (`spec/audit/dependency-map.md`, `src/audit/orchestrator/staleness.ts`, `src/audit/orchestrator/artifactMetadata.ts`).

**Entrypoint:** `audit-code.mjs` → `wrapper/audit-code-wrapper-lib.mjs`. Conversation-first: `audit-code next-step` writes `.audit-tools/audit/steps/current-step.json` + `current-prompt.md`.

**Providers** (`src/shared/providers/`, thin per-orchestrator wrapper at `src/audit/providers/`): `claude-code`, `codex`, `opencode`, `openai-compatible`, `subprocess-template`, `vscode-task`, `antigravity`, `local-subprocess`. Auto-resolved (`src/shared/providers/providerFactory.ts`); implement `FreshSessionProvider` from shared. `codex` is headless CLI auto-detected like `claude-code`; `antigravity` is agentic-IDE backend routed through a configured command/task template. `openai-compatible` is NOT a CLI — it's a single-shot, API-driven worker (the `llm write` pattern as a provider): it POSTs the node prompt to any OpenAI-compatible `/chat/completions` endpoint (NVIDIA NIM / vLLM / LM Studio / …), applies the returned `{files,result}` into the node's worktree, and writes the result. Endpoint/model/key are operator-supplied in session config (`openai_compatible.{base_url,model,api_key_env}`) — never hardcoded — so it's a portable, always-available background dispatch pool, and the backend the in-process rolling engine drives for headless autonomy.

**Schemas** (`schemas/`): `AuditResult` contract (`schemas/audit_result.schema.json`) — `task_id`, `unit_id`, `pass_id`, `lens` must match assigned task; `file_coverage[].total_lines` must match actual line counts.

**Lenses:** `correctness`, `architecture`, `maintainability`, `security`, `reliability`, `performance`, `data_integrity`, `tests`, `operability`, `config_deployment`, `observability`.

**Other modules:** `src/audit/extractors/` (deterministic repo analysis), `src/audit/adapters/` (normalize semgrep/eslint/npm-audit), `src/audit/io/`, `src/audit/validation/`, `src/audit/reporting/` (synthesis + work-block rendering), `src/audit/supervisor/` (session config, run ledger, operator handoff).

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
- document phase (`ItemSpec` per finding: concrete changes, tests to write) — now in `src/remediate/steps/dispatch.ts` (former `src/phases/document.ts` inlined into the dispatch step)
- implement phase (dispatches implementation with test execution + verification) — now in `src/remediate/steps/dispatch.ts` (former `src/phases/implement.ts` inlined into the dispatch step)
- `triage.ts` — failed items; retry vs. block
- `close.ts` — closing actions (test suites, build, lint)

**Dispatch:** parallel waves (`src/remediate/steps/dispatch.ts`: `prepareImplementDispatch` / `mergeImplementResults`, plus `scheduleWave` / `resolveHostConcurrencyLimit` for concurrency limiting — the former `src/steps/waveScheduler.ts` is inlined into `dispatch.ts`). Providers mirror audit-code's backend set.

**State persistence** (`src/remediate/state/store.ts`): file-backed `RemediationState`, atomic temp-then-rename writes, guarded by the shared `withFileLock` (`audit-tools/shared/quota/fileLock`: exponential 50ms→500ms backoff, token-checked 30s stale-lock cleanup). The lock is single-sourced — `store.ts` adds no backoff/retry logic of its own.

**Core types** (`src/remediate/state/types.ts`): `Finding`, `RemediationPlan`, `RemediationBlock`, `ItemSpec`, `ClarificationRequest`, `RemediationItemState`, `CoverageLedger`. `TestSpec` lives in `src/shared/types/contractPipeline.ts`. `src/remediate/dedup/crossLensDedup.ts` deduplicates across lenses; `src/remediate/intake.ts` orchestrates source manifest, summary, clarification resolution.

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

Via `.github/workflows/publish-package.yml`. Triggered by publishing a GitHub Release (tagged `vX.Y.Z`) or manual `workflow_dispatch`. Uses npm Trusted Publishing (OIDC) — no tokens. Pre-release (`-` in version) → `next` dist-tag, else `latest`. CI: parallel `gate` (`verify:checks`) and `test` (4-way sharded `vitest run`) jobs → `publish` (needs both).

Trigger via package's `release:patch` / `:minor` / `:major` scripts (bump + commit + tag) or `:publish` variants (also push + create GitHub Release + wait for CI). Use `/ship` skill — encodes trap list (CLAUDECODE unset for gates, CRLF clean-tree guard, allow-scripts postinstall on global reinstall, release-CI-is-the-real-signal) and never parks at push/publish boundary.

## Conventions & invariants

- **Auditor-agnostic robustness — enforce in tooling, never host discretion.** The host/auditor agent is a variable of any strength, not a constant. Every workflow correctness property must be guaranteed by the tool itself — CLI option shape, contract validator, renderer template, dispatch-prompt text, scheduler logic, merge tolerance, write-scope enforcement — never by the host *remembering*, *noticing*, or *reasoning*. Any place the workflow only works because a capable host folded in guidance, relayed upstream evidence, paced dispatch safely, picked the right id, verified from disk, or hand-fixed a cross-block break is a **latent failure mode** → move it into the tool so it's impossible to get wrong. "Be careful" / "habit fix" / "my side" is never a fix; prefer changes that make the process *simpler*, not ones that add a step the host must remember. (Generalizes "Conversation-first" and "a needed manual flag is a bug signal".)
- **Conversation-first.** Normal usage: no manual `--root`, provider, or model flags. Auto-resolution handles it.
- **One bounded step per invocation.** Neither orchestrator runs to completion in a single call.
- **Upstream-valid before downstream-refresh.** Don't refresh a downstream artifact until its upstream dependencies are valid (staleness ordering — see *Right tool, not deterministic dogma* for the deterministic-vs-LLM choice itself).
- **Language-neutral graph.** Edges: `from`, `to`, `kind`, optional `direction`/`confidence`/`reason`. New analyzers enrich shared artifacts, don't fork planning.
- **Never hardcode model identities.** No model names, context/output windows, tier→model maps, or "available model" lists in backend code. Discover dynamically from host/provider/IDE. Tiering = relative advertised capability (cheapest/mid/top). Hardcoded model table = bug.
- **Everything-agnostic by default.** Provider/backend, host IDE/agent, **OS/platform**, model, shell, and language/ecosystem are ALL runtime-discovered or contract-abstracted — never baked in. The named rules (provider/model/IDE-agnostic, language-neutral, LLM-always-in-the-loop) are *instances* of ONE principle, not a closed list — any new coupling to a specific environment is a bug to fix at the abstraction, not to document as a flag. **OS/platform-agnostic** specifically: no platform-baked path / shell / command / line-ending assumptions in core logic — route them through the existing abstractions (`resolveWindowsShimSpawnCommand`, `normalizeRepoPath`, the `.audit-tools` path module, `toPromptPathToken`, the env-scrub in `spawnLoggedCommand`) so identical code runs on win32 / darwin / linux. When you add a capability, ask "does this assume a particular provider / IDE / OS / model / shell / language?" — if yes, abstract it.
- **LLM always in the loop.** Conversation-first = host agent is always the provider. Never gate LLM review behind "if a provider exists."
- **Windows-aware** (the most-exercised instance of *OS-agnostic* above, not the boundary of it). Package-manager shims run through the command shell; `.cmd` / `.ps1` wrappers resolve reliably (`resolveWindowsShimSpawnCommand`).
- **Host prompts are cwd-explicit.** Commands must be cwd-independent or state exact workdir. Prefer `workdir` on the tool over asking workers to `cd`.
- **PowerShell JSON generation is statement-safe.** Assign `foreach` output to a var first, then pipe to `ConvertTo-Json`.
- **Extractors emit stable, content-derived array order.** Any artifact array field must be ordered by a stable key derived from content (e.g. path-sort), never filesystem / `readdir` / iteration order. `stableStringify` preserves array order, so an incidentally-ordered array silently churns the artifact's content hash on every re-extraction → cascades phantom staleness down the dependency DAG → redundant (expensive) downstream LLM re-runs. Any new extractor emitting an incidentally-ordered array is a latent churn source.
- **Atomic-replace ordering invariant.** Every destructive change — deleting a fast path, phase, scheduler, cap, or monolithic pass — ships as single atomic replace: new mechanism + deletion in one commit. Never add-then-delete across commits.
- **Green-at-every-commit.** Before any push: `npm run build && npm run check` → zero errors. Hook-enforced since 2026-06-11: PreToolUse blocks `git commit` until check is green; async PostToolUse typechecks edited package after TS edits (`.claude/hooks/`).
- **End-of-sprint cleanup — run it every sprint, unprompted.** A *sprint* = any coherent stretch of work that ends at a pause, handoff, or milestone (a shipped item, "wrap up here", switching windows). Before handing off, ALWAYS run the cleanup pass (don't wait to be asked): (1) **verify green** — `npm run build && npm run check` + the touched package's test suite, on a **clean, fully-pushed tree**; (2) **scan the sprint's diff** for dead code / orphaned helpers / stray `console`/`TODO`/debug and remove them; (3) **ensure no half-done broken state** — and call out any *deliberate* intermediate state in the handoff so it isn't mistaken for a bug; (4) **trim `docs/HANDOFF.md`** to lean + accurate (correct HEAD/commits, immediate-next-only, never a changelog); (5) **update `docs/backlog.md`** program-of-record status; (6) **sync memory + its index**; (7) **state remaining next steps explicitly, and name the document each lives in** — the closeout (and the chat hand-back) must say either "nothing pending" or list each remaining item with its home: immediate next step → `docs/HANDOFF.md`; open bugs / forward tracks → `docs/backlog.md`; durable design/decisions/status → project memory + `MEMORY.md` index; durable how-to → `CLAUDE.md`. Never leave a remaining step implied or living only in chat. Render the hand-back to the markdown scheme in [`docs/end-of-sprint-report-template.md`](docs/end-of-sprint-report-template.md) (timeless template — never commit a filled dated copy). (the owner, 2026-06-16; next-steps-and-doc-homes element + report template added 2026-06-25.)

## Preferences & standing decisions

- **Ideal code over compatibility.** One user, no external consumers → cleanest design, delete deprecated/legacy paths. **Implementation effort/complexity/refactor-size is NOT a cost** — only the eventual endpoint (cleanest/most-efficient/most-robust) matters. Never defer, stage-to-avoid-work, or pick a lighter half-measure because the ideal is "a lot of work" or "a big atomic change." The only thing that gates pace is correctness (green-at-every-commit, no broken/lossy intermediate states) — that's doing it right, not avoiding the work.
- **Keep orchestrators in parity.** Fix in one usually belongs in both; genuinely shared logic → `audit-tools/shared`.
- **Docs capture durable concepts, not current state.** Timeless conceptual docs only. Exception: single handoff doc for immediate next steps. Full statement (one-home-per-concept, status-noise, condensation bias) in [`docs/documentation-philosophy.md`](docs/documentation-philosophy.md) — the canonical philosophy the doc-review routine enforces.
- **A needed manual flag is a bug signal.** Fix auto-resolution; don't document the flag.
- **Resolve toward durable contract.** LLM-vs-deterministic → deterministic; graph/language → language-neutral contract.
- **Budget context before LLM dispatch.** Small obligation-specific packets; expand only when genuinely needed.
- **Split design assessment into two named modes.** *Contract assessment* (invariants/boundaries/obligations) vs. *conceptual design critique* (philosophy/alternatives/better directions). Bare "design assessment" = too ambiguous.
- **Caveman mode (full) active globally.** Ultra-compressed telegraphic prose across all responses and agents. the owner toggles off when clarity needed.
- **Redesign before scheduled autonomy.** Architecture stabilizes first; then build scheduled audit→remediate→PR loop once on new architecture.
- **Token/context policy lives in `~/.claude/CLAUDE.md`.** Don't duplicate here.
- **Token estimates stay local and deterministic (2026-06-11).** Never API-call token counting in planning/dispatch. No tokenizer dep — shared `estimateTokensFromBytes` primitive is the standard. Learned RPM/TPM limits authoritative; headroom proxy stats supply measured usage.
- **Two-tier dependency policy — import vetted libs for correctness-sensitive parsing/schema/lock; own only tiny domain bits (2026-06-17, A5).** A format whose grammar we don't fully own (TOML, YAML, lockfiles, schema validation) is *correctness-sensitive*: a hand-rolled scanner silently drops what it doesn't understand (e.g. the TOML line scanner missed inline-table / dotted-key / quoted forms → dropped dependency-graph edges). Import a vetted, pure-JS, well-maintained parser there (`smol-toml`, `yaml`) — pure-JS so OS-agnostic, no native build. Keep hand-rolled only for *tiny, fully-owned* domain bits (e.g. our `.audit-tools` path tokens, the work-block id grammar). When importing: wrap the parser so malformed input degrades to empty (the graph/extractors never throw on a bad manifest), and single-source the parse + safe accessors in one module.
- **Dead-code release gate — default-mode knip, not `--production` (2026-06-27).** `npm run check:deadcode`
  (runs `knip --no-config-hints`, with `include: ["exports","types","nsExports","nsTypes"]` set in
  `knip.json`; wired into `verify:release`) fails the build on any
  exported symbol with zero consumers anywhere, including tests. This gates our own source tree at release
  time — distinct from knip's separate use as an *acquired product analyzer* audit-code runs against
  repos it audits (`src/audit/extractors/analyzers/candidates.ts`). Default-mode, not the literal
  `--production` zero-non-test-consumers check, because `--production` has real false positives here — it
  can't trace dispatch-table / re-export-alias / dynamic wiring, so live functions like `runPlanPhase` /
  `resolveFreshSessionProviderName` flag as unused and it isn't gate-able. The tested-but-unwired class
  (code exercised only by its own tests, never wired into a real call path) is instead worked as a
  periodic **manual audit**: `knip --production` → filter to symbols with zero *grep-detectable*
  production callers (grep finds the dispatch/alias cases knip misses, so a grep-zero is a reliable dead
  signal) → delete symbol + orphaned tests. Re-run when worthwhile, not on a schedule.
- **Dead-code stays leads-not-verdicts — no "sound" signal (audit-code side).** Deliberately not pursuing a
  sound dead-code detector (entrypoint provenance + dynamic-import tracing) inside the *acquired-product*
  analyzer: true soundness is undecidable in a language-neutral static auditor (dynamic / dispatch /
  reflection wiring), and it fights the leads-not-verdicts architecture the per-file lens implements. knip's
  `files` / `dependencies` / unused-export output are LEADS the lens confirms or refutes against source,
  never direct findings. (Distinct from the release-gate bullet above, which gates *our own* tree.)

## Known friction & deferred fixes

Tracked in [`docs/backlog.md`](docs/backlog.md). Add entry when deferring; remove when shipped.

**Log friction the moment you hit it** — non-obvious traps, misbehaving tools, missing affordances, shell/env quirks. One line to `docs/backlog.md` — under *Open bugs / frictions* if it's a fixable defect, or *Durable traps* if it's a standing environment/tooling gotcha — before moving on. 30-second note now = fix a future session can pick up.
