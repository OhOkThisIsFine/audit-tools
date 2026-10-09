# Artifacts-dir rollover — design-check record, 8 October 2026

<!-- review-routing: backlog-forward -->

Second half of the frozen-snapshot track ([`frozen-snapshot-design-2026-10-08.md`](frozen-snapshot-design-2026-10-08.md),
owner decision "keep the artifacts dir"). Dated record, not a spec.

## Property

A completed audit's working dir survives completion. The next audit run in the same repository
reuses every derived artifact whose inputs did not change, as judged by the existing staleness DAG,
and inherits NOTHING that belongs to the previous run: no run identity, consent, per-run choice,
submission, lane, ledger, step contract, snapshot or host guidance.

## As built

1. **Promotion keeps the dir.** `promoteFinalAuditReport` (`src/audit/io/artifacts.ts`) archives
   exactly as before and reports `archived` instead of deleting; its append-only diagnostics half
   is `archiveRunDiagnostics`. `isWorkingDirFullyPromoted` reads `archived` (the `cleanup` verb's
   rule).
2. **A presented report ends the run.** `promoteCompletedReport` (the terminal step), once the report
   is promoted, removes the run snapshot and writes the run-ended marker (`markRunEnded`), whatever
   the status: a rendered report on a stopped fold ended the run when promotion deleted the dir, and
   still must — re-reading the same frozen snapshot would only stop it again.
3. **Rollover is its own entry step.** `rollOverFinishedRun` (`src/audit/io/rollover.ts`, loop-core)
   runs at next-step entry before the pre-run sweep, under the artifact-tree lock: for an ENDED run
   it archives the diagnostics again (a member that does not archive keeps the whole dir), removes
   the snapshot (a cleanup problem keeps the whole dir), and deletes every entry not on the carry
   ALLOW-LIST, the state file and the marker LAST so a failure part-way is retried in full. The
   sweep (`cleanupStaleArtifactsDir`) is unchanged and still called identically by both callers.
4. **Carry allow-list** (`CARRIED_ARTIFACTS`, `CARRIED_STORES`, `CARRIED_INTENT` in `rollover.ts`):
   the DAG-derived artifacts, `artifact_metadata.json` (the baselines), `audit_results.jsonl`, the
   content-keyed stores (design-review snapshots, graph edge cache, charter packet archive) and the
   hand-authored `session-config.json`. Everything else is deleted, so a run-scoped file added later
   cannot leak by omission. The reasons for each deleted class are stated in the module header.

## Refutation (AGY gemini-3.8-flash-high, report-only; each verdict checked against source)

- **Accepted — caller-specific mode in the sweep.** The plan added a `rollOver` flag to
  `cleanupStaleArtifactsDir`, whose header records owner decision `74c89b226ab9b9cd` as "two
  callers call this identically". Rebuilt as a separate entry step (item 3).
- **Accepted — `tooling_manifest.json` unclassified.** It is never read from disk (every bundle load
  rebuilds it); deleting it is correct and is now stated.
- **Rejected by measurement — "deleting the intake set, the intent checkpoint and the planning
  upstreams re-stales every carried artifact".** Over an UNCHANGED tree the second run re-derived
  only deterministic planning (`audit_tasks`, `audit_plan_metrics`, `task_affinity_graph`); the
  re-intaken manifest differed only in its non-semantic `generated_at`, the re-confirmed intent
  checkpoint was identical, and the analysis and host-judged artifacts (charter register, design
  assessment, systemic challenge) kept their revisions. The second run went straight to
  `present_report`.
- **Rejected by test — "a reset wave generation and signature-stable result keys swallow the next
  run's results".** `tests/audit/artifacts-dir-rollover.test.ts` ingests the second run's results:
  every one is appended and the run completes. `runs/` and `dispatch/` are deleted, so nothing
  carried names a review-run id; `access_memory.run_id` is non-semantic.
- **Not a defect — `audit_results_ingested` checks presence only.** Pending work is decided by the
  per-result baselines (`computeStaleResultTaskIds`); the test shows only the edited file's tasks
  pending.

## Independent review, round 4 (Opus, report-only; each finding checked against source)

- **Fixed — the gate was byte identity.** A host append to `agent-feedback.jsonl` or the ledger
  after promotion, or `resynthesize` rewriting the promoted pair, broke the identity, so the next
  next-step re-presented the old report forever (or copied the in-place pair over the operator's
  resynthesized deliverables). The gate is now the run-ended marker, and the rollover re-archives.
- **Fixed — an unfinished run with a rendered report looped on its frozen snapshot.** A presented
  report now ends the run whatever its status.
- **Fixed — a partial rollover let the next run adopt the old consent.** The state file and the
  marker are deleted last.
- **Fixed — `analyzer-policy.json` was carried.** It holds tool-written install settings (per-run
  choices, owner directive 2026-08-21); it is deleted at rollover, as promotion deleted it before.
- **Fixed — no lock, lock file deleted; a failed snapshot removal leaked.** The rollover runs under
  the artifact-tree hold, never deletes the lock file, and keeps the dir when the snapshot cleanup
  reports a problem.
- **Round 5 (same reviewer) — fixed: the marker could end a run whose machine contract did not
  archive**, and the rollover (which re-archives only the diagnostics) would then delete its only
  copy. The terminal step writes the marker only when `audit-findings.json` archived, and the
  rollover refuses while an in-place contract has no promoted copy (an existence check, which a
  resynthesized promoted pair always satisfies). **Fixed:** the pre-run sweep deleted a dir whose
  snapshot could not be removed, leaking the snapshot; it now keeps the dir and says why.
- **Round 6 — fixed: the already-promoted path took a PREVIOUS audit's promoted contract as this
  run's** (it always exists), marked the run, and the rollover deleted the only copy. The terminal
  step now compares the contract's bytes and promotes it again when they differ. **Fixed:**
  `cleanup --force` refused over an unremovable snapshot (a corrupt record made that permanent); a
  forced delete now proceeds and names what it leaves behind, and only the unforced sweep keeps the
  dir.
- **Accepted residual — other commands see a retained ended run.** `plan`, `sample-run` and the
  remediate input listing see the finished run until the next `next-step` rolls it over; the
  remediate auto-selection still picks the promoted pair.

## Residuals

- An edit to any file re-runs the charter lanes (all three): `charterReadFileSlice` reads one
  read-set. That is the track's third half (per-lane packet digests).
- A restore of a lost snapshot checkout does not re-place a nested repository's ignored entries
  (frozen-snapshot record).
