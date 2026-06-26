# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.30.9` on npm (`latest`). `main == origin/main` (remote `origin`), clean tree — but
**main is now AHEAD of the published 0.30.9** by two commits (granular-staleness feature, unpublished). CI publish
run for 0.30.9: https://github.com/OhOkThisIsFine/audit-tools/actions/runs/28208489202

**In flight:** main carries unpublished work (`8205073` O3 granular staleness). Not yet shipped to npm — a
`release:patch:publish` is the pending decision (see Next).

**Last landed (2026-06-25, on main, UNPUBLISHED): per-result granular staleness — O3 re-dispatch + record/consume/supersession.**
- Wires the previously built-but-unconsumed per-element result-baseline seam. A task whose audited content drifts
  after ingest is re-audited (`rekeyDriftedResults` → `emit_source:'redispatch', attempt:N` → distinct
  idempotency_key so the append-only ledger accepts fresh findings), the drifted task re-dispatches
  (`computeStaleResultTaskIds` → `state.ts`/`packetFilter.ts`), and stale findings are superseded
  (`selectCurrentResults` keyed on `task_id`, at the synthesis call site). Converges. `8205073`.
- New test `tests/audit/o3-redispatch-drift.test.mjs`. Audit 2447 pass / 0 fail; remediate 1874 pass.
- Surfaced a pre-existing latent bug (file-split sibling tasks collide on idempotency_key → ledger drops one) →
  `backlog.md` Open bugs. Design/finding commit `35a9a8e` precedes it.

**Last landed (2026-06-25, shipped in 0.30.9): confirm_intent regression — proper fix (deferred promotion).**
- Root cause: `promoteFinalAuditReport` deletes `artifactsDir`, and it ran on the friction-"ready" step
  (before the host finished triage). The host then wrote `open_observations` into the otherwise-empty
  recreated dir and called `next-step` → fold replayed → `confirm_intent`.
- Fix: `promoteIfFrictionSatisfied()` in `nextStepHelpers.ts` — promote (and delete `artifactsDir`) ONLY
  once `triage.action !== "dispose"`. While friction pending, keep the in-place report + leave artifactsDir
  intact so the next call re-evaluates triage cleanly. `audit_state.json` is already persisted complete by
  the last executor, so no write-back needed; a truly-complete rerun still starts fresh (verified by the
  packaged smoke). Single-sourced across both terminal paths.
- An earlier write-back band-aid (committed `20964a4`) was superseded — it masked the replay but broke
  "rerun after completion starts fresh" (the packaged smoke caught it).
- Also fixed (regressions in unpushed commits, 0.30.7 was green): 2 narrative tests + FINDING-018 write_paths
  (now 2 paths: per-task + packetResultPath) + packaged-audit smoke friction loop + 5 dead doc-manifest rows
  (`check:doc-manifest`, part of full CI `verify:release`, was failing on them — the local pre-tag gate only
  runs `check`, so it slipped through to the first failed CI publish of v0.30.8; v0.30.8 was deleted + skipped).
- Full suite green: node:test 3266 pass / 0 fail (11 skipped), vitest green, all 4 smokes pass.

**Trap learned this sprint:** the release script's local pre-tag gate runs only `npm run check`, but CI runs the
full `verify:release` (check + check:doc-manifest + test + verify:hosts + 2 smokes). Run `env -u CLAUDECODE npm
run verify:release` locally before tagging to catch doc-manifest / smoke failures that `check` alone misses.

**Previously shipped (0.30.7): rolling-dispatch same-file merge-serialization fix (a)+(c).** `main` carries:
- **(a)** file-ownership-disjoint wave scheduling — `src/remediate/dispatch/ownershipScheduler.ts` (new) +
  `ownershipRegistry.ts`/`amendmentClaim.ts` + `src/remediate/steps/nextStep.ts`: replaces the numeric
  `block_id.localeCompare` in-level admission with one-writer-per-canonical-file sub-wave admission, grant-time
  disjointness gate, atomic triage-retry claim hand-off, deterministic tie-break, canonical path identity
  (symlink = logged residual), disposition-aware claim lifecycle. `INV-SOO-*` (registered in
  [`docs/glossary-ids.md`](glossary-ids.md)).
- **(c)** `tests/remediate/cross-node-seam-signature-guard.test.ts` (new, test-only) — pins broker/repair/contentKey
  public signatures (PromiseLike/await-shape rejection, decision shape, contentKey nesting). `INV-SEAM-*`.
- **(b)** no-op-satisfied disposition was already shipped (`itemStatus.ts`).
- Design hardened through two adversarial counterexample rounds (CE-001…008 closed; one residual recorded:
  a grant queued behind a deliberately-retained blocked-pending claim waits on host triage — intrinsic).
- Full suite green on merged `main` (node:test 3265 + vitest 1874, 0 fail). Two cross-cutting guards fired on
  merge that the per-node worktrees skipped (id-glossary `INV-SOO` registration; `remediate-tests-invariants`
  either-or `.toContain` smell) — both fixed in follow-up commits.

**Doc reconciliation (2026-06-25):** the earlier "foundations remain unshipped" pointer was **stale handoff
drift** — foundations O1/O2/O3 were in fact merged in `cd089066` (content-key seam, append-only idempotent
ledger, friction triage, repair seam, with tests) and shipped in the 0.30.x line. `backlog.md` Open-bugs is now
empty; the only unshipped remediation-program item is the **mechanical multi-goal decompose + boundary-enforce**
forward track (the host still hand-scopes large inputs to one phase).

**Next — immediate:** decide whether to `release:patch:publish` the unpublished granular-staleness feature on
main (→ 0.30.10), or batch it with more work first. Then pick up the next forward track from
[`backlog.md`](backlog.md): the **general DAG extension** of granular staleness (per-file coverage-matrix
elements + incremental `runPlanningExecutor`) and the **mechanical multi-goal decompose + boundary-enforce**
remediator are the highest-leverage open items. Open bug to fix: file-split sibling `idempotency_key` collision
(backlog Open bugs).

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
