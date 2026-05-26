# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Auditor Lambda is a resumable, obligation-driven audit orchestrator for arbitrary codebases. Its product behavior is: **advance the audit by executing the highest-priority valid next step from the current audit state**. Repeated invocations of the single entrypoint eventually produce normalized repository understanding, bounded audit tasks, verified coverage, and a synthesized findings report.

## Build and test

```bash
npm install
npm run build          # tsc → dist/
npm run check          # typecheck only (no emit)
npm test               # build + node --test tests/*.test.mjs
npm run verify:release # typecheck + tests + linked + packaged smoke tests
```

Run a single test file:
```bash
npm run build && node --test tests/next-step.test.mjs
```

Verbose smoke tests for debugging:
```bash
AUDIT_CODE_VERBOSE=1 npm run smoke:packaged-audit-code
```

The test suite uses Node's built-in test runner (`node --test`), not Jest/Mocha. Tests are `.test.mjs` files using `node:test` and `node:assert`. Subtests must be `await t.test(...)` for Node 22 compatibility.

## Architecture

### Orchestration loop

The core loop lives in `src/orchestrator/advance.ts` (`advanceAudit`). Each invocation:
1. Loads the artifact bundle from `.audit-artifacts/`
2. Calls `decideNextStep` (`src/orchestrator/nextStep.ts`) which derives audit state and picks the highest-priority unsatisfied obligation
3. Dispatches to exactly one executor (intake → disposition → structure → planning → agent review → ingestion → runtime validation → synthesis)
4. Persists updated artifacts and returns a structured execution summary

The priority chain in `nextStep.ts` is: `repo_manifest` → `file_disposition` → `auto_fixes_applied` → `syntax_resolved` → `structure_artifacts` → `planning_artifacts` → `audit_tasks_completed` → `audit_results_ingested` → `runtime_validation_current` → `synthesis_current`.

### Artifact system

Artifacts under `.audit-artifacts/` are the continuity layer. Key artifacts: `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `graph_bundle.json`, `critical_flows.json`, `risk_register.json`, `coverage_matrix.json`, `audit_tasks.json`, `review_packets.json`, `audit_results.jsonl`, `runtime_validation_report.json`, `synthesis_report.json`. Staleness is tracked via an explicit dependency DAG (`spec/dependency-map.md`, implemented in `src/orchestrator/staleness.ts` and `src/orchestrator/artifactMetadata.ts`).

### Provider system

Providers (`src/providers/`) dispatch LLM worker tasks to different backends: `claude-code`, `opencode`, `subprocess-template`, `vscode-task`, or `local-subprocess` (manual fallback). Auto-resolution logic in `src/providers/index.ts` detects the active environment. Providers implement the `FreshSessionProvider` interface from `src/providers/types.ts`.

### Key module areas

- `src/extractors/` — deterministic repo analysis (file inventory, graph edges, surfaces, flows, risk, disposition)
- `src/orchestrator/` — executors, state derivation, coverage refresh, task/packet building, requeue, selective deepening
- `src/adapters/` — normalize external tool output (semgrep, eslint, npm audit) into shared artifact shapes
- `src/io/` — artifact read/write, JSON handling, run artifact management
- `src/validation/` — schema and artifact consistency checks
- `src/reporting/` — synthesis and work-block rendering for the final report
- `src/quota/` — rate limiting, sliding window, and quota probing for provider dispatch
- `src/mcp/` — local stdio MCP server exposing audit tools and resources
- `src/supervisor/` — session config, run ledger, operator handoff

### Conversation-first entrypoint

The wrapper (`audit-code.mjs` → `audit-code-wrapper-lib.mjs`) is the CLI surface. The conversation-first flow uses `audit-code next-step`, which writes `steps/current-step.json` and `steps/current-prompt.md` — the host agent reads and follows only the returned step prompt. The MCP server is a compatibility adapter over the same step contract.

### Schemas and contracts

All public artifact shapes have JSON schemas in `schemas/`. The `AuditResult` contract (`schemas/audit_result.schema.json`) is the worker submission format — `task_id`, `unit_id`, `pass_id`, and `lens` must match the assigned task; `file_coverage[].total_lines` must match actual line counts.

### Lenses

Audit work is organized by lens: `correctness`, `architecture`, `maintainability`, `security`, `reliability`, `performance`, `data_integrity`, `tests`, `operability`, `config_deployment`, `observability`. Each audit task covers one unit under one lens.

## Release

```bash
npm run release:patch           # bump + commit + tag
npm run release:patch:publish   # bump + commit + tag + push + GitHub Release + wait for CI publish
```

Publication uses GitHub Actions Trusted Publishing via `.github/workflows/publish-package.yml`.

## Key constraints

- Prefer deterministic execution over LLM inference when both can satisfy an obligation.
- One bounded step per invocation — never recursively complete the entire audit.
- Upstream artifacts must be valid before refreshing downstream ones.
- Graph edges use a language-neutral contract (`from`, `to`, `kind`, optional `direction`/`confidence`/`reason`). New language analyzers should enrich shared artifacts, not invent language-specific planning paths.
- Windows compatibility: package-manager shims (`npm`, `npx`, `pnpm`, `yarn`) run through the command shell so `.cmd` wrappers execute reliably.
