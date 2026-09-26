# Staleness measurement: recovered evidence and remaining work

<!-- review-routing: deferred -->

The September 20 candidate report did not establish downstream cascade cost. During recovery reconciliation on September 26, source review found that `measureCascadeCost` in `src/audit/orchestrator/staleness.ts` timed only `computeStaleArtifacts`. It never ran the invalidated executors, measured model usage, or judged semantic equivalence. Its baseline argument was unused, and every branch reported that invalidation was necessary. The earlier sub-5ms, zero-model-token and task-closed conclusions are withdrawn.

The original report remains in the independently preserved recovery export. This document states the current evidence; it does not close M29 or D03 in the frozen backlog inventory.

## What is verified

The measurement helper now compares baseline and modified invalidation sets. It excludes already-stale artifacts from the additional cascade attributed to the proposed change. It returns `classification_elapsed_ms` for the changed bundle's classification, and `unnecessary_invalidation: null` because no semantic necessity judgment ran.

The recovery description reports affected dependency edges and existing invalidated artifact bodies. The legacy `rederived_artifacts` field names candidates for rederivation; it is not a receipt that they were executed. Likewise `actual_context_bytes` measures serialized bodies already in memory. It does not measure context supplied to a worker. The byte-derived token count is explicitly a heuristic estimate.

`tests/audit/staleness-cascade-cost.test.ts` exercises a real finding-summary reword, the existing intent-equivalence path and a repository-manifest change. Two additional regressions first failed against the recovered implementation: classification was incorrectly presented as a semantic verdict, and an unchanged already-stale baseline was attributed to the proposed change. The repaired suite passes seven tests.

## What remains

Run representative prose changes through actual downstream execution, recording the upstream delta, affected edges, rederived artifacts, executor duration and supplied prompt context. Keep measured model usage separate from estimates and note unavailable usage data. Include a baseline so pre-existing stale work is not charged to the new change.

Only that evidence can establish whether unnecessary expensive invalidation remains and whether another equivalence gate is justified. The existing DD-9 and whole-manifest challenge policies remain in force. No cache or narrower staleness semantics was added.

## Validation record

Recovery reconciliation ran the seven-test suite on September 26. The complete local log is preserved with the recovery evidence as `2026-09-26T20-48-17-105Z-run-e91498bd-OK.log`. This focused result does not certify the combined candidate or replace the outstanding live measurement.
