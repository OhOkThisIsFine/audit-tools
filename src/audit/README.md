# `src/audit` — audit-code orchestrator

Obligation-driven audit engine. `next-step` derives state from the artifact bundle,
picks the highest-priority unsatisfied obligation, drains the deterministic frontier
fold-aware (halting at the first host-input pause, non-drainable step, or the
`MAX_DRAIN_STEPS` charged-execution budget), persists, returns.

## Module index

- `orchestrator/` — core loop (`advance.ts` → `advanceAudit`), the `src/audit/orchestrator/nextStep.ts` priority chain, staleness DAG.
- `extractors/` — deterministic repo analysis (graph, git-history, structure).
- `decompose/` — structure-layer decomposition (overlay-and-delta operator over behavior-graph + intent
  sources), emitting `structure_decomposition.json` and the two non-co-localization findings.
- `clarification/` — Phase D charter-clarification/triangulation loop: blast radius, attention
  dial, VOI-ranked question queue, risk gate over the queue.
- `systemic/` — Phase E systemic improvement-seeking challenge loop: aggregate-metrics digest +
  second-order-adversary prompt, loop-until-dry.
- `reporting/` — synthesis (`audit-findings.json` + `audit-report.md` render) + work-block rendering.
- `supervisor/` — operator handoff.
- `cli/prompts.ts` plus the per-area `*Prompt.ts` modules — host-facing prompt rendering.
- `validation/` — contract validators (`AuditResult`, schema gates).
- `io/` — artifact read/write helpers.
- `contracts/`, `types/`, `cli/` — step/artifact contracts, shared types, CLI surface.
