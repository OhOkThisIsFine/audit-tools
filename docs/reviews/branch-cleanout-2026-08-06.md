# Branch/worktree cleanout — 2026-08-06

Owner-authorized cleanout of run-era branches and orphan worktree dirs: delete everything holding
no unaddressed work, surface everything that does. Result: **243 local branches → 2**
(`main` + `remediation/remediate-audit-2026-07-30`), remote trimmed to `main`, and the 179 moved
orphan-worktree dirs discarded.

## Method (deterministic first, judgment last)

1. **Ancestor check** — `git merge-base --is-ancestor <b> main`: 145 branches were pure ancestors
   → deleted without further analysis.
2. **Patch equivalence** — `git cherry main <b>` over the 98 remaining: commits whose patches are
   on main verbatim.
3. **Scratch classification** — branches whose entire merge-base→tip diff touches only worker log
   files (`*.log`, `test-output*`, root scratch): 63 → deleted (full file-list audited; nothing
   but logs).
4. **Blob-vs-main + blob-in-history** — for the 32 branches touching real paths: compare each
   changed file's branch blob against main HEAD, then against every blob main ever held for that
   path. 5 branches matched HEAD outright.
5. **Semantic verification** (offload lanes, dispatcher spot-verified): for the 27 remaining, per
   node: the run-outcome disposition in `.audit-tools/remediation-outcomes.json`
   (`resolved` → change present on main in driver-landed form; `verified_no_change` →
   addressed-by-rejection), diff-vs-main mechanism comparison, and supersession checks against
   later deliberate work (e.g. CP-NODE-57's tier-routing removal superseded by the v0.37.0
   multi-rank rework).

## Verdicts

- **dogfood-20260806-v0361 run (landed at `3a17ca8c`, 211 items terminal):** every node branch
  verified addressed (landed, rejected-by-review, or deliberately superseded) → all deleted.
- **remediate-audit-2026-07-30 run:** the 8-commit stack NEVER landed on main — genuinely
  unaddressed mechanisms (see the open-bugs entry). Landing branch
  `remediation/remediate-audit-2026-07-30` KEPT as the single preservation ref; its 10 node
  branches were exact-tip duplicates or worker-variant prefixes whose deltas the driver
  deliberately re-landed in reviewed form → deleted.
- **`claude/sharp-matsumoto-3abf69`** (unlanded 2026-07-23 `nodeHttpFetch` transport fix):
  superseded ~2h later by the shipped `deadlineBoundFetch`
  (`src/shared/providers/openAiCompatibleProvider.ts`), and its hand-rolled `node:http` approach
  is a recorded retirement in `docs/backlog/durable-traps.md` → deleted.
- **Remote branches:** `claude/awesome-poincare-399ae8`, `claude/pensive-haslett-cd1dcc`
  (ancestors of main), `remediation/dogfood-20260806-v0361-remediation` (0 ahead), `doc-review`
  (2026-07-23 nightly-ledger session artifacts, fully superseded by the current nightly system)
  → all deleted.
- **Orphan worktree dirs** (179, previously moved out of `.audit-tools/worktrees/`): discarded —
  the run is landed + recorded and every surviving diff lives in a verified branch ref or main.

Recovery: pre-deletion tips are recorded in the session scratchpad
(`branch-tips-before-cleanup.txt`); objects remain reachable via reflog until gc.
