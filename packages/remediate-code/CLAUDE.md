# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Autonomous remediation orchestrator for arbitrary repositories. Accepts audit reports (from auditor-lambda) or free-form feedback and advances through bounded, step-by-step remediation prompts. Published as an npm package (`remediate-code`).

TypeScript (ES2022, strict, NodeNext modules), Node 20+, single runtime dependency (commander).

## Commands

```bash
npm run build          # tsc → dist/
npm run check          # type-check only (no emit)
npm test               # build + vitest run (all tests)
npm run verify:release # check + test + both smoke suites

# Single test
npm run build && npx vitest run tests/next-step.test.ts

# Smoke tests
npm run smoke:linked   # exercises local remediate-code.mjs
npm run smoke:packaged # exercises npm-packed tarball

# Release (bump only / bump+publish)
npm run release:patch        # or :minor / :major
npm run release:patch:publish

# Regenerate auditor contract fixture
npm run fixtures:auditor-contract
```

During local development, use the wrapper script which auto-rebuilds if sources changed:
```bash
node remediate-code.mjs next-step --input path/to/report.md
```

## Architecture

### State machine

The core loop lives in `src/steps/nextStep.ts` (`decideNextStep()`). Each call returns a bounded prompt contract (JSON + markdown) for the host to execute. The host calls `next-step` repeatedly until state reaches `complete`.

States defined in `src/state/store.ts`:
```
pending → planning → documenting → implementing → closing → complete
              ↕                         ↕
  waiting_for_clarification          triage → waiting_for_triage
```

### Phase implementations

Each phase in `src/phases/`:
- **plan.ts** — Creates `RemediationPlan` with `Finding[]` and `RemediationBlock[]`; detects auditor reports vs conversation input
- **document.ts** — Produces `ItemSpec` per finding (concrete changes, tests to write)
- **implement.ts** — Dispatches implementation work with test execution and verification
- **triage.ts** — Handles failed items; decides retry vs block
- **close.ts** — Runs closing actions (test suites, build, lint)

### Dispatch and wave scheduling

For document/implement phases, work is dispatched to sub-agents in parallel waves:

- `src/steps/dispatch.ts` — `prepareDocumentDispatch()`, `mergeDocumentResults()`, `prepareImplementDispatch()`, `mergeImplementResults()`
- `src/steps/waveScheduler.ts` — Concurrency limiting across waves

### Providers

Sub-agent execution backends in `src/providers/`:
- `claudeCodeProvider.ts` — Claude Code subprocess
- `opencodeProvider.ts` — OpenCode agent
- `localSubprocessProvider.ts` — Local shell commands
- `spawnLoggedCommand.ts` — Shell execution with output capture and quota-aware retry
- `index.ts` — Provider selection logic

### State persistence

`src/state/store.ts` — File-backed `RemediationState` with pessimistic file locking (20ms initial backoff, 250ms max, 20 retries, 30s stale lock cleanup). Artifacts live in `.remediation-artifacts/`.

### Quota system

`src/quota/` manages rate limiting:
- `scheduler.ts` — Wave scheduling with sliding window
- `errorParsing.ts` + `errorParsers/` — Detects 429, 524, TPM/RPM exhaustion
- `learnedQuotaSource.ts` — Learns limits from failures
- `slidingWindow.ts` — Tracks recent request windows

### Other key modules

- `src/intake.ts` — Intake orchestration (source manifest, summary, clarification resolution)
- `src/dedup/crossLensDedup.ts` — Deduplicates findings across audit lenses
- `src/validation/` — Schema validation for plans, findings, artifacts
- `src/mcp/server.ts` — MCP server (legacy; `next-step` is canonical)
- `schemas/` — JSON schemas for all data types

### Core types

`src/state/types.ts` defines: `Finding`, `RemediationPlan`, `RemediationBlock`, `ItemSpec`, `ClarificationRequest`, `RemediationItemState`, `TestSpec`, `VerificationResult`.

`src/state/store.ts` defines: `RemediationState` (the top-level state machine).

### Artifact layout

```
.remediation-artifacts/
  state.json              # State machine
  state.lock              # Pessimistic lock
  intake/                 # Source manifest, summary, clarifications
  steps/                  # current-step.json, current-prompt.md
```

Final outputs at repo root: `remediation-report.md`, `remediation-report.json`, `remediation-closing-result.json`.

## Testing

28 test files in `tests/` using vitest. Tests exclude `.audit-artifacts/`, `.audit-code/`, `.claude/`, `.opencode/`, `.vscode/` (see `vitest.config.ts`).

Test fixtures in `tests/fixtures/` — the auditor contract fixture is regenerated via `npm run fixtures:auditor-contract`.

## Design invariant

Each prompt/step is intentionally bounded so that a single failure doesn't block the run, sub-agents can work in parallel, and results are composable via deterministic schemas. Avoid scoping steps too broadly.
