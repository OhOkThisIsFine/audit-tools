# Accept-latch + rollback family — verified mechanisms (2026-07-23)

Pre-fix mechanism record for the backlog entry *Accept-latch + rollback family* (HIGH, evidence in
`remediate-dogfood-completion-2026-07-23.md`). Three independent traces — a Claude Explore agent, a
NIM `glm-5.2` cross-read (free lane), and direct source verification by the driver — converged on the
map below. Every claim was verified against HEAD (`e8d1e9ad`) by reading the cited code, per
[[verify-delegated-findings-mechanism-not-just-citation]].

## Verdict per defect

| Defect (backlog prose) | Verdict at HEAD | Real mechanism |
|---|---|---|
| (a) failed accept latches "accepted" | **CONFIRMED** | `rollingSession.ts:548` — unconditional `session.accepted.push` |
| (b) rollback resets to session-recorded base, drops sibling | **REFUTED at HEAD** | no such path exists; `baseOid` is tip-at-accept-start under the base lock |
| (c) rollback deregisters/empties the node worktree | **CONFIRMED, corrected mechanism** | worktree removed by design on *every* accept exit; post-merge gate failures happen *after* removal with no re-provisioning |
| (d) rolled-back node labeled `resolved_no_change` | **CONFIRMED, two-part** | monotonic sidecar guard preserves a stale `merged:true` + no-change closures are excluded from the ancestry reconcile |

## (a) — the accepted-latch write ordering

`advanceHostRolling` (`src/remediate/steps/rollingSession.ts:459`), under the session lock:
latch read `:484` (`!session.accepted.includes`) → `acceptNodeWorktree` `:508` → sidecar write
`recordNodeAcceptOutcome` `:540` → **unconditional `session.accepted.push` `:548`** → claim release
`:554-557`. The only failure path that skips the latch is the `strayWorktreeSuspected` throw
(`:541-547`). Every other failed outcome (`verify` fail, scope block, rebase fail, collision,
merged-base rollback, loop-core-guard rollback, cherry-pick conflict — all return
`{outcome:"error", merged:false}` from `acceptNode.ts`) falls through to the push, and the claim
release then makes even ownership-gated retry impossible. Retry hits `:484` and no-ops.

Test gap: `tests/remediate/host-rolling-dispatch.test.ts:490-500` covers idempotency only for a
*successful* re-accept; no test asserts a failed accept refuses to latch.

Design note for the fix (not just "gate the push"): the session's completion math
(`inFlight = dispatched.length - accepted.length`, `:570`) uses `accepted` as its only terminal
set — an unlatched failed node would hold the directive at `wait` forever. The fix needs a
recorded failed/retryable terminal state the counts and the directive can see, not a bare skip.

## (b) — refuted; no code change owed at HEAD

`baseOid` is captured at `acceptNode.ts:543-561` — *inside* `withFileLock(baseBranchLockPath)`
(`:424`) and *after* `rebaseBranchOntoHead` (`:431`, which folds in any sibling already landed).
Both rollback call sites (`:630`, `:674`) pass exactly this value; `rollbackBaseToOid`
(`:250-308`, extracted by CP-NODE-1 `1e924350` from the previously-inline reset) verifies
post-reset `HEAD === baseOid`. Sweep of every base-branch writer: `ensureRemediationBranchCheckedOut`
(`worktreeLifecycle.ts:661`) is checkout-only; `resetNodeWorktreeAndBranch` (`:157`) touches only the
node's own worktree/branch; `remediation-base-branch.json` records a branch *name* for the opt-in
merge-to-base close action, never a rollback target. `grep 'reset --hard'` across `src/**` yields
only the two `acceptNode.ts` sites.

The live sibling-drop (CP-NODE-1's commit, re-cherry-picked by hand) is therefore attributed to
mixed-version / mixed-lock-path operation during the run's recovery chaos (the run executed the
global-bin dist while landing fixes to this very file; manual state surgery and session rebuilds
were in play), not to a present code path. Optional cheap hardening if it ever recurs:
`rollbackBaseToOid` could refuse when the reset would move HEAD by more than this node's own pick.

## (c) — worktree removal precedes the post-merge gates

Removal is deliberate on every accept exit path (verify fail `:515`, scope `:537`, rebase `:434`,
collision `:452`, ownership `:580`), and `mergeWorktree` (`worktreeLifecycle.ts:294-307`) removes the
worktree on success AND conflict — at `acceptNode.ts:595`, *before* the merged-base check
(`:609-646`) and loop-core guard (`:649-692`). A RED post-merge gate rolls the base back and
quarantines the branch tip, but the worktree is already deregistered and nothing re-creates it. A
fix-forward worker pointed at the path hits the `verifyCwdEscapeDiagnostic` hazard
(`worktreeLifecycle.ts:203-229`): git resolves up to the MAIN checkout. The
`worktreeHoldsUnlandedWork` guard (v0.34.15) is moot here — it fires only when the dir still exists.

Note: the designed recovery for a quarantined node already exists —
`reverifyQuarantinedNode` (`rollingSession.ts:660-777`, shipped `98d36541` 2026-07-04), surfaced as
`remediate-code reverify-node --id <block> --run-id <run>` and named in the merge's friction note
(`marshal.ts:971-987`). It replays the quarantine ref into a *fresh* worktree and re-runs the real
accept lifecycle. Part of the live (c) pain was recovery-path discoverability, but defect (a) also
made `reverify-node`'s finalization path moot (the latch no-ops the re-accept), so (c) and (a)
compound.

## (d) — stale `merged:true` sidecar + no-change closures skip the ancestry reconcile

Two independent halves, both at HEAD:

1. `recordNodeAcceptOutcome` (`acceptNode.ts:744-775`): the monotonic guard `:761`
   (`existing?.merged === true && result.merged === false → return`) exists to stop stale
   out-of-order writes (D-66/67 §8), but it equally refuses the write from a *genuine later failed
   attempt* after any earlier successful one — the sidecar then permanently claims
   `merged:true` + the old `landed_head_oid`.
2. `mergeImplementResultsIntoState` (`marshal.ts`): `acceptHardFailed` (`:948-951`) correctly blocks
   when the sidecar records a hard failure — but a stale `merged:true` sidecar passes it. The
   corrective for a lying sidecar is the ancestry probe (`notLanded` / `ancestryLost`,
   `:1270-1312`) — and it is keyed on `resolvedFindingIds`, which *excludes* no-change closures
   (`:1133-1135`). The `resolved_no_change` clobber checks (`:1060-1095`) require `capturedOid &&
   branchEmpty` or `branchHasEdits`; a no-change item with no captured OID and a removed branch
   passes all of them and is labeled `resolved_no_change` at `:1129` with zero landing
   verification.

Fix seam: extend the ancestry/notLanded reconcile to cover no-change closures (or include
rolled-back no-change nodes in `resolvedFindingIds`), and decide the monotonic guard's correct
scope (it should yield to a write that carries *newer* ground truth, e.g. a later attempt id or an
ancestry-checked landed oid, rather than blanket-preserving `merged:true`).

## Scope & gating

All touched files are loop-core: `src/remediate/steps/dispatch/` matches `LOOP_CORE_PATTERNS`
(`loopCorePaths.ts:40`), `rollingSession.ts` exactly (`:42`). Any fix requires green + independent
review + attestation, and a remediate node editing these files trips the per-node guard
(`acceptNode.ts:657-659`).
