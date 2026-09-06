# Refactoring Plan: Item 4.1 - Source Line Counting Twins

## Item Overview & Current State

- **Item:** 4.1 Source Line Counting Twins
- **Files Involved:**
  - src/audit/orchestrator/reviewPacketShared.ts (symbol: lineCountForPath)
  - src/audit/orchestrator/selectiveDeepening/shared.ts (symbols: lineCountForPath, resultLineIndex, lineCountFromSources)
- **Key Symbols:** lineCountForPath, resultLineIndex, ReviewTask (= AuditTask — see §1.5), FileCoverage (= FileCoverageRecord / AuditResult.file_coverage entries)
- **Prior Sweep & Verification Findings:**
  The catalog incorrectly claimed both read files and split on newlines. Both are in-memory index lookups.
  Signatures differ: reviewPacketShared takes 3 arguments; selectiveDeepening takes 4 arguments and has a per-call resultLineIndex index construction.
  src/shared/paths.ts is strictly path normalization (governed by check:shared-primitives) and is the wrong destination.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What the twins actually do (corrected record)

Neither twin touches disk. Both resolve "how many lines does path P have?" from
already-materialized in-memory sources with a fixed precedence chain:

| Order | reviewPacketShared.lineCountForPath | selectiveDeepening/shared.lineCountForPath |
|---|---|---|
| 1 | `task.file_line_counts[path]` | `task.file_line_counts[path]` |
| 2 | `lineIndex[path]` (disk-measured fallback) | `resultLineIndex(result)[path]` (this result's `file_coverage[].total_lines`) |
| 3 | `0` | `lineIndex[path]` |
| 4 | — | `0` |

The deepening variant is a strict superset: it inserts one extra precedence
level (the owning result's coverage) between the task contract field and the
shared disk-measured `lineIndex`. The planning-phase variant has no result to
consult — `buildPacket` / `taskLineCount` run at planning time, before any
`AuditResult` exists — so its shorter chain is not a competing semantic, it is
the same chain with a level absent.

### 1.2 Why two signatures exist (and why the difference is accidental)

- `reviewPacketShared.ts` documents itself as "the module BELOW both
  reviewPackets.ts and reviewPacketMetrics.ts" — it exists to break the
  packets↔metrics import cycle. Its 3-arg form
  `lineCountForPath(task, path, lineIndex?)` serves exactly two call sites that
  both already hold the owning task.
- `selectiveDeepening/shared.ts` is the strategy-shared-primitives module for
  the deepening directory (ranks, tags, limits, id/hash helpers). Its 4-arg form
  `lineCountForPath(path, task?, result, lineIndex?)` serves follow-up builders
  that hold a `FindingContext` / `LensVerificationSource` pair
  (`{ task?, result }`), i.e. they always have a result and only sometimes a task.
- The argument **order** differs (task-first vs path-first). There is no semantic
  reason for this; each matches its file's local call-site ergonomics. This is
  the sharpest edge in the blast radius: any positional unification silently
  swaps `task` and `path` at one family's call sites. The canonical signature
  MUST NOT be positional (see §3.1).

### 1.3 The per-call `resultLineIndex` cost (the real defect)

In `selectiveDeepening/shared.ts`, `resultLineIndex` is a **private** function
that rebuilds a fresh `Record` via `Object.fromEntries(result.file_coverage.map(...))`
on **every** `lineCountForPath` call. Every follow-up builder maps
`lineCountForPath` over N paths, so each task-materialization pays
O(N × coverage) allocations to answer what is a single per-result lookup table.
`lineCountFromSources` (same file) has the same shape one level up: per-path
linear scans over `tasks` then `results` with `.find` on `file_coverage`.
Both are O(paths × sources) where O(paths + sources) is available, and
`conflict.ts`'s `lineSources` map shows the codebase already reaches for the
memoized shape at the call site instead of getting it from the helper.

Canonical fix: build the per-result index **once per result object** and share it
across all path lookups for that result — a module-private
`WeakMap<AuditResult, ReadonlyMap<string, number>>` behind a
`resultLineIndexFor(result)` accessor. WeakMap (not Map) because results are
short-lived planning snapshots; keying on object identity gives automatic
lifetime management with no invalidation bookkeeping, and `file_coverage` is
append-only at ingestion time so identity-keyed caching is sound within a
planning/deepening pass.

### 1.4 Correct landing zone (and why the alternatives are wrong)

- **`src/shared/paths.ts` — REJECTED (confirmed).** 24 lines, exactly two
  functions (`toPosixPath`, `normalizeRepoRelPath`), both pure path-string
  normalization, governed by `check:shared-primitives`. Line counts are
  audit-domain planning data (`AuditTask.file_line_counts`,
  `AuditResult.file_coverage`), not shared primitives. Landing here would trip
  the shared-primitives gate's intent and couple `src/shared` (shipped public
  API surface — see package.json `exports`) to audit-orchestrator types.
- **`selectiveDeepening/shared.ts` — REJECTED as canonical home.** Planning code
  (`reviewPackets.ts`, `reviewPacketMetrics.ts`) must not import *down* into a
  strategy subdirectory; `reviewPackets.ts` already imports `sanitizeSegment`
  from there, which is existing layering debt, not a pattern to extend.
  (Direction check: neither twin module imports the other today, so either
  direction is cycle-free — the objection is layering, not cycles.)
- **`reviewPacketShared.ts` — REJECTED as canonical home.** Its documented role
  is the packets↔metrics cycle-breaker for planning-shape + task-field
  accessors. Deepening strategies importing planning-cycle-breaker internals
  inverts the dependency story the file's own header comment tells.
- **ACCEPTED: new leaf module `src/audit/orchestrator/lineCounts.ts`.** Sibling
  of both consumers, imports only `AuditTask`/`AuditResult` types (type-only
  imports — zero runtime edges, so `check:depgraph` and the packets↔metrics
  cycle constraint are unaffected). Single responsibility: the
  task→result→lineIndex→0 precedence chain plus the memoized per-result index.
  Both existing modules become thin re-exporters (deleted in the same change —
  no compat shim; see §4 step 6) or drop the functions outright.

### 1.5 Symbol-name corrections for this plan

- **`ReviewTask` does not exist in `src`.** A repo-wide search for `ReviewTask`
  matches only local variables named `allReviewTasks` in
  `ingestionExecutors.ts` and `planningExecutors.ts`. The plan header's
  "ReviewTask" means **`AuditTask`** (`src/audit/types.ts`, `AuditTaskSchema`:
  `file_line_counts?: Record<string, number>`). All changes below reference
  `AuditTask`.
- **`FileCoverage` means two concrete shapes:** `FileCoverageRecord`
  (`src/audit/types.ts`: `{ path, total_lines, pass_id, lens?, agent_role? }`)
  used by `resultIngestion.ts`, and the inline `AuditResult.file_coverage`
  entry type (`{ path, total_lines }` in `AuditResultSchema`). The canonical
  index builder consumes the minimal structural type
  `{ readonly file_coverage: ReadonlyArray<{ path: string; total_lines: number }> }`
  so it accepts both without coupling to either full schema.

---

## 2. Blast Radius & Affected Files

### 2.1 Definition sites (2 files)

| File | Symbols | Change |
|---|---|---|
| `src/audit/orchestrator/reviewPacketShared.ts` | `lineCountForPath(task, path, lineIndex?)` | DELETE (moved to `lineCounts.ts`); file keeps `ReviewPacketPlanningData`, `normalizePriority` — its cycle-breaker role is unchanged |
| `src/audit/orchestrator/selectiveDeepening/shared.ts` | `lineCountForPath(path, task?, result, lineIndex?)`, `resultLineIndex(result)` (private), `lineCountFromSources(path, tasks, results, lineIndex?)` | DELETE all three (moved); file keeps ranks, tags, limits, `FindingContext`, `BuildSelectiveDeepeningTaskOptions`, path/tag helpers |

### 2.2 Direct call sites (8 sites in 7 files)

| # | File | Enclosing symbol | Current call | New call shape |
|---|---|---|---|---|
| 1 | `src/audit/orchestrator/reviewPackets.ts` | `buildPacket` (`fileLineCounts` materialization) | `lineCountForPath(owner, path, lineIndex)` | `lineCountForPath(path, { task: owner, lineIndex })` |
| 2 | `src/audit/orchestrator/reviewPacketMetrics.ts` | `taskLineCount` (private helper) | `lineCountForPath(task, path, lineIndex)` | `lineCountForPath(path, { task, lineIndex })` |
| 3 | `src/audit/orchestrator/selectiveDeepening/conflict.ts` | `buildConflictFollowupTask` (`file_line_counts` map) | `lineCountForPath(path, source.task, source.result, params.lineIndex)` | `lineCountForPath(path, { task: source.task, result: source.result, lineIndex: params.lineIndex })` |
| 4 | `src/audit/orchestrator/selectiveDeepening/highRiskClean.ts` | `buildHighRiskCleanFollowupTask` | `lineCountForPath(path, params.task, params.result, params.lineIndex)` | `lineCountForPath(path, { task: params.task, result: params.result, lineIndex: params.lineIndex })` |
| 5 | `src/audit/orchestrator/selectiveDeepening/findingFollowup.ts` | `buildFindingFollowupTask` | `lineCountForPath(path, params.task, params.result, params.lineIndex)` | same options-object mapping as #4 |
| 6a | `src/audit/orchestrator/selectiveDeepening/lensVerification.ts` | `lensVerificationTriggers` (`totalLines` reduce) | `lineCountForPath(path, owner.task, owner.result)` — **no lineIndex passed** | `lineCountForPath(path, { task: owner.task, result: owner.result, lineIndex })` — requires threading `lineIndex` into triggers params (behavior-neutral: adds a fallback level that previously returned 0) |
| 6b | same file | `selectLensVerificationFiles` (`add(path, priorityScore, …)`) | `lineCountForPath(path, source.task, source.result)` — **no lineIndex passed** | same threading as 6a; `lineIndex` must be threaded through `selectLensVerificationFiles` params from `buildLensVerificationTask`, which already receives it |
| 6c | same file | `buildLensVerificationTask` (`file_line_counts` map) | `lineCountFromSources(path, tasks[], results[], params.lineIndex)` | canonical `lineCountFromSources(path, { tasks, results, lineIndex })` reimplemented on the memoized index (same precedence, no behavior change) |
| 7 | `src/audit/orchestrator/selectiveDeepening/runtimeValidation.ts` | `buildRuntimeValidationFollowupTask` | `lineCountFromSources(path, params.relatedTasks, params.results, params.lineIndex)` | same options-object mapping as 6c |

### 2.3 Inline third variant (1 file — behavior-drift risk)

- `src/audit/orchestrator/selectiveDeepening/stewardFollowup.ts`,
  `buildVerificationFollowupTasks`: builds its own `coverageByPath` Map from
  `result.file_coverage` and resolves
  `coverageByPath.get(path) ?? params.lineIndex?.[path] ?? 0`. It **never
  consults `params.task?.file_line_counts`** — the top precedence level both
  canonical twins honor. Adopting the canonical helper promotes task counts
  above coverage here. Values change only where the lens-verification task's
  `file_line_counts` disagrees with the verification result's coverage for the
  same path (paths are pre-filtered to `coverageByPath.has(path)`, so the old
  code always hit coverage). This is a **deliberate precedence fix**, flagged
  for explicit sign-off in verification (§5.3, parity probe C).

### 2.4 Untouched but adjacent

- `src/audit/orchestrator/selectiveDeepening/index.ts` — threads `lineIndex`
  through every strategy; no direct line-count calls. Re-export line
  (`export type { BuildSelectiveDeepeningTaskOptions } from "./shared.js"`)
  is unaffected. No change unless the options-object type moves (it stays).
- `tests/audit/observability-signals.test.ts` — imports only
  `MAX_LENS_VERIFICATION_FILES` / `MAX_LENS_VERIFICATION_RESULT_SUMMARIES`
  from `selectiveDeepening/shared.js`. Unaffected.
- `src/audit/coverage.ts` (`applyFileCoverage`), `resultIngestion.ts`,
  `requeueFold.ts` (`measuredLineCounts`), `cli/lineIndex.ts`,
  `cli/dispatch/hostHandoff.ts`, validation (`auditResults.ts`) — all deal in
  line counts but none call either twin; out of scope. Do not touch.

### 2.5 Gate surface

- `check:shared-primitives` — must stay green: nothing new enters `src/shared`.
- `check:depgraph` / `check:deadcode` (knip) / `check:dup` (jscpd) /
  `check:lint` — moved functions must not linger as dead exports at the old
  sites (knip flags them) and the two deleted twins reduce duplication signal.
- `check:doc-code-citations` — if any doc cites the old symbol paths, update
  the citation (search `docs/` for `lineCountForPath` before closing).

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 New module `src/audit/orchestrator/lineCounts.ts` (the only new file)

```ts
import type { AuditResult, AuditTask } from "../types.js";

/** Minimal coverage shape — accepts AuditResult and FileCoverageRecord carriers. */
export interface LineCountResultView {
  readonly file_coverage: ReadonlyArray<{ path: string; total_lines: number }>;
}

export interface LineCountSources {
  task?: AuditTask | undefined;
  result?: LineCountResultView | undefined;
  /** Prebuilt per-result index; overrides the memoized build when supplied. */
  resultIndex?: ReadonlyMap<string, number> | undefined;
  lineIndex?: Record<string, number> | undefined;
}

/** Build a path→total_lines index for one result's file_coverage. */
export function buildResultLineIndex(
  result: LineCountResultView,
): ReadonlyMap<string, number> {
  return new Map(
    result.file_coverage.map((coverage) => [coverage.path, coverage.total_lines]),
  );
}

const memoizedIndexes = new WeakMap<object, ReadonlyMap<string, number>>();

/** Per-result index, built once per result object and shared across lookups. */
export function resultLineIndexFor(
  result: LineCountResultView,
): ReadonlyMap<string, number> {
  const cached = memoizedIndexes.get(result);
  if (cached) return cached;
  const built = buildResultLineIndex(result);
  memoizedIndexes.set(result, built);
  return built;
}

/**
 * Canonical line count for one path.
 * Precedence: task.file_line_counts → result file_coverage → lineIndex → 0.
 * Path-first, options-object second — positional (task,path) vs (path,task,…)
 * order confusion between the twins is what this signature retires.
 */
export function lineCountForPath(
  path: string,
  sources?: LineCountSources,
): number {
  return (
    sources?.task?.file_line_counts?.[path] ??
    (sources?.result
      ? (sources.resultIndex?.get(path) ?? resultLineIndexFor(sources.result).get(path))
      : undefined) ??
    sources?.lineIndex?.[path] ??
    0
  );
}

export interface LineCountMultiSources {
  tasks?: ReadonlyArray<AuditTask | undefined> | undefined;
  results?: ReadonlyArray<LineCountResultView> | undefined;
  lineIndex?: Record<string, number> | undefined;
}

/**
 * Multi-source variant (replaces shared.ts lineCountFromSources).
 * Same precedence per source class: first task hit → first result hit → lineIndex → 0.
 * Result scans use the memoized per-result index instead of per-path .find.
 */
export function lineCountFromSources(
  path: string,
  sources?: LineCountMultiSources,
): number {
  for (const task of sources?.tasks ?? []) {
    const count = task?.file_line_counts?.[path];
    if (count !== undefined) return count;
  }
  for (const result of sources?.results ?? []) {
    if (!result) continue;
    const count = resultLineIndexFor(result).get(path);
    if (count !== undefined) return count;
  }
  return sources?.lineIndex?.[path] ?? 0;
}
```

Design notes (binding decisions, not preferences):
- **Options object, path first.** Both twin arg-orders disappear; a caller
  cannot silently swap task/path again. `sources` is optional so the
  planning-phase shape (`lineCountForPath(path, { task, lineIndex })`) and the
  result-less shape both read naturally.
- **`result` typed as the minimal view, not `AuditResult`.** Keeps the leaf
  module decoupled from the full result schema (which carries findings,
  verification, etc.) and lets `FileCoverageRecord`-shaped carriers reuse it.
- **`resultIndex` escape hatch.** `conflict.ts` already builds a per-path
  `lineSources` map; callers holding a prebuilt index can inject it without a
  second build. Canonical call sites need not use it.
- **No `Record<string, number>` index in the public path.** `Map.get` +
  `??` preserves the `0`-is-a-real-count semantics the old `??` chains had
  (a recorded count of `0` must win over fallback — `||` would be a bug;
  this is called out because a Map-based rewrite invites `||`).

### 3.2 `reviewPacketShared.ts` — symbol `lineCountForPath`: DELETE

Remove the 3-arg `lineCountForPath` definition. Keep `ReviewPacketPlanningData`
and `normalizePriority` untouched. Update the two imports:
- `reviewPackets.ts` symbol `buildPacket`: import `lineCountForPath` from
  `"./lineCounts.js"`; call becomes
  `lineCountForPath(path, { task: owner, lineIndex })` inside the
  `fileLineCounts` materialization.
- `reviewPacketMetrics.ts` symbol `taskLineCount`: same import change; body
  becomes `lineCountForPath(path, { task, lineIndex })`.

### 3.3 `selectiveDeepening/shared.ts` — symbols `resultLineIndex`, `lineCountForPath`, `lineCountFromSources`: DELETE

Remove the private `resultLineIndex`, the 4-arg `lineCountForPath`, and
`lineCountFromSources`. Keep everything else (`BuildSelectiveDeepeningTaskOptions`,
`FindingContext`, ranks, tags, limits, `pathsForFinding`, `taskIdFor`,
`uniqueSorted`, `intersects`, `formatList`, `priorityLabel`,
`getExternalAnalyzerPaths`, `normalizedSuggestedPriority`,
`isDeepeningTask`, `isLensVerificationTask`, `sanitizeSegment`,
`priorityRank`). Type `AuditResult` import in shared.ts becomes unused —
remove it from the type import (keep `AuditTask`, `Finding`, `Lens`).

### 3.4 Strategy call-site rewrites (symbol-located)

- `conflict.ts` symbol `buildConflictFollowupTask`: change import source of
  `lineCountForPath` to `"../lineCounts.js"`; call becomes
  `lineCountForPath(path, { task: source.task, result: source.result, lineIndex: params.lineIndex })`.
  The `: (params.lineIndex?.[path] ?? 0)` fallback arm for a missing source is
  subsumed (helper returns 0) — simplify to the single call.
- `highRiskClean.ts` symbol `buildHighRiskCleanFollowupTask`: same import
  change; `lineCountForPath(path, { task: params.task, result: params.result, lineIndex: params.lineIndex })`.
- `findingFollowup.ts` symbol `buildFindingFollowupTask`: same as above.
- `lensVerification.ts` three symbols:
  - `lensVerificationTriggers`: add `lineIndex?: Record<string, number>` to
    its params; `lineCountForPath(path, { task: owner.task, result: owner.result, lineIndex: params.lineIndex })`;
    thread from `buildLensVerificationTasks` (which already holds
    `params.lineIndex`) through its `lensVerificationTriggers({…})` call.
  - `selectLensVerificationFiles`: add `lineIndex?` param; same call shape;
    thread from `buildLensVerificationTask` (already holds `params.lineIndex`).
  - `buildLensVerificationTask`: replace `lineCountFromSources(path, tasks, results, lineIndex)`
    with `lineCountFromSources(path, { tasks, results, lineIndex })`, import from `"../lineCounts.js"`.
- `runtimeValidation.ts` symbol `buildRuntimeValidationFollowupTask`: import
  `lineCountFromSources` from `"../lineCounts.js"`; call becomes
  `lineCountFromSources(path, { tasks: params.relatedTasks, results: params.results, lineIndex: params.lineIndex })`.
- `stewardFollowup.ts` symbol `buildVerificationFollowupTasks`: delete the
  local `coverageByPath` Map construction for counting purposes (keep it only
  if still needed for the `suggestedPaths` membership filter — it is: the
  filter uses `coverageByPath.has(path)`, so keep the Map for filtering and
  route counting through the helper). Counting call becomes
  `lineCountForPath(path, { task: params.task, result: params.result, lineIndex: params.lineIndex })`.
  This promotes `task.file_line_counts` above coverage — the §2.3 precedence
  fix. `isRecord` import and all other logic stay.

### 3.5 Explicit non-changes

- `BuildSelectiveDeepeningTaskOptions.lineIndex` field shape: unchanged
  (`Record<string, number>`). No plumbing change in `index.ts`.
- `AuditTaskSchema.file_line_counts`, `AuditResultSchema.file_coverage`,
  `FileCoverageRecord`: no schema change — this refactor moves read paths, not
  wire contracts.
- `src/shared/paths.ts`: not touched.

---

## 4. Step-by-Step Implementation Sequence

1. **Add `src/audit/orchestrator/lineCounts.ts`** per §3.1 (new file; no other
   file touched — compiles standalone).
2. **Repoint the planning pair.** `reviewPackets.ts` (`buildPacket`) and
   `reviewPacketMetrics.ts` (`taskLineCount`): switch import to
   `"./lineCounts.js"`, convert to options-object calls (§3.2). Run
   `npm run check` — both old and new definitions still exist, so this is a
   safe intermediate state.
3. **Repoint the deepening strategies.** `conflict.ts`, `highRiskClean.ts`,
   `findingFollowup.ts`, `runtimeValidation.ts`: switch imports, convert
   calls (§3.4). `lensVerification.ts`: thread `lineIndex` into
   `lensVerificationTriggers` and `selectLensVerificationFiles` first, then
   convert all three call sites. `stewardFollowup.ts`: route counting through
   the helper, keep `coverageByPath` for the membership filter.
4. **Delete the twins.** Remove `lineCountForPath` from
   `reviewPacketShared.ts`; remove `resultLineIndex`, `lineCountForPath`,
   `lineCountFromSources` from `selectiveDeepening/shared.ts`; prune the now-
   unused `AuditResult` type import in shared.ts. Run `npm run check` again —
   any missed call site is a compile error here, which is the point of doing
   deletion as its own step.
5. **Sweep for stragglers.** Grep `src/`, `tests/`, `scripts/`, `docs/` for
   `lineCountForPath`, `lineCountFromSources`, `resultLineIndex`,
   `reviewPacketShared`, `selectiveDeepening/shared`. Expected survivors: only
   the new module's definitions and updated imports. Update any
   `check:doc-code-citations` hits in docs.
6. **No compat shims.** Both twins are internal (no export through
   package.json `exports`, no cross-package import; the only test import from
   `selectiveDeepening/shared.js` is constants). Do not leave re-export
   aliases — `check:deadcode` (knip) would flag them and the repo's
   single-source rule (the header comment in `reviewPacketShared.ts` itself)
   forbids twin-shaped drift.
7. **Gates.** `npm run check`, `npm run check:tests`, then the targeted gates:
   `check:lint`, `check:depgraph`, `check:deadcode`, `check:dup`,
   `check:shared-primitives`, `check:doc-code-citations`. Then the suite
   (§5).

---

## 5. Verification & Regression Test Plan

### 5.1 Static gates (must all be green)

- `npm run check` (tsc src) + `npm run check:tests` — the deletion step (§4.4)
  makes the compiler the completeness proof for call-site migration.
- `npm run check:lint` (eslint), `check:depgraph` (no new runtime edges —
  `lineCounts.ts` imports types only), `check:deadcode` (no leftover exports),
  `check:dup` (twin duplication signal should shrink, not grow),
  `check:shared-primitives` (nothing entered `src/shared`),
  `check:doc-code-citations` + `check:doc-links` (if docs cited old paths).

### 5.2 Behavioral parity probes (the core of this plan)

No dedicated unit tests exist for either twin today (only constants are
imported by `tests/audit/observability-signals.test.ts`). Parity is proven
with throwaway probes plus the existing suite:

- **Probe A — planning pair.** Fixture: one `AuditTask` with
  `file_line_counts: { "a.ts": 120 }`, `lineIndex = { "a.ts": 999, "b.ts": 50 }`.
  Assert `lineCountForPath("a.ts", { task, lineIndex }) === 120` (task beats
  index), `("b.ts", …) === 50` (index fallback), `("c.ts", …) === 0`. Mirrors
  old 3-arg semantics exactly.
- **Probe B — deepening chain + memoization.** Fixture: task with
  `file_line_counts: { "a.ts": 10 }`, result with
  `file_coverage: [{ path: "a.ts", total_lines: 20 }, { path: "b.ts", total_lines: 30 }]`,
  `lineIndex = { "a.ts": 1, "b.ts": 2, "c.ts": 3 }`. Assert
  `a.ts → 10` (task first), `b.ts → 30` (coverage beats lineIndex),
  `c.ts → 3` (lineIndex), `d.ts → 0`. Assert
  `resultLineIndexFor(result) === resultLineIndexFor(result)` (identity —
  memoization holds) and `buildResultLineIndex` returns a fresh Map each call.
  Assert a recorded `0` count wins: task `{"z.ts": 0}` with
  `lineIndex {"z.ts": 5}` → `0` (guards the `??`-vs-`||` regression).
- **Probe C — stewardFollowup precedence change (§2.3).** Fixture where
  `task.file_line_counts[path] !== result.file_coverage total_lines` for the
  same path. Record old output (coverage wins) vs new output (task wins);
  attach both to the change as the explicit behavior-change sign-off. If any
  existing fixture encodes the old value, that test — not the helper — is
  updated, and the update is called out in the commit message.
- **Probe D — multi-source.** `lineCountFromSources` with two tasks (first
  without, second with the path) and two results: assert first-task-hit wins,
  then first-result-hit, then lineIndex, then 0. Compare against pre-change
  behavior on the same fixture (old implementation was linear-scan; new is
  index-based — same answers, fewer scans).

### 5.3 Regression suite

- Targeted first: any tests covering review packets, packet metrics, and
  selective deepening (run via `npm run test:single -- <files>` after
  `npm run build`, per repo convention that vitest runs against `dist/`).
- Then the full `npm test` (build + `run-vitest-gate.mjs`). Pre-existing
  flakes: rerun failures in isolation before attributing to this change, per
  repo test-failure protocol (hermeticity/EBUSY suspicion first).
- Determinism check: packet ids, task ids, and ordering are hash/sort-based
  (`packetIdFor`, `taskIdFor`, `compareCodeUnits`) and untouched, but
  `selectLensVerificationFiles` ranks by `lines` as a tiebreak — Probe B's
  parity guarantees identical `lines` inputs everywhere except the §2.3
  steward case, so ranking output is unchanged. Confirm via the deepening
  test files passing unmodified (except a §2.3-mandated update, if any).

### 5.4 Performance sanity (non-blocking)

The memoization has no benchmark harness; sanity-check by construction:
`buildLensVerificationTask` / `buildConflictFollowupTask` previously built one
`Object.fromEntries` per path — now one `Map` per result object per pass.
No perf gate required; do not add timing tests.

### 5.5 Closeout checklist for the implementing agent

- [ ] `lineCounts.ts` added; both twins deleted; no re-export shims
- [ ] All 8 call sites (§2.2) + stewardFollowup (§2.3) converted; grep-clean
- [ ] Probes A–D recorded (pass output or attached diff for Probe C)
- [ ] `npm run check`, `check:tests`, `check:lint`, `check:depgraph`,
      `check:deadcode`, `check:dup`, `check:shared-primitives`,
      `check:doc-code-citations` green
- [ ] Full `npm test` green (or failures isolated + attributed per protocol)
- [ ] Commit message calls out the §2.3 stewardFollowup precedence fix if
      Probe C shows a value change
