# Handoff — next tasks

Living pointer for the next session. Durable detail lives in
[`backlog.md`](backlog.md); this is the thin "where we are + do these next" layer.
Cross-session state is also in the `audit-tools-2026-06-state` auto-memory.

_Last updated: 2026-06-09._

## Current state

- **Published:** `@audit-tools/shared@0.10.1` / `auditor-lambda@0.11.2` /
  `remediator-lambda@0.10.1` are live. The cross-orchestrator scope/intent
  checkpoint landed in-tree after that (Stages 0/A1/A2/R1/R2 — both suites green);
  **not yet released.** Check `npm view` / git tags for the latest.
- **Branches:** work lands on `main` (default). Remote is `audit-tools`
  (`OhOkThisIsFine/audit-tools`); no `origin`.
- **Self-audit findings:** [`audit/2026-06-09/`](../audit/2026-06-09/) — 281 findings;
  the 24 highs are triaged in
  [`curated-remediation-set.README.md`](../audit/2026-06-09/curated-remediation-set.README.md)
  (5 curated → 4 fixed, `CFG-4996560e` deferred; 3 false-positives; rest backlog).

## Next tasks, in priority order

1. **Finish meta-audit reflections (v1 shipped earlier).** Remaining:
   (a) synthesis disk-load of `agent-feedback.jsonl` into the bundle → pass as
   `renderAuditReportMarkdown` `options.reflections` (touches `io/artifacts.ts` +
   the staleness DAG `orchestrator/dependencyMap.ts` — finalization-sensitive, do
   carefully); (b) remediate-code prompt parity + aggregation into
   `remediation-report.md`. See `backlog.md` → "Make agent meta-audit reflections
   a first-class artifact".

2. **Route remediate's structured fast path through `confirm_intent`.** The
   scope/intent checkpoint shipped 2026-06-09, but a lone `audit-findings.json`
   input bypasses the confirm step, so its filters/exclusions don't apply.
   `runPlanPhase` already honors a checkpoint when present — the work is purely
   routing (emit `confirm_intent` / write an intake summary so the gate fires).
   Subsumes `FINDING-012`. See `backlog.md`.

3. **`CFG-4996560e`** (deferred fix) — scope postinstall's deployed OpenCode perms
   to the `auditor` agent vs the global top level. Needs real-OpenCode validation
   (agent/subtask inheritance is not unit-testable). Fix direction in `backlog.md`.

4. **Remaining curated highs / triage** — the deferred (backlog) and
   scope-pollution highs are catalogued in `curated-remediation-set.README.md`;
   most are low-value.

> **Shipped 2026-06-09 — cross-orchestrator scope/intent checkpoint.** Enriched
> shared `IntentCheckpoint` + schema; audit-code `confirm_intent` host step
> (reachable, `host_delegation`, deterministic pre-digest, headless auto-complete)
> that prunes planning by `excluded_scope`, threads `free_form_intent` into worker
> prompts, and reports excluded scope; remediate-code enriched confirm prompt +
> `runPlanPhase` filtering (filters/excluded/must_not_touch) with a coverage-ledger
> `dropped_by_checkpoint` disposition and a "Skipped by Intent Checkpoint" report
> section. Both suites green.

## Gotchas (also in auto-memory)

- **Release/publish:** run with `CLAUDECODE` unset (a provider test fails under it).
  The CI-wait loop logs every 5s — tail the task output, don't whole-read it.
- **Global install:** npm's allow-scripts policy defers `postinstall` (host-integration
  deploy is skipped); finish with `npm approve-scripts auditor-lambda` or run
  `postinstall.mjs` manually.
- **Tests on Windows:** run suites solo — concurrent heavy runs hit transient EPERM
  flakiness in file-lock/rename ops, inflating failures.
