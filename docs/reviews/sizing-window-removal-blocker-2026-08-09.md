# Sizing-window removal — the affinity graph is already the product

Pre-implementation finding for `HANDOFF` *Immediate next* 1. Every claim is verified at HEAD by
reading source, not by citation.

## 1. The HANDOFF's "scope is settled" is false

`docs/HANDOFF.md:110-111` says the next commit "is a removal, not a re-sourcing" and that "grouping
survives … Scope is settled, nothing open."

At HEAD, grouping does **not** survive a bare deletion. The decision *to group at all* is gated on
the very budget being deleted, in five places:

| # | Site | Behaviour when the window is absent | Class |
|---|---|---|---|
| 1 | `src/audit/orchestrator/partitionTaskGraph.ts:126` | merge loop skipped → **every task becomes its own packet** | **SILENT** |
| 2 | `src/audit/reporting/workBlocks.ts:167-176` | `throw` — "Cannot partition audit findings because the usable context budget is unknown" | runtime throw |
| 3 | `src/shared/decompose/workPartition.ts:103-107` | `throw` — "capacityTokens must be a finite non-negative number" | runtime throw |
| 4 | `src/audit/cli/dispatch/quotaPool.ts:179-186` | `throw` — "Cannot size audit packets for pool …" | runtime throw |
| 5 | `src/remediate/phases/plan.ts:815-823` | `throw` — "Cannot size remediation blocks …" | runtime throw |

Site 1 states the inverted conviction in a comment (`partitionTaskGraph.ts:124-125`):

> `// Unknown window (mergeTokenBudget null): no merges at all — every task`
> `// stays its own packet, because any merge would be an unfounded fit claim.`

No planning document caught this. Grep across `docs/reviews/`, `docs/backlog/forward-tracks.md` and
`docs/HANDOFF.md`: neither the separation plan nor the S2 design-check mentions `partitionTaskGraph`,
`mergeTokenBudget`, `buildWorkBlockPartition` or `workBlocks.ts`. `forward-tracks.md` contains no
occurrence of "coherence" at all.

## 2. The shape of record — owner's reframe, 2026-08-09

> *"separate tasks have some kind of affinity metric connecting them, then the conversational host
> can make its decision about what tasks to dispatch to what targets."*

This supersedes the question of "what bound replaces the window". There is no replacement bound,
because the tool stops deciding grouping. It emits **tasks + an affinity metric**; the host groups.

**This is already built.** `task_affinity_graph.json` is a first-class persisted artifact today:

- registered in `ARTIFACT_DEFINITIONS` — `src/audit/io/artifacts.ts:284`, payload type at `:120`
- in the dependency DAG, upstream `audit_tasks.json` — `src/audit/orchestrator/dependencyMap.ts:194-198`
- zod-schema'd and versioned `task-affinity-graph/v1` — `src/audit/orchestrator/taskAffinityGraph.ts:59-66`
- built and written at planning — `src/audit/orchestrator/planningExecutors.ts:307-309, 336, 352`
- described in-source as **provider-neutral** — `taskAffinityGraph.ts:6`, `partitionTaskGraph.ts:9`,
  `planningExecutors.ts:304-305`

Its edge kinds are pure content signals, with zero transport properties
(`taskAffinityGraph.ts:190-208`): `shared_file`, `cross_lens_same_file`, `same_flow` (shared
`critical_flow:` tag), `same_unit`, `call_adjacent` (import/call adjacency from `graph_bundle`),
`same_dir`. Every node already carries `token_estimate` and `risk_estimate`
(`taskAffinityGraph.ts:36-40, 160-167`).

So the directive's stated end state — *partitions on content coherence and reports a token estimate*
— is **already satisfied by an artifact that ships today**. What has to go is the internal consumer
that folds that graph under a backend window, not anything that needs authoring.

## 3. What that makes the commit

Not "delete three resolvers". The shape is:

- **Delete** `resolvePlanContextBudget` (`plan.ts:772`), `resolveCurrentWorkPartitionRuntime`
  (`workPartitionRuntime.ts:13`), `resolveSizingWindowTokens` (`sizingWindow.ts:48` — note
  `quotaPool.ts:173` is a call site, not the definition; the whole `sizingWindow.ts` module goes,
  its only other export `SizingWindowInput` has no outside consumer).
- **Delete** the window-fold from `partitionTaskGraph` — `mergeTokenBudget` and its gate at `:126`.
  Whether any merging remains there at all follows from §2: if the host groups, this partitioner is
  itself the thing being retired, and the graph is shipped instead.
- **Invert** the four refusal sites (2-5 above) so "no window" is the normal path, not an error.
- **Re-point** `work_blocks` in `audit-findings.json` from a fit claim to a coherence grouping plus an
  estimate — or drop it in favour of the graph, per §2.
- Atomic-replace invariant applies: new mechanism and deletion in one commit.

Test classification from the lane pass, to be re-verified when the edit is written:
`tests/audit/dispatch-sizing-window.test.ts` — both tests delete with the feature.
`tests/remediate/plan-sizing-refusal.test.ts` — one deletes with the feature, three assert surviving
behaviour and must be rewritten. `tests/audit/partition-task-graph.test.ts` — every case passes an
explicit `contextTokenBudget`; all need re-basing.

## 4. Two properties to settle before the graph is the primary contract

Both are consequences of promoting an internal structure to a public one.

**Edge-array order is inherited, not content-derived.** Edge *endpoints* are canonically ordered by
`task_id` (`taskAffinityGraph.ts:226-229`), but the `edges` array is emitted in nested-loop order over
the task list (`:186-187`) with no sort before return (`:240`). It is stable today only because
`buildChunkedAuditTasks` sorts tasks by priority then `task_id` upstream (`taskBuilder.ts:330-420`).
The repo's invariant requires order derived from content *in the artifact*, not inherited from an
upstream sort — otherwise any upstream reordering churns the content hash and cascades phantom
staleness. Minimal fix: canonical sort of `edges` (and `nodes`) in the builder before return.

**Weight saturates.** `weight = Math.min(1, weight + SAME_LENS_BONUS)` then rounded to 3 decimals
(`taskAffinityGraph.ts:222, 234`). Distinct strong affinities collapse to exactly `1.0`, and the
authors describe the scale as soft and not cross-run comparable (`taskAffinityGraph.ts:8-13, 49-53`).
That was harmless when one known algorithm consumed it; it is a real ambiguity for a host reasoning
over it. Mitigation already present: the `reason` field carries the full contributing kind set, not
just the dominant `kind` (`:220, 235`), so a host can discriminate saturated edges — provided the
contract says so.

## 5. Provenance

Recon dispatched off-quota to peer lanes; every load-bearing claim re-verified locally against source
before landing here. `agy` / `gemini-3.6-flash-high` found site 1 and the degenerate output. `codex` /
`gpt-5.3-codex-spark` at xhigh produced the decision digest, the remediate-side trace, the test
classification, and the affinity-graph survey. The DeepSeek lane (`deepseek-v4-flash` via the local
router) was rate-limited across all three of its routes for the entire session — 18 attempts, two
payloads, zero completions — and contributed nothing.
