# Handoff — next tasks

Living pointer for the next session. Durable detail lives in
[`backlog.md`](backlog.md); this is the thin "where we are + do these next" layer.
Cross-session state is also in the `audit-tools-2026-06-state` auto-memory.

_Last updated: 2026-06-09._

## Current state

- **Published:** `auditor-lambda@0.11.1` is live. The 2026-06-09 batch (4 curated
  high fixes + meta-reflections v1) is being released as shared/audit-code/remediate-code
  patches at the end of this session — check `npm view` / git tags for the latest.
- **Branches:** work lands on `main` (default). Remote is `audit-tools`
  (`OhOkThisIsFine/audit-tools`); no `origin`.
- **Self-audit findings:** [`audit/2026-06-09/`](../audit/2026-06-09/) — 281 findings;
  the 24 highs are triaged in
  [`curated-remediation-set.README.md`](../audit/2026-06-09/curated-remediation-set.README.md)
  (5 curated → 4 fixed, `CFG-4996560e` deferred; 3 false-positives; rest backlog).

## Next tasks, in priority order

1. **LLM scope/intent checkpoint** — the highest-signal open item.
   Spec: [`backlog.md` → Deferred fixes](backlog.md). **Scaffolding already exists:**
   `intent_checkpoint` is a registered artifact (`intent_checkpoint.json`, intake phase)
   in `packages/audit-code/src/io/artifacts.ts` — check what's wired before building.
   Cross-orchestrator; plan before implementing.

2. **Finish meta-audit reflections (v1 shipped this session).** Remaining:
   (a) synthesis disk-load of `agent-feedback.jsonl` into the bundle → pass as
   `renderAuditReportMarkdown` `options.reflections` (touches `io/artifacts.ts` +
   the staleness DAG `orchestrator/dependencyMap.ts` — finalization-sensitive, do
   carefully); (b) remediate-code prompt parity + aggregation into
   `remediation-report.md`. See `backlog.md` → "Make agent meta-audit reflections
   a first-class artifact".

3. **`CFG-4996560e`** (deferred fix) — scope postinstall's deployed OpenCode perms
   to the `auditor` agent vs the global top level. Needs real-OpenCode validation
   (agent/subtask inheritance is not unit-testable). Fix direction in `backlog.md`.

4. **Remaining curated highs / triage** — the deferred (backlog) and
   scope-pollution highs are catalogued in `curated-remediation-set.README.md`;
   most are low-value or subsumed by task 1.

## Gotchas (also in auto-memory)

- **Release/publish:** run with `CLAUDECODE` unset (a provider test fails under it).
  The CI-wait loop logs every 5s — tail the task output, don't whole-read it.
- **Global install:** npm's allow-scripts policy defers `postinstall` (host-integration
  deploy is skipped); finish with `npm approve-scripts auditor-lambda` or run
  `postinstall.mjs` manually.
- **Tests on Windows:** run suites solo — concurrent heavy runs hit transient EPERM
  flakiness in file-lock/rename ops, inflating failures.
