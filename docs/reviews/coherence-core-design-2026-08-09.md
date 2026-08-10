# One coherence core, two draws — design of record

Owner cut, 2026-08-09: **full unification now.** The sizing-window removal falls out of it rather than
preceding it. This is the `/design-check` output for that work; read it before writing code.

Companion: [`sizing-window-removal-blocker-2026-08-09.md`](sizing-window-removal-blocker-2026-08-09.md)
(why a bare deletion breaks grouping, and the signal comparison between the two groupers).

## 1. The finding that fixes the algorithm choice

Only one of the two existing algorithms survives the loss of a capacity bound.

**Findings grouping degenerates to a single giant block — guaranteed, not merely likely.**
`partitionWorkItems` chooses among candidate group counts, and that candidate list is
(`src/shared/decompose/workPartition.ts:763-768`):

```ts
const requestedCounts = stableUnique([
  "1",
  ...(policy.availableParallelism == null
    ? []
    : [String(Math.min(normal.length, policy.availableParallelism))]),
]).map(Number);
```

`availableParallelism` is supplied by `resolveCurrentWorkPartitionRuntime` — which this work deletes.
Once it is null the only candidate count is **1**, so the multi-objective scorer at `:786-806` never
receives a multi-group candidate to compare against. The objective's `parallelism` term
(`:674-682`), which does penalise a single group, is never consulted. The per-group token ceiling at
`:556` is the only other thing that would force a split, and it is also being deleted.

**Task grouping keeps a working stopping condition.** `partitionTaskGraph` merges along
weight-sorted edges under union-find and rejects a merge when combined risk mass exceeds
`riskMassBudget` (`src/audit/orchestrator/partitionTaskGraph.ts:134-137`). Cluster risk accumulates
monotonically as merges land (`:141`), so clusters stop growing on their own. `riskMassBudget`
resolves from `sessionConfig.dispatch?.risk_mass_budget` with `DEFAULT_RISK_MASS_BUDGET`
(`reviewPackets.ts:563`) — a **content property, not a transport one**, so cut (d) does not touch it.

**Therefore the unified core is agglomerative merge over weighted relatedness edges, bounded by a
non-size mass ceiling.** The seeded multi-objective assignment does not survive as a mode: without
capacity it has no stopping condition at all.

## 2. Two lane designs disagreed; the disagreement is resolved here

The design was drafted independently on two off-quota lanes. They conflict on one load-bearing point,
and the conflict is not a matter of taste.

- **Codex (`gpt-5.3-codex-spark`, xhigh)** proposed keeping *both* grouping modes behind a policy
  union (`"agglomerative-merge" | "seeded-partition"`), and listed `DEFAULT_RISK_MASS_BUDGET` under
  *what is lost* — "no hard risk ceiling in grouping path anymore."
- **agy (`gemini-3.6-flash-high`)** independently traced both algorithms' behaviour without capacity
  and concluded risk mass is the only capacity-free stopping condition either one has.

**agy is right, and Codex's design is rejected on both counts.** Removing `riskMassBudget` deletes the
last thing preventing one giant cluster on the task draw too — the same degeneracy the findings draw
already has. And a policy union over two whole algorithms is not "one core with a policy axis"; it is
the fork this project warns against, relocated inside a type. Verified directly against
`partitionTaskGraph.ts:134-141`.

**Risk mass STAYS, and generalises into the core as the merge ceiling.**

## 3. The core

One module, `src/shared/decompose/coherenceCore.ts`. Three stages, all shared; policy chooses their
inputs, never their structure.

1. **Signal extraction** — adapters map their own objects to a generic item. Shared.
2. **Pairwise relatedness** — enabled signal axes and their weights are policy; the pairwise
   computation and reduction are shared.
3. **Agglomerative merge** — weight-sorted union-find under a mass ceiling. Shared, one algorithm.

The generic item avoids the missing `finding → task` key entirely: both draws satisfy the same shape
without either knowing about the other's identity space.

```ts
export interface CoherenceItem {
  readonly id: string;                        // task_id for the task draw, finding.id for the findings draw
  readonly files: readonly string[];
  readonly units: readonly string[];
  readonly semanticTags: readonly string[];   // lens:, category:, title tokens
  readonly flows: readonly string[];          // critical_flow: tags
  readonly neighbors: readonly string[];      // call/import-adjacent paths
  readonly tokenEstimate: number;             // REPORTED, never a bound
  readonly massEstimate: number;              // the merge ceiling's currency (risk for tasks)
  readonly role: "implementation" | "coordination";
}
```

Policy axes — every difference between the draws must land here or it is a fork:

| Axis | Task draw | Findings draw |
|---|---|---|
| enabled signals + weights | file, unit, flow, call-adjacent, dir, same-lens bonus | file, unit, semantic tags |
| pairwise reduce | `max` of contributing kinds | `mean` |
| mass ceiling | risk mass | to be chosen — see §5 |
| seams emitted | no | yes |
| coordination role | absent | `finding.systemic` forces singleton |
| id space | `task_id` | `finding.id` |

## 4. What each draw becomes

- `buildTaskAffinityGraph` (`taskAffinityGraph.ts:156`) → adapter: `AuditTask` → `CoherenceItem`,
  task policy. Its signal helpers (`:84-155`) move into the core.
- `partitionTaskGraph` (`partitionTaskGraph.ts:94`) → adapter projecting core groups to `GraphPacket`.
  `mergeTokenBudget` and its gate (`:100-105, :126`) are deleted; `riskMassBudget` generalises to the
  core's mass ceiling.
- `buildWorkBlockPartition` (`workBlocks.ts:152`) → adapter: `Finding` → `CoherenceItem`, findings
  policy. Its `contextBudgetTokens` throw (`:167-176`) is deleted.
- `partitionWorkItems` (`workPartition.ts:531-808`) → **deleted**, not adapted. Seeded assignment,
  candidate-count search and the eight-term objective all go; they exist to trade off against a
  capacity bound that no longer exists.
- `deriveSeams` (`workPartition.ts:579-605`) → moves into the core behind the `seams.emit` axis.
- `computeDependencies` (`workBlocks.ts:41-131`) → **stays where it is.** Dependency ordering between
  blocks is not coherence; it consumes call-adjacency and critical-flow for sequencing, which is a
  genuinely different job from cohesion scoring.
- Deleted outright with their module: `resolveSizingWindowTokens` + `sizingWindow.ts`,
  `resolvePlanContextBudget` (`plan.ts:772`), `resolveCurrentWorkPartitionRuntime`
  (`workPartitionRuntime.ts:13`), and `block_quota` / `quota.*` as sizing inputs.

## 5. Open before coding — the findings draw's mass ceiling

The task draw's ceiling is risk mass. The findings draw has no equivalent today, because capacity was
doing that job. Candidates: summed finding severity weight, distinct-unit count, or distinct-file
count. **This is the one genuinely undecided element of the design** — it decides whether findings
blocks stay bounded, and picking wrong reproduces the single-giant-block failure in a new place.

## 6. Honest losses

- Per-group token ceilings are gone on both draws. Intended — that is the directive.
- The eight-term objective's balance properties (size balance, entropy spread, parallelism fit) are
  gone. Agglomerative merge optimises cohesion, not balance. Blocks will be less even.
- `over_budget` packet refusal disappears; nothing can claim a fit any more.
- Boundary-case tests that assert exact behaviour at a capacity edge have no successor.

## 7. Tests

Rewritten: `tests/audit/partition-task-graph.test.ts` (every case passes an explicit
`contextTokenBudget`), `tests/shared/work-partition.test.ts`, `tests/audit/work-blocks.test.ts`,
`tests/audit/task-affinity-graph.test.ts`. Deleted with the feature:
`tests/audit/dispatch-sizing-window.test.ts` (both cases), and one of the four in
`tests/remediate/plan-sizing-refusal.test.ts` — the other three assert surviving behaviour and must
be rewritten.

New property tests on the core, each red-green validated by inverting the production edit:
permutation invariance of output, every item in exactly one group, stable content-derived edge and
group order, mass ceiling actually bounds cluster growth, and policy axes affecting only their
declared signal.

Also fix while here: the persisted `edges` array is emitted in nested-loop order
(`taskAffinityGraph.ts:186-187, :240`) and is stable only because tasks are sorted upstream. The core
must sort by content before returning, or the artifact's content hash churns on any upstream
reordering.

## 8. Provenance

`codex` / `gpt-5.3-codex-spark` at xhigh produced the module and policy design; `agy` /
`gemini-3.6-flash-high` produced the independent degeneracy analysis that refuted two of its points.
Both lanes' load-bearing claims were re-verified against source locally. The DeepSeek lane was
rate-limited across all three routes for the whole session and contributed nothing.
