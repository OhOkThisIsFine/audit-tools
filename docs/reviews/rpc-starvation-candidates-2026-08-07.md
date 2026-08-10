# vitest RPC-starvation candidate sweep — 2026-08-07

Companion record for the open-bugs entry *"Vitest worker RPC starvation — the false-RED exit is
CLOSED at the gate; the >60s blocking worker is unlocated"*. Mechanism (established by direct
measurement that day, not re-derived here): vitest 3.2.6 workers answer birpc within a hard 60s
reply window; ONE continuous ≥60s synchronous stretch in a worker rejects its pending
`onTaskUpdate` and records the unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` error
while every test passes. A full-suite run reproduced the error with the long-blamed
`tests/audit/audit-code-completion.test.ts` worker measuring ZERO >5s event-loop stalls — the
blocker is elsewhere, or contention-emergent.

Sweep executed on the offload dispatch lane (DeepSeek, advisory); every claim below was verified or
corrected against source by the driving session before landing here.

## Verified

- **Sync full-CLI children in a worker (the defect class; FIXED same day).**
  `tests/remediate/next-step-pipeline-dispatch.test.ts` spawned the `remediate-code` wrapper as
  `spawnSyncHidden(process.execPath, [WRAPPER, "next-step", …])` with no timeout at three sites —
  two boot a full CLI `next-step` (real extraction + contract pipeline in the child), so the
  child's whole wall-time is one uninterrupted worker stretch, with no bound below the 120s test
  timeout — well past the 60s birpc window under contention. Converted to an async
  `spawnCli` helper (spawn + await, the `tests/audit/helpers/run-wrapper.mjs` pattern) so the
  worker yields for the child's whole runtime.
- **Why the audit e2e probe was clean:** the audit-side flows either run handlers in-process with
  awaits between short fixture-repo git spawns, or drive the CLI through the async
  `runWrapper` helper — no continuous sync stretch forms; those files are slow because the child
  is slow, not blocked.

## Corrected against the sweep's overclaims

- `tests/audit/git-history-mining.test.ts` "18 contiguous sync git spawns": wrong — `await
  writeFile` yields inside each `commit()` iteration, so the contiguous unit is ~2 fast git
  spawns. Not a credible ≥60s stretch. Demoted.
- `tests/remediate/remediate-code.test.ts`: fail-fast guard spawns, not long children (the sweep
  itself demoted this on inspection). Confirmed demoted.

## Open leads (unmeasured — verify before acting)

- Whole-repo gate scripts spawned synchronously in `tests/shared/*-gate.test.ts`
  (doc-manifest / nightly-routine-prompt / handoff-roadmap and siblings): single node child per
  spawn scanning the docs tree; plausibly seconds each, ≥60s only under severe contention.
  Cheapest check: per-spawn timing solo vs. an 8-worker contended batch.
- Production pure-JS hot loops reached by tests only at small scale, relevant on large real
  repos: `mineGitHistory`'s single `git log` child + O(files²) aggregation tail
  (`src/shared/git.ts`), `chunkByBudget`/packet-cost recomputation
  (`src/shared/chunkByBudget.ts`, `src/audit/orchestrator/reviewPackets.ts`), and
  `computeAuditScope`'s frontier rescan (`src/audit/orchestrator/scope.ts`). These starve
  regardless of worker count if inputs are large; none is tied to the observed test-suite error.

If the error recurs after the spawnCli conversion, the gate-script spawns are the next candidates
to instrument; the recipe (500ms-tick event-loop stall probe, >5s threshold, STALL-gated by env)
is in the open-bugs entry's history.
