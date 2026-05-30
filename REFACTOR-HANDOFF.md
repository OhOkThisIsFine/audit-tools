# audit-tools refactor — sprint handoff

**Date:** 2026-05-30
**Scope this sprint:** **Phase 3 — `--since` delta mode** (auditor). Adds the `scope.json` artifact, a deterministic priority-frontier graph-expansion that scopes a re-audit to the changed files + their nearest graph neighbours, the `--since <ref>` CLI flag threaded through every advance path, an honest delta header in the report, and a run-log scope line. Rides on the TS call graph landed in the prior sprint.
**Status:** implemented and green on the `master` working tree (committed — see _Git state_ below).

The frozen build order is: **0 → 1A + `.tmp` fix → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7.** Everything through **Phase 3 is now done**. The next pickup is **Phase 4 — decorator routing + LLM edge-reasoning**.

---

## Verification status (all green)

```
shared          24 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     509 tests   pass   (node --test, +12 new vs. 497 baseline)
remediate-code 360 tests   pass   (vitest)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace. The 12 new tests are all in [scope.test.mjs](packages/audit-code/tests/scope.test.mjs): scope determinism (changed-order independence), direct-neighbour-only expansion, the `applyScopeToCoverage` re-queue/inherit/exclude transform (incl. deterministic-exclusion preservation and full-mode no-op), hub-skip blow-up prevention, budget truncation note, non-auditable changed files dropping out, `resolveAuditScope` full-audit fallbacks (no `--since`, no root), and a real temp-git-repo integration (changed file + graph neighbour in scope; mistyped ref → full audit).

End-to-end sanity confirmed against this repo: the new `gitRefExists` resolves `HEAD`/`HEAD~1` and rejects garbage refs, and `changedFiles` returns the real diff set.

---

## Phase 3 — `--since` delta mode ✅

### What it does
`scope.json` records how a run was scoped: `full` (the default and every fallback) or `delta`. In delta mode the planning executor audits only the **seed files** (auditable files changed since `--since`) and their **expanded** graph neighbours; every other auditable file inherits its prior `complete` coverage verbatim (so finished work is not re-run) or is excluded from this run (`classification_status: "out_of_scope_delta"`). Deterministic/trivial exclusions are left untouched. The report header and run log record the scope honestly ("delta since `<ref>`: N changed + M neighbours; a full audit is advised before release").

Expansion is a deterministic max-product priority frontier (Dijkstra-like over edge confidences) — **no fixed hop count**: bidirectional graph edges below a confidence floor are dropped, high fan-in/out **hubs are skipped** (reusing `HIGH_FAN_DEGREE_THRESHOLD`) so one change near a hub doesn't drag in the repo, and expansion halts at a file budget or when the best frontier confidence falls below the floor. Same inputs → identical scope.

An unusable `--since` (no git repo, no root, or a ref that doesn't resolve) degrades to a **full audit with an honest `dropped_note`** — a mistyped ref never silently audits nothing. Full mode always writes `scope.json` too, so coverage's recorded dependency stays consistent.

### Where it lives
- **Shared:** `gitRefExists(root, ref)` ([git.ts](packages/shared/src/git.ts), re-exported from [index.ts](packages/shared/src/index.ts)) — distinguishes a mistyped ref from a valid ref with no changes. `isGitRepo`/`changedFiles` were already there (Phase 0).
- **Type / schema:** `AuditScopeManifest` ([types/auditScope.ts](packages/audit-code/src/types/auditScope.ts)); [scope.schema.json](packages/audit-code/schemas/scope.schema.json).
- **Core:** [scope.ts](packages/audit-code/src/orchestrator/scope.ts) — `computeAuditScope` (pure BFS), `resolveAuditScope` (git wrapper: reads auditable files via `buildPathLookup`, computes the scope, or falls back to `fullAuditScope`), `applyScopeToCoverage` (the coverage transform). Degree-index/edge helpers (`buildGraphDegreeIndex`, `HIGH_FAN_DEGREE_THRESHOLD`, `collectGraphEdges`, `graphEdgeConfidence`, `normalizeGraphPath`) are now exported from [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts) and reused.
- **Planning:** `runPlanningExecutor` takes the resolved scope, writes `scope.json`, and applies it to the freshly-built coverage (using the prior `coverage_matrix` in the bundle for inheritance) ([internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts)).
- **Advance:** `AdvanceAuditOptions.since`; `advanceAudit` computes the scope right before dispatching `planning_executor`, passes it in, and emits a `kind: "scope"` run-log line ([advance.ts](packages/audit-code/src/orchestrator/advance.ts)).
- **Artifacts / staleness:** `scope` registered in [io/artifacts.ts](packages/audit-code/src/io/artifacts.ts); DAG edge `scope.json → coverage_matrix.json` in [dependencyMap.ts](packages/audit-code/src/orchestrator/dependencyMap.ts) + [spec/dependency-map.md](packages/audit-code/spec/dependency-map.md). Light bundle validation in [validation/artifacts.ts](packages/audit-code/src/validation/artifacts.ts).
- **Report:** `renderAuditReportMarkdown(report, { scope })` renders the delta header in the "Scope and Coverage" section; both synthesis renders thread `bundle.scope` ([synthesis.ts](packages/audit-code/src/reporting/synthesis.ts), [internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts)).
- **CLI:** `--since <ref>` threaded through `runAuditStep`→`advanceAudit` and the user-facing commands `next-step` (via `runDeterministicForNextStep`), `advance-audit`, `run-to-completion`, and `plan` ([cli.ts](packages/audit-code/src/cli.ts)).

### Decisions & deviations this sprint
- **Scope is produced by planning, not a new obligation.** The plan's obligation chain is unchanged; `scope.json` is a staleness-DAG node upstream of coverage, co-written with `coverage_matrix.json` in one `advanceAudit` call (the same no-cycle, dependency-first pattern as `graph_bundle → analyzer_capability` and `audit-findings → narrative`). Full mode always writes it, so the reverse-dependency map stays consistent and coverage never perpetually re-stales.
- **Re-plan trigger is the natural file-change cascade.** The realistic delta flow is "edit files, re-run with `--since`": the `next-step` integrity check re-runs intake → `repo_manifest` changes cascade to coverage → planning re-runs and recomputes the scope from the current `--since`, reading the still-on-disk prior `coverage_matrix` for inheritance. **Known minor limitation:** changing only the `--since` value between runs on otherwise-unchanged retained artifacts will not by itself re-trigger planning (planning is already satisfied, so the new ref isn't picked up). Not wired this sprint because `--since` is a transient CLI flag (not a session-config key) and the file-change path covers real usage.
- **Out-of-scope semantics chosen for honesty over a single "skipped" status.** Out-of-scope files inherit a prior `complete` record verbatim (counted as audited, because they were), or are marked `excluded` with `classification_status: "out_of_scope_delta"` when there's no prior completion (not counted as audited). This avoids inflating the "fully audited" count and reuses the existing `excluded` handling (no tasks generated, no new status value rippling through the codebase).
- **Hub-skip = never traverse into or through a hub.** A changed hub stays in scope (it's a seed) but its large neighbourhood is not pulled in; a hub reached by expansion is dropped entirely. This matches the packet-planning hub treatment and is what bounds the frontier in practice.
- **MCP server left untouched** (legacy adapter; defaults to full audit, the safe default).

---

## Remaining phases (not started)

Pick up in frozen order. Shared building blocks they need already exist (parentheticals).

- **Phase 4 — decorator routing + LLM edge-reasoning** *(next)*. 4A: extend route patterns ([graph.ts](packages/audit-code/src/extractors/graph.ts)) for NestJS/FastAPI/Flask/Angular, emitting existing `RouteEdge` shapes (the analyzer seam now exists for an AST-based version). 4B: optional cached LLM post-pass over **existing edges with `confidence < 0.65`** that only **rewrites the `reason` string — never adds/removes edges**, cached by `(from,to,kind)`+content-hash, gated on a provider, no-op without one. New session-config key `graph.llm_edge_reasoning` (default off). Golden edge-set equality test must assert 4B changes only `reason`.
- **Phase 5(Py/HTML/CSS) — tree-sitter analyzers.** Register into the **existing seam** ([registry.ts](packages/audit-code/src/extractors/analyzers/registry.ts)): Python imports/decorators, HTML `<script>/<link>`, CSS `@import`/`url()`. SQL = registry stub only.
- **Phase 7 — remediator prompts, theme hints, outcome capture.** Consume `audit-findings.json` directly (incl. `theme_id`/`suggested_fix_pattern`); **delete `parseAuditReport`/`isAuditorAuditReport`** ([plan.ts](packages/remediate-code/src/phases/plan.ts)) — keep the free-form LLM path. Inject `detectRepoConventions(root)` into worker prompts; emit `remediation-outcomes.json` from [close.ts](packages/remediate-code/src/phases/close.ts).

### New session-config keys still to add
`graph.llm_edge_reasoning` (Phase 4). (`analyzers.<id>`, `observability.run_log`, `synthesis.narrative` done earlier; `--since` is a CLI flag — **done** this sprint.)

---

## Carried-over deviations (still true from prior sprints)
- `Finding.lens` stays `string` in the wire contract, narrowed to `Lens` only in the auditor via `Omit`.
- `runShellCommand` retained in the remediator (fully removing it needs `test_command`/`e2e_command` as argv).
- `collectFileCommits` not moved to shared `git.ts` (its `runCommand` injection point is relied on by co-commit tests).
- Token estimates are prefer-bytes / fall-back-to-lines (Phase 2); line-based goldens stay byte-for-byte stable.

## Git state
This sprint's Phase 3 work is committed on `master`. Prior sprints: Phase 5.0 + 5(TS/JS) in `9019ce3`, Phase 6 in `5fc32b4`, Phase 2 byte-switch in `a1b3cce`, Phases 0/1A/remediator-2 in `23af936`.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 24
npm test -w packages/audit-code                          # 509
npm test -w packages/remediate-code                      # 360
```
