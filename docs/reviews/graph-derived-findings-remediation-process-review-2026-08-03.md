# Graph-derived findings and remediation-process review — 2026-08-03

## Durable state

- The repository-local remediation run is intentionally paused at `CP-NODE-4`.
- `.audit-tools/remediation/state.json` still says `implementing`; the worker was stopped manually, so the state machine does not yet contain a first-class pause record.
- The worker worktree is retained at
  `.audit-tools/worktrees/remediate-CP-BLOCK-CP-NODE-4-audit-tools-approved-audit-remediation`.
- Its six-file diff is unmerged and uncommitted. The worker log records a failing dedupe test after strict duplicate-ID validation exposed the distinction between local worker IDs and final report IDs.
- The authoritative findings, review disposition, contract-pipeline artifacts, implementation DAG, task record, and worker logs remain under `.audit-tools/`.

## Operator decisions preserved

- Optimize for ideal code and architecture; implementation effort and backward compatibility are not
  reasons to retain a weak design.
- Keep one shared runtime/core and express mode differences as policy and drawing/rendering choices,
  rather than forking parallel implementations.
- Establish the remediation plan in this conversation, then stop. Do not execute remediation here;
  the next conversation owns recovery and implementation.
- Preserve the substantial existing dirty-tree work-in-progress and do not use destructive checkout or
  reset operations to make the workspace look clean.
- Make remediation tool-enforced, resumable, and evidence-backed; use the repository's canonical
  verification gates rather than ad-hoc command substitutes.

## Preservation coverage and limits

The useful conclusions and recovery pointers are now represented in multiple durable layers:

- This review is the primary narrative record, including the sixteen-item disposition, process
  reflections, proposed design changes, and next-work ordering.
- [`docs/HANDOFF.md`](../HANDOFF.md) carries the immediate paused state and recovery pointer;
  [`docs/backlog/open-bugs.md`](../backlog/open-bugs.md) carries the actionable tool defects; and
  [`docs/backlog.md`](../backlog.md) is the generated seek index.
- `.audit-tools/` retains the machine findings, review resolution, implementation DAG, remediation
  state, run/task records, and worker logs. The CP-NODE-4 worktree remains unmerged and uncommitted.
- Project memory retains the two cross-conversation rules at
  `C:\Users\ethan\.claude\projects\C--Code-audit-tools\memory\`:
  `remediation-plan-only-pause-is-durable-control.md` and
  `graph-derived-leads-require-semantic-promotion.md`, with links in that directory's `MEMORY.md`.

The primary checkout and the retained worker worktree are intentionally dirty and no commit was made.
That preserves existing WIP without claiming that this checkpoint is published history. The next
conversation should inspect the retained worktree and use the backend's recovery/status path before
redispatching; it should not infer a pause by hand-editing `state.json`.

## Checkpoint verification — 2026-08-03

The preservation edits were checked with the repository's documentation and hygiene gates:

- `node scripts/shared/generate-backlog-index.mjs --check`
- `node scripts/check-doc-manifest.mjs`
- `node scripts/shared/generate-handoff-roadmap.mjs --check`
- `node scripts/check-backlog-budget.mjs`
- `git diff --check`

All passed. No remediation step was advanced, no worker was redispatched, and no state file was
hand-edited during this checkpoint.

## Verdict on the sixteen declined graph-derived findings

None should be reinstated as a remediation finding in its current form.

- The eight `architectural_seam` items (`ARC-4d792ce9`, `ARC-3350b907`, `ARC-eaffc6ab`, `ARC-1f6965ef`, `ARC-1bbe4886`, `ARC-234713b7`, `ARC-c281ea50`, `ARC-c58cdaa2`) are a detector-class problem. A graph bridge can be desirable modularity, a normal test-to-subject edge, or manifest/asset wiring. The current detector promotes every bridge to a systemic architecture finding without runtime criticality, component-size, or semantic-boundary evidence.
- `ARC-6ba55c63`, `ARC-cfd6bec0`, and `ARC-285e6921` are useful corroboration of real audit/remediation dispatch drift, but CP-NODE-1 already owns the one-shared-runtime correction. They should not create three extra remediation tracks.
- `ARC-d8e2f0a5` is ordinary vertical coupling inside audit orchestration, not an independent defect.
- `ARC-eaffc6ab-2` (the 919-file behavioral cluster) demonstrates over-connected consensus/weighting, not a 919-file refactor target.
- `ARC-78b9b908`, `ARC-da2c06a4`, and `ARC-eaffc6ab-3` rely on a weak premise: any document that mentions multiple files is treated as declaring one module. Document co-mention is not an ownership boundary.

The worthwhile result is a meta-finding: deterministic graph heuristics are being promoted directly into machine findings. They should remain provenance-bound design leads until semantic review confirms them.

## Process findings

1. The workflow needs an explicit persisted `plan_only`/`apply` mode and a first-class pause, cancel, resume, and status/handoff surface. A plan-only stop currently required discovering and terminating wrapper, backend, and detached Codex processes manually; the state remained `implementing`.
2. Worker dispatch must bind to a declared source snapshot. A committed worker base can diverge from substantial uncommitted root WIP unless the dirty overlay is either included and scoped or dispatch is blocked.
3. Node acceptance needs a mechanically generated obligation checklist. CP-NODE-4 exposed partial-but-plausible work that still lacked immutable provenance, projection construction, complete disposition authorization, observer-failure containment, and near-boundary arithmetic tests.
4. Implementation nodes should follow cohesive contract seams. The original CP-NODE-4 combined findings identity, dedupe, projection, validation, and graph arithmetic; the six-file, 776-line worktree diff and red test show that this cut is too broad for reliable review.
5. Verification must use canonical command identities, not raw commands embedded in node descriptions. The repository's Vitest gate is the authority.
6. Findings need immutable producer/generation/provenance lineage. The graph output showed same-primary-path fuzzy dedupe mixing titles, summaries, and file sets; a global failed test was also copied as `not_confirmed` evidence onto many unrelated findings.
7. Design-check/refutation outcomes, including unavailable offload lanes and fallback reviewers, should be persisted as node-bound attestations rather than surviving only in conversation history.

## Planned durable direction

1. Recover CP-NODE-4 from the retained worktree; reconcile root WIP; split the node into cohesive findings/provenance, dedupe/conservation, and checked-graph-arithmetic cuts; then make each obligation mechanically verifiable.
2. Complete CP-NODE-7 and CP-NODE-1, absorbing the three useful hidden-coupling signals into the shared workflow/dispatch runtime.
3. Complete CP-NODE-2 and CP-NODE-3 with immutable generations, authoritative remediation state, and durable worker lifecycle control.
4. Add a graph-lead boundary: retire generic cut-edge findings, normalize co-change by file churn and commit breadth, replace document co-mention grouping with explicit intent claims, and promote only semantically confirmed leads into findings.
5. Preserve the sixteen items as regression fixtures: twelve negative examples, three shared-core corroborations, and one ordinary vertical-coupling example.
6. Finish the remaining DAG in dependency order, run the canonical build/check/Vitest/release gates, and commit only after the staged tree is green.

Primary machine artifacts: `.audit-tools/audit-findings.json`, `.audit-tools/remediation/review_resolution.json.consumed-1785738014904`, `.audit-tools/remediation/intake/contract/implementation_dag.json`, `.audit-tools/remediation/state.json`, and the CP-NODE-4 run directory.
