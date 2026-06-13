# CLAUDE.md

## What this is

npm-workspaces monorepo. Two autonomous step-driven orchestrators + shared library. Each `next-step` call returns one backend-rendered prompt contract (JSON + markdown); host agent executes it, calls back for next. State persists to artifact dir → resumable.

- **audit-code** — audits codebases, produces findings report
- **remediate-code** — consumes that report (or free-form), applies fixes

Pipeline: audit → report → remediate. Each published independently to npm.

## Concepts

When a decision is unclear, reason from these:

- **One pipeline, two halves.** audit→findings contract; remediate→consumes+fixes. Each emits machine contract (JSON) + human render (md): `audit-findings.json` / `audit-report.md`; `remediation-outcomes.json` / `remediation-report.md`. JSON = source of truth.
- **Obligation-driven, one bounded step.** Neither tool runs to completion. Each `next-step` derives state, picks highest-priority unsatisfied obligation, does one bounded unit, persists, returns. Resumable, parallelizable, failure-isolated.
- **Deterministic by default; LLM only for judgment.** LLM reserved for semantic review, synthesis, ambiguity resolution, low-confidence fallbacks — always bounded and recorded.
- **Right-sized context.** Pre-digest scope/contracts/file lists/evidence/constraints so prompts stay focused and token-efficient.
- **Artifacts are continuity; dependency DAG is truth.** Staleness propagates along explicit dependency map — never ad-hoc freshness checks.
- **Language-neutral by contract.** Graph/artifact shapes language-agnostic. New language support enriches shared contracts; must not fork planning logic per ecosystem.
- **Conversation-first.** Product is the slash workflow inside host conversation; CLI is backend/fallback.

`@audit-tools/shared` single-sources step contract, artifact/graph types, quota model — so the two orchestrators can't drift.

## Layout

| Directory | npm package | bin / slash command | Role |
|---|---|---|---|
| `packages/shared` | `@audit-tools/shared` | — | Contracts, IO, quota, provider types, validation. **Built first.** |
| `packages/audit-code` | `auditor-lambda` | `audit-code` / `/audit-code` | Audit orchestrator. Tests: `node --test` (`tests/*.test.mjs`). |
| `packages/remediate-code` | `remediator-lambda` | `remediate-code` / `/remediate-code` | Remediation orchestrator. Tests: vitest (`tests/*.test.ts`). |

Three-way naming mismatch (dir vs npm name vs bin). `npm -w` accepts either.

## Commands

All TypeScript (ES2022, NodeNext, strict), Node 20+. From repo root:

```bash
npm install                       # installs + symlinks workspaces
npm run build                     # tsc → dist/ all workspaces
npm run check                     # typecheck only (no emit), all workspaces
npm test                          # build + test, all workspaces

npm run build -w @audit-tools/shared
npm test -w packages/audit-code
```

**Always run root `npm install` first** in fresh clone or worktree — missing `node_modules`/symlinks → stale `shared/dist` → misleading type errors.

### audit-code (`packages/audit-code`)

```bash
npm test
npm run test:single -- tests/next-step.test.mjs
npm run verify:release
npm run smoke:packaged-audit-code        # AUDIT_CODE_VERBOSE=1 for verbose
```

Tests use `node:test` / `node:assert`. Subtests must be `await t.test(...)` (Node 22 compat).

### remediate-code (`packages/remediate-code`)

```bash
npm test
npm run build && npx vitest run tests/next-step.test.ts
npm run verify:release
npm run fixtures:auditor-contract        # regenerate test fixture
node remediate-code.mjs next-step --input report.md   # dev wrapper (auto-rebuilds)
```

## `@audit-tools/shared`

Owns: step contract, session config, run ledger, graph/surface/flow/risk/disposition/access types, JSON IO helpers, validation, `FreshSessionProvider` interface, quota subsystem (rate limiting, sliding window, 429/524/TPM/RPM error parsing, learned limits). Each orchestrator keeps its own `providers/` + `quota/` wiring but conforms to shared contracts.

Both packages: `"@audit-tools/shared": "*"`, project-reference in `tsconfig.json`.

**Build order matters.** `npm run build --workspaces` does NOT topologically sort. On fresh checkout:
```bash
npm run build -w @audit-tools/shared && npm run build
```
When changing a shared contract, rebuild shared + typecheck both dependents.

## audit-code architecture

Obligation-driven. Each invocation executes the highest-priority valid next step. Repeated → normalized repo understanding → bounded audit tasks → verified coverage → findings report.

**Core loop** (`src/orchestrator/advance.ts` → `advanceAudit`):
1. Load artifact bundle from `.audit-tools/audit/`
2. `decideNextStep` (`src/orchestrator/nextStep.ts`) — derives state, picks obligation
3. Dispatch to one executor
4. Persist + return execution summary

The priority chain in `nextStep.ts`: `provider_confirmation` → `repo_manifest` → `file_disposition` → `auto_fixes_applied` → `syntax_resolved` → `structure_artifacts` → `graph_enrichment_current` → `design_assessment_current` → `intent_checkpoint_current` → `design_review_contract_completed` → `design_review_conceptual_completed` → `planning_artifacts` → `audit_tasks_completed` → `audit_results_ingested` → `runtime_validation_current` → `synthesis_current` → `synthesis_narrative_current`

Synthesis emits `audit-findings.json` (machine contract); `audit-report.md` is its render. `synthesis_narrative_current` layers LLM narrative (themes/exec summary/top risks); omits cleanly without provider.

**Artifacts** (`.audit-tools/audit/`): `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `graph_bundle.json`, `critical_flows.json`, `risk_register.json`, `coverage_matrix.json`, `audit_tasks.json`, `task_affinity_graph.json`, `audit_results.jsonl`, `runtime_validation_report.json`, `audit-findings.json`, `synthesis-narrative.json`. Review packets: partitioned JIT at dispatch, never persisted. Staleness: explicit dependency DAG (`spec/dependency-map.md`, `src/orchestrator/staleness.ts`, `src/orchestrator/artifactMetadata.ts`).

**Entrypoint:** `audit-code.mjs` → `audit-code-wrapper-lib.mjs`. Conversation-first: `audit-code next-step` writes `.audit-tools/audit/steps/current-step.json` + `current-prompt.md`.

**Providers** (`src/providers/`): `claude-code`, `codex`, `opencode`, `subprocess-template`, `vscode-task`, `antigravity`, `local-subprocess`. Auto-resolved (`src/providers/index.ts`); implement `FreshSessionProvider` from shared. `codex` is headless CLI auto-detected like `claude-code`; `antigravity` is agentic-IDE backend routed through a configured command/task template.

**Schemas** (`schemas/`): `AuditResult` contract (`schemas/audit_result.schema.json`) — `task_id`, `unit_id`, `pass_id`, `lens` must match assigned task; `file_coverage[].total_lines` must match actual line counts.

**Lenses:** `correctness`, `architecture`, `maintainability`, `security`, `reliability`, `performance`, `data_integrity`, `tests`, `operability`, `config_deployment`, `observability`.

**Other modules:** `src/extractors/` (deterministic repo analysis), `src/adapters/` (normalize semgrep/eslint/npm-audit), `src/io/`, `src/validation/`, `src/reporting/` (synthesis + work-block rendering), `src/supervisor/` (session config, run ledger, operator handoff).

## remediate-code architecture

Accepts auditor reports or free-form feedback. Advances via bounded step prompts. Single runtime dep: `commander`.

**State machine** (`src/steps/nextStep.ts` → `decideNextStep()`):
```
pending → planning → documenting → implementing → closing → complete
              ↕                         ↕
  waiting_for_clarification          triage → waiting_for_triage
```

**Phases** (`src/phases/`):
- `plan.ts` — `RemediationPlan` with `Finding[]` + `RemediationBlock[]`; detects auditor vs. conversation input
- `document.ts` — `ItemSpec` per finding (concrete changes, tests to write)
- `implement.ts` — dispatches implementation with test execution + verification
- `triage.ts` — failed items; retry vs. block
- `close.ts` — closing actions (test suites, build, lint)

**Dispatch:** parallel waves (`src/steps/dispatch.ts`: `prepareDocumentDispatch` / `mergeDocumentResults` / `prepareImplementDispatch` / `mergeImplementResults`; `src/steps/waveScheduler.ts` for concurrency limiting). Providers mirror audit-code's backend set.

**State persistence** (`src/state/store.ts`): file-backed `RemediationState`, pessimistic file locking (20ms initial backoff, 250ms max, 20 retries, 30s stale-lock cleanup).

**Core types** (`src/state/types.ts`): `Finding`, `RemediationPlan`, `RemediationBlock`, `ItemSpec`, `ClarificationRequest`, `RemediationItemState`, `TestSpec`, `VerificationResult`, `CoverageLedger`. `src/dedup/crossLensDedup.ts` deduplicates across lenses; `src/intake.ts` orchestrates source manifest, summary, clarification resolution.

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

Per-package via `.github/workflows/publish-package.yml`. Triggered by GitHub Release tag `audit-code-v*`, `remediate-code-v*`, or `shared-v*` (or manual `workflow_dispatch`). Uses npm Trusted Publishing (OIDC) — no tokens. Pre-release (`-` in version) → `next` dist-tag, else `latest`. CI: `npm ci` → build shared → `verify:release` gate → publish.

Trigger via package's `release:patch` / `:minor` / `:major` scripts (bump + commit + tag) or `:publish` variants (also push + create GitHub Release + wait for CI). Use `/ship` skill — encodes trap list (CLAUDECODE unset for gates, CRLF clean-tree guard, allow-scripts postinstall on global reinstall, release-CI-is-the-real-signal) and never parks at push/publish boundary.

## Conventions & invariants

- **Conversation-first.** Normal usage: no manual `--root`, provider, or model flags. Auto-resolution handles it.
- **One bounded step per invocation.** Neither orchestrator runs to completion in a single call.
- **Deterministic over LLM.** Upstream artifacts valid before refreshing downstream.
- **Language-neutral graph.** Edges: `from`, `to`, `kind`, optional `direction`/`confidence`/`reason`. New analyzers enrich shared artifacts, don't fork planning.
- **Never hardcode model identities.** No model names, context/output windows, tier→model maps, or "available model" lists in backend code. Discover dynamically from host/provider/IDE. Tiering = relative advertised capability (cheapest/mid/top). `KNOWN_MODEL_LIMITS` is legacy to retire. Hardcoded model table = bug.
- **LLM always in the loop.** Conversation-first = host agent is always the provider. Never gate LLM review behind "if a provider exists."
- **Windows-aware.** Package-manager shims run through command shell; `.cmd` wrappers resolve reliably.
- **Host prompts are cwd-explicit.** Commands must be cwd-independent or state exact workdir. Prefer `workdir` on the tool over asking workers to `cd`.
- **PowerShell JSON generation is statement-safe.** Assign `foreach` output to a var first, then pipe to `ConvertTo-Json`.
- **Atomic-replace ordering invariant.** Every destructive change — deleting a fast path, phase, scheduler, cap, or monolithic pass — ships as single atomic replace: new mechanism + deletion in one commit. Never add-then-delete across commits.
- **Green-at-every-commit.** Before any push: `npm run build -w @audit-tools/shared && npm run build && npm run check` → zero errors. Hook-enforced since 2026-06-11: PreToolUse blocks `git commit` until check is green; async PostToolUse typechecks edited package after TS edits (`.claude/hooks/`).

## Preferences & standing decisions

- **Ideal code over compatibility.** One user, no external consumers → cleanest design, delete deprecated/legacy paths.
- **Keep orchestrators in parity.** Fix in one usually belongs in both; genuinely shared logic → `@audit-tools/shared`.
- **Docs capture durable concepts, not current state.** Timeless conceptual docs only. Exception: single handoff doc for immediate next steps.
- **A needed manual flag is a bug signal.** Fix auto-resolution; don't document the flag.
- **Resolve toward durable contract.** LLM-vs-deterministic → deterministic; graph/language → language-neutral contract.
- **Budget context before LLM dispatch.** Small obligation-specific packets; expand only when genuinely needed.
- **Split design assessment into two named modes.** *Contract assessment* (invariants/boundaries/obligations) vs. *conceptual design critique* (philosophy/alternatives/better directions). Bare "design assessment" = too ambiguous.
- **Caveman mode (full) active globally.** Ultra-compressed telegraphic prose across all responses and agents. Ethan toggles off when clarity needed.
- **Redesign before scheduled autonomy.** Architecture stabilizes first; then build scheduled audit→remediate→PR loop once on new architecture.
- **Token/context policy lives in `~/.claude/CLAUDE.md`.** Don't duplicate here.
- **Headroom over opentoken (2026-06-11).** Host MCP swapped in at user scope; orchestrator swap rides redesign as library-mode npm `headroom-ai` step (deletes `wrapForOpenToken` et al.).
- **Token estimates stay local and deterministic (2026-06-11).** Never API-call token counting in planning/dispatch. No tokenizer dep — shared `estimateTokensFromBytes` primitive is the standard. Learned RPM/TPM limits authoritative; headroom proxy stats supply measured usage.

## Known friction & deferred fixes

Tracked in [`docs/backlog.md`](docs/backlog.md). Add entry when deferring; remove when shipped.

**Log friction the moment you hit it** — non-obvious traps, misbehaving tools, missing affordances, shell/env quirks. One line to `docs/backlog.md` under *Known friction* before moving on. 30-second note now = fix a future session can pick up.
