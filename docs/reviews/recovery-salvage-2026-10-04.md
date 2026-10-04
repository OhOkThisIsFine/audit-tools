# Recovery-reconciliation salvage — verdicts (2026-10-04)

<!-- review-routing: no-forward-work -->

The archived Codex work of 2026-09-26 (268 uncommitted changes written on `72437f1e`, before #12–#14)
was preserved as the branch `preserve/recovery-reconciliation-2026-09-26` (`0227ddae`) and judged
candidate by candidate against current `main`. Each verdict was checked against source by mechanism,
not by a reviewer's recall.

## Ported, each with a red-green-validated test

| Candidate | Where it landed |
| --- | --- |
| Orphan-module scan ignores tracked paths that no longer exist on disk | `trackedFiles` in `scripts/check-orphan-modules.mjs` |
| One spawn for every derived pre-commit leg, with no unmeasured time limit | `runDerivedLeg` in `scripts/shared/derived-file-preflight.mjs` |
| `remediation-outcomes.json` is checked against its owning schema before the write | `assertValidRemediationOutcomesReport` in `src/shared/validation/producerBoundary.ts` |
| Conceptual-review perspective selection tests, adapted to the one reader `selectPerspectives` | `tests/audit/conceptual-review-selection.test.ts` |

## Rejected, with the reason

| Candidate | Reason |
| --- | --- |
| Performance profiler | No consumer; the profiling scripts under `scripts/shared/` already own the job. |
| `directedReachability` | Duplicates `src/shared/graph/orderedReachability.ts`. |
| `retiredArgs` | The CLI already refuses unknown arguments through its allow-list and commander. |
| `collectFiles` | Duplicates `src/shared/io/collectFilesSorted.ts`. |
| Prompt Contract v1 primitives | No consumer; the prompt-contract registry test covers the contract. |
| `reviewSnapshotStore` | Its second consumer was deleted by #14, so one consumer remains and no shared store is needed. |
| `ignoredRootLogs` | `src/shared/observability/rootLogObservations.ts` already owns it. |
| Audit half of the producer boundary | `audit-findings.json` is already validated at its write through `jsonArtifact`. |
| Source-test-ownership gate | It is the universal certification gate the governance track omits; source-to-test declarations are navigation, and the pin checks already cover them. |
| `run-release-gates` | The release-gate catalog and `verify-steps` already own it. |
| Backlog corpus | `scripts/check-backlog.mjs` already owns it. |
| Deletion of `profile-run` and `verify-steps` | Both are still used. |
| Backlog-validator edits | Superseded by later validator changes on `main`. |
| `check-shared-primitives` edits | They guard files that no longer exist. |
| `check-sites-pinned` edits | They add a 16 MiB output cap with no measurement behind it. |
| Six audit tests | Each is covered on `main` or tests rejected code. |
| Remediate lifecycle layer | Obsolete since #14 replaced the lifecycle. |
