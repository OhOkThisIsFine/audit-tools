# Evaluation of the 2026-09-30 cloud-agent work — 2026-10-01

<!-- review-routing: backlog-bugs -->

Scope: the work another agent (ChatGPT, in a Linux cloud workspace) landed on `main` on 2026-09-30:

| Commit | Change | Release |
| --- | --- | --- |
| `ab1e9862` (#12) | Contract, safety and governance polish; backlog reconciliation. 322 files, +12k/−6.7k. | v0.52.4 |
| `3be28e4b` (#13) | Release script runs the installed remediation bins. | v0.52.5 |
| `3f73d24f` (#14) | Outcomes-first simplification. Most of the remediate contract pipeline replaced by one reviewed execution plan. 249 files, +7k/−46k. | v0.53.0 |
| `cb63ca70` | Route-scanner regression probes run in killable subprocesses. | v0.53.0 |

Method: three independent reviewers (one per area: #14 remediate, #14 audit plus #13 and
`cb63ca70`, #12), then one adversarial refuter that tried to break every high and medium
finding against the source, and reproduced the push-gate bypass with a synthetic hook payload.
Severities below are the refuter's final ones.

## Verdict

The work is sound in its main lines and keeps the architecture's load-bearing properties:

- The audit obligation engine still holds one lock, runs one drain, and commits the fold on
  both the success and the throw path. The registry still derives from `PRIORITY`.
- The remediate execution plan is checked by `assertApprovedRuntimePlan` at prepare, ingest,
  recovery, close entry and before the closing action. Approval (`readApprovedExecutionPlan`)
  binds source hashes, owner and risk decisions, review receipts and judge independence. A
  unit's `allowed_files` is still the enforced write grant.
- Analyzer consent and declines bind the current run; formatting is off by default and dry-run
  refuses it; review acceptance binds the issued prompt and the current task revision.
- No retired mechanism (provider, model, quota or routing logic) came back.
- #13 and `cb63ca70` are correct.

The defects are at the edges: one guard bypass, one gap in the staleness DAG, a review-cycle
counter that does not reset, a scope-reorder wedge, an attestation gap at the GitHub merge
boundary, two backlog entries closed with their defect still present, and two Windows-only test
failures. The cloud agent validated on Linux only, so the Windows failures were invisible to it.

## Findings (after refutation)

| Finding | Severity | Status |
| --- | --- | --- |
| `.claude/hooks/push-gate.mjs` lets `git push origin HEAD` / `origin @` through on `main` (reproduced). | medium | backlog `open-bugs.md` |
| Architecture-discovery tasks in `audit_tasks.json` read five artifacts that `spec/audit/dependency-map.md` does not declare as its dependencies; freshness rests on the comparator `architectureDiscoveryWorkChanged`. | medium | backlog `open-bugs.md` |
| A loop-core change can reach `main` without a staged-tree attestation: a cloud branch commit and a GitHub squash merge both skip `.githooks`, and CI checks no attestation. `src/audit/cli/nextStepCommand.ts` and `semanticReviewStep.ts` are outside `LOOP_CORE_PATTERNS`. | medium | backlog `open-bugs.md` |
| Remediate plan review: the 8-round cap counts the plan's whole life and does not reset at approval; stall detection and an owner disposition of a judge-accepted counterexample were removed with no replacement. Judge approval and `residual_risk` decisions still exit, so this is not a dead end. | medium | backlog `open-bugs.md` |
| A clarification that re-adds an in-scope file re-sorts `allowed_files`, changes the plan revision, and makes `assertApprovedRuntimePlan` throw `plan_repair_required`. | medium | backlog `open-bugs.md` |
| Backlog entries O49 and O03 were closed by #12 with the defect present: about 15 audit-side prompt sites still say "subagent", and `skills/audit-code/audit-code.prompt.md` still carries dev-only instructions for third-party audits. | medium | backlog `open-bugs.md` (re-opened) |
| `dispatch/lens-definitions.json` ships with no code reader; the worker lens guidance it holds is not delivered (gap since `467b1e8f`, recorded by audit finding MNT-4d792ce9). | medium | backlog `open-bugs.md` |
| Two audit tests from #12 compared native `join()` paths with the `toPromptPathToken` paths the step writer emits; red on Windows. | medium | **fixed** in `d719035d` |
| Trap T44 was deleted while its barrel-spy recognizer matches only the `audit-tools/shared` spelling. | low | backlog `minor-bugs.md` |
| Charter blind-lane results carry no inputs declaration, and the semantic-review handoff names a semantic block while a charter step is current. | low | backlog `minor-bugs.md` |
| Doc drift: `CLAUDE.md` does not say ingestion now runs before the engine; its remediate state diagram puts `waiting_for_clarification` beside planning, but only implementing and triage reach it. | low | backlog `minor-bugs.md` |
| Legacy durable declines no longer stop default analyzers. | — | **refuted**: the state was never tool-producible, and per-run choices are the recorded policy. |
| O36 closure. | — | **refuted** as a defect: closed under a recorded decision. |
| Repaired counterexamples lose protection. | low | downgraded: the prompt equals the enforcement; no regression. |
| Ingestion moved out of the obligation registry. | low | downgraded: the fold boundary is intact; covered by the doc-drift entry. |

## Other state found this lap

- The nightly ledger had six settled answers not marked done. Five landed in #12 and are now
  marked; `f78305ac08246ae5` (a nightly helper that owns a throwaway worktree for a
  repository-reading lane) has not landed and has a backlog entry.
- `.claude/static-analysis.json` was missing, so the machine-wide nightly runner skipped this
  repository; it now declares eslint, knip, jscpd and dependency-cruiser.
- The project memory store described the deleted contract pipeline. It was swept against HEAD
  (7 notes deleted, 33 edited); `check:memory-citations` had gone red on one dangling path.
- Two Codex worktrees from 2026-09-26 held uncommitted work. `codex/packet-3-contract-fields`
  is fully on `main` and was removed. `codex/recovery-reconciliation` held unique work written against the pre-#14
  architecture; by owner decision it was archived (verified tree-identical), the worktree was
  removed, `stash@{0}` was kept, and the salvage is a forward track in
  [`forward-tracks.md`](../backlog/forward-tracks.md).
