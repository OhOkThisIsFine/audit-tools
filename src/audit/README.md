# `src/audit` — audit-code orchestrator

Obligation-driven audit engine. `next-step` derives state from the artifact bundle,
picks the highest-priority unsatisfied obligation, runs one bounded unit, persists, returns.

## Module index

- `orchestrator/` — core loop (`advance.ts` → `advanceAudit`), `nextStep.ts` priority chain, staleness DAG.
- `extractors/` — deterministic repo analysis (graph, git-history, structure).
- `decompose/` — structure-layer decomposition (overlay-and-delta operator over behavior-graph + intent
  sources), emitting `structure_decomposition.json` and the two non-co-localization findings.
- `adapters/` — normalize external analyzer output (semgrep / eslint / npm-audit / ast-grep / CodeQL / clippy / rubocop / coverage-summary) to shared contracts.
- `providers/` — thin wiring layer (claude-code, opencode) over the shared `FreshSessionProvider` backends in
  `audit-tools/shared` (codex, openai-compatible, subprocess-template, vscode-task, antigravity, worker-command).
- `clarification/` — Phase D charter-clarification/triangulation loop: blast radius, attention
  dial, VOI-ranked question queue, risk gate over the queue.
- `systemic/` — Phase E systemic improvement-seeking challenge loop: aggregate-metrics digest +
  second-order-adversary prompt, loop-until-dry.
- `reporting/` — synthesis (`audit-findings.json` + `audit-report.md` render) + work-block rendering.
- `supervisor/` — session config, run ledger, operator handoff.
- `prompts/` — host-facing prompt rendering.
- `validation/` — contract validators (`AuditResult`, schema gates).
- `io/` — artifact read/write helpers.
- `quota/` — provider quota wiring (conforms to shared quota subsystem).
- `contracts/`, `types/`, `cli/` — step/artifact contracts, shared types, CLI surface.
