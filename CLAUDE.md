# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`audit-tools` is an npm-workspaces monorepo containing two autonomous, step-driven orchestrators and the library they share. Both orchestrators advance work **one bounded step per invocation**: a call to `next-step` returns a backend-rendered prompt contract (JSON + markdown) that a host agent executes, then calls back for the next step. State persists to an artifact directory between calls, so runs are resumable.

- **audit-code** audits arbitrary codebases and produces a findings report.
- **remediate-code** consumes that report (or free-form feedback) and applies fixes.

They form a pipeline: audit → report → remediate. Each is published independently to npm.

## Project goals & the concepts that bind it

The aim is a pair of autonomous orchestrators that take a codebase from *understanding* to *verified improvement* with minimal human babysitting — trustworthy because the machine parts are deterministic and the LLM parts are bounded and attributable. A handful of concepts tie the whole system together; when a decision is unclear, reason from these:

- **One pipeline, two halves.** audit-code produces a findings contract; remediate-code consumes it and applies fixes. `audit-findings.json` is the seam between them — the machine contract — and `audit-report.md` is only a human-facing render of it. The JSON is the source of truth on both sides.
- **Obligation-driven, one bounded step per invocation.** Neither tool "runs to completion" internally. Each `next-step` derives state from artifacts, picks the highest-priority unsatisfied obligation, does one bounded unit of work, persists, and returns. This is what makes runs resumable, parallelizable, and failure-isolated — and it's the shared shape both orchestrators implement.
- **Deterministic by default; LLM only for judgment.** Anything a deterministic extractor or validator can do, it should. The LLM is reserved for semantic review, synthesis, ambiguity resolution, and explicit low-confidence fallbacks — always bounded and recorded.
- **Artifacts are continuity; the dependency DAG is truth.** Durable state lives in artifacts, and staleness propagates along an explicit dependency map — never ad-hoc freshness checks.
- **Language-neutral by contract.** The graph and artifact shapes are language-agnostic. New language support enriches those shared contracts; it must not fork the planning logic per ecosystem.
- **Conversation-first.** The product is the slash workflow inside a host conversation; the CLI and MCP surfaces are backend/fallback, not the intended mental model.

`@audit-tools/shared` exists to keep these concepts *single-sourced* — the step contract, the artifact/graph types, and the quota model live there precisely so the two orchestrators can't drift apart.

## Repository layout

| Directory | npm package | bin / slash command | Role |
|---|---|---|---|
| `packages/shared` | `@audit-tools/shared` | — | Shared contracts, IO, quota, provider types, validation. **Built first; the other two depend on it.** |
| `packages/audit-code` | `auditor-lambda` | `audit-code` / `/audit-code` | Audit orchestrator. Tests via `node --test` (`tests/*.test.mjs`). |
| `packages/remediate-code` | `remediator-lambda` | `remediate-code` / `/remediate-code` | Remediation orchestrator. Tests via `vitest` (`tests/*.test.ts`). |

Note the three-way naming mismatch (directory vs. npm name vs. bin) — `npm -w` accepts either the directory path or the package name. Per-package architecture is documented in the sections below.

## Commands

All TypeScript (ES2022, NodeNext, strict), Node 20+. Run these from the repo root:

```bash
npm install                       # installs + symlinks workspaces
npm run build                     # tsc → dist/ in every workspace
npm run check                     # typecheck only (no emit), every workspace
npm test                          # build + test, every workspace

# Scope to one package with -w (path or package name both work):
npm run build -w @audit-tools/shared
npm test -w packages/audit-code
```

### audit-code (run from `packages/audit-code`)

```bash
npm test                                                # build + node --test tests/*.test.mjs
npm run build && node --test tests/next-step.test.mjs   # single test file
npm run verify:release                                  # check + tests + linked & packaged smoke
npm run smoke:packaged-audit-code                       # set AUDIT_CODE_VERBOSE=1 for verbose output
```

Tests use Node's built-in runner (`node:test` / `node:assert`), not Jest/Vitest. Subtests must be `await t.test(...)` for Node 22 compatibility.

### remediate-code (run from `packages/remediate-code`)

```bash
npm test                                                # build + vitest run
npm run build && npx vitest run tests/next-step.test.ts # single test file
npm run verify:release                                  # check + test + linked & packaged smoke
npm run fixtures:auditor-contract                       # regenerate the auditor-contract test fixture
node remediate-code.mjs next-step --input report.md     # local dev wrapper (auto-rebuilds on source change)
```

## Cross-package architecture: `@audit-tools/shared`

`@audit-tools/shared` is the foundation both orchestrators build on. It owns the cross-cutting contracts (step contract, session config, run ledger, and the graph/surface/flow/risk/disposition/access types), JSON IO helpers, validation, provider **type** definitions including the `FreshSessionProvider` interface, and the **quota subsystem** (rate limiting, sliding window, error parsing for 429 / 524 / TPM / RPM exhaustion, and learned limits). Each orchestrator keeps its own `providers/` and `quota/` wiring but conforms to these shared contracts.

Both packages declare `"@audit-tools/shared": "*"`, import from it directly, and project-reference it in their `tsconfig.json`.

**Build order matters.** The dependent packages' `tsc -p` resolves types from `shared/dist`, and at runtime they import its compiled output. On a clean checkout, build `shared` before the others:

```bash
npm run build -w @audit-tools/shared && npm run build
```

CI does this explicitly. `npm run build --workspaces` does not topologically sort, so don't rely on root build order on a fresh tree. When changing a shared contract or type, rebuild `shared` and typecheck both dependents — a shared change can break either orchestrator.

## audit-code architecture

Obligation-driven audit orchestrator: each invocation **executes the highest-priority valid next step from the current audit state**. Repeated invocations of the single entrypoint eventually produce normalized repository understanding, bounded audit tasks, verified coverage, and a synthesized findings report.

### Orchestration loop

The core loop lives in `src/orchestrator/advance.ts` (`advanceAudit`). Each invocation:
1. Loads the artifact bundle from `.audit-artifacts/`.
2. Calls `decideNextStep` (`src/orchestrator/nextStep.ts`), which derives audit state and picks the highest-priority unsatisfied obligation.
3. Dispatches to exactly one executor (intake → disposition → structure → planning → agent review → ingestion → runtime validation → synthesis).
4. Persists updated artifacts and returns a structured execution summary.

The priority chain in `nextStep.ts`: `repo_manifest` → `file_disposition` → `auto_fixes_applied` → `syntax_resolved` → `structure_artifacts` → `planning_artifacts` → `audit_tasks_completed` → `audit_results_ingested` → `runtime_validation_current` → `synthesis_current` → `synthesis_narrative_current`. Synthesis emits the canonical `audit-findings.json` (the machine contract; `audit-report.md` is a render of it); the optional `synthesis_narrative_current` step layers an LLM narrative (themes / executive summary / top risks) onto it and omits cleanly without a provider.

### Artifact system

Artifacts under `.audit-artifacts/` are the continuity layer: `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `graph_bundle.json`, `critical_flows.json`, `risk_register.json`, `coverage_matrix.json`, `audit_tasks.json`, `review_packets.json`, `audit_results.jsonl`, `runtime_validation_report.json`, `audit-findings.json` (canonical machine contract), `synthesis-narrative.json` (narrative marker). Staleness is tracked via an explicit dependency DAG (`spec/dependency-map.md`, implemented in `src/orchestrator/staleness.ts` and `src/orchestrator/artifactMetadata.ts`).

### Entrypoint, providers, schemas, lenses

- **Entrypoint:** the wrapper `audit-code.mjs` → `audit-code-wrapper-lib.mjs` is the CLI surface. The conversation-first flow uses `audit-code next-step`, which writes `steps/current-step.json` and `steps/current-prompt.md`; the host agent reads and follows only the returned step prompt. The MCP server (`src/mcp/`) is a compatibility adapter over the same step contract.
- **Providers** (`src/providers/`) dispatch LLM worker tasks to different backends: `claude-code`, `opencode`, `subprocess-template`, `vscode-task`, or `local-subprocess` (manual fallback). Auto-resolution in `src/providers/index.ts` detects the active environment; providers implement the `FreshSessionProvider` interface from `@audit-tools/shared`.
- **Schemas** (`schemas/`) define all public artifact shapes. The `AuditResult` contract (`schemas/audit_result.schema.json`) is the worker submission format — `task_id`, `unit_id`, `pass_id`, and `lens` must match the assigned task; `file_coverage[].total_lines` must match actual line counts.
- **Lenses** organize audit work: `correctness`, `architecture`, `maintainability`, `security`, `reliability`, `performance`, `data_integrity`, `tests`, `operability`, `config_deployment`, `observability`. Each audit task covers one unit under one lens.

### Other module areas

`src/extractors/` (deterministic repo analysis), `src/adapters/` (normalize semgrep/eslint/npm-audit output into shared artifact shapes), `src/io/` (artifact read/write), `src/validation/`, `src/reporting/` (synthesis + work-block rendering), `src/supervisor/` (session config, run ledger, operator handoff).

## remediate-code architecture

Autonomous remediation orchestrator. Accepts auditor reports or free-form feedback and advances through bounded, step-by-step prompts. Single runtime dependency: `commander`.

### State machine

The core loop lives in `src/steps/nextStep.ts` (`decideNextStep()`), returning one bounded prompt contract per call. The host calls `next-step` repeatedly until state reaches `complete`. States are defined in `src/state/store.ts`:

```
pending → planning → documenting → implementing → closing → complete
              ↕                         ↕
  waiting_for_clarification          triage → waiting_for_triage
```

### Phases

Each phase in `src/phases/`:
- **plan.ts** — creates a `RemediationPlan` with `Finding[]` and `RemediationBlock[]`; detects auditor reports vs. conversation input.
- **document.ts** — produces an `ItemSpec` per finding (concrete changes, tests to write).
- **implement.ts** — dispatches implementation work with test execution and verification.
- **triage.ts** — handles failed items; decides retry vs. block.
- **close.ts** — runs closing actions (test suites, build, lint).

### Dispatch, state, types

- **Dispatch & wave scheduling:** document/implement work is dispatched to sub-agents in parallel waves. `src/steps/dispatch.ts` (`prepareDocumentDispatch`/`mergeDocumentResults`/`prepareImplementDispatch`/`mergeImplementResults`) and `src/steps/waveScheduler.ts` (concurrency limiting). Providers in `src/providers/` mirror audit-code's backend set; `src/mcp/server.ts` is the legacy adapter (`next-step` is canonical).
- **State persistence:** `src/state/store.ts` holds the file-backed `RemediationState` with pessimistic file locking (20ms initial backoff, 250ms max, 20 retries, 30s stale-lock cleanup).
- **Core types:** `src/state/types.ts` defines `Finding`, `RemediationPlan`, `RemediationBlock`, `ItemSpec`, `ClarificationRequest`, `RemediationItemState`, `TestSpec`, `VerificationResult`. `src/dedup/crossLensDedup.ts` deduplicates findings across audit lenses; `src/intake.ts` orchestrates source manifest, summary, and clarification resolution.

### Artifact layout

```
.remediation-artifacts/
  state.json    # state machine        intake/   # source manifest, summary, clarifications
  state.lock    # pessimistic lock      steps/    # current-step.json, current-prompt.md
```

Final outputs at repo root: `remediation-report.md`, `remediation-report.json`, `remediation-closing-result.json`.

## Release & publish

Each package versions and publishes independently via `.github/workflows/publish-package.yml`:

- Triggered by a GitHub Release whose tag is prefixed `audit-code-v*`, `remediate-code-v*`, or `shared-v*` (or manual `workflow_dispatch` selecting the package).
- Uses npm **Trusted Publishing (OIDC)** — no tokens. Pre-release versions (`-` in the version) publish under the `next` dist-tag, otherwise `latest`.
- The CI job runs `npm ci` at the root, builds `@audit-tools/shared`, then runs that package's `verify:release` gate before publishing.

Trigger this flow with a package's `release:patch` / `:minor` / `:major` scripts (bump + commit + tag), or the `:publish` variants (also push + create the GitHub Release + wait for CI publish), run from the package directory.

## Conventions & invariants

- **Conversation-first.** Both tools are driven through their slash workflows (`/audit-code`, `/remediate-code`). Normal usage should not pass manual `--root`, provider, or model-selection flags — auto-resolution handles the environment.
- **One bounded step per invocation.** Neither orchestrator should recursively complete an entire run in a single call. Steps are intentionally bounded so a single failure doesn't block the run, sub-agents can work in parallel, and results compose via deterministic schemas.
- **Prefer deterministic execution over LLM inference** when both can satisfy an obligation. Upstream artifacts must be valid before refreshing downstream ones.
- **Language-neutral graph contract.** Graph edges use `from`, `to`, `kind`, optional `direction`/`confidence`/`reason`. New language analyzers should enrich the shared artifacts, not invent language-specific planning paths.
- **Windows-aware.** This repo is developed on Windows; package-manager shims (`npm`, `npx`, `pnpm`, `yarn`) run through the command shell so `.cmd` wrappers resolve reliably.

## Preferences & standing decisions

A living log of how to resolve recurring forks, so agents don't re-ask settled questions. **Before asking the user to choose between approaches, check here (and the Conventions above). After the user resolves an ambiguity, append the decision here** — one line: *When X, prefer Y — why.*

- **Ideal code over compatibility.** One user, no external consumers → prefer the cleanest design and delete deprecated/legacy paths rather than preserving them for back-compat.
- **Keep the two orchestrators in parity.** Mirror structure, contracts, and conventions across audit-code and remediate-code; a fix in one usually belongs in both, and genuinely shared logic belongs in `@audit-tools/shared`.
- **Docs capture durable concepts, not current state.** This project moves fast; prefer timeless conceptual docs (and this log) over status / roadmap / file-state notes that rot. If a doc would only record "where things are now," don't write it.
- **A needed manual flag is a bug signal.** If a task seems to require `--root`, a provider, or a model flag, fix auto-resolution rather than document the flag.
- **Resolve toward the durable contract.** LLM-vs-deterministic → deterministic; any graph/language question → the language-neutral contract (see Conventions).
