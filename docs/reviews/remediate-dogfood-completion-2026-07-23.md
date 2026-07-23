# Remediate dogfood — completion record (2026-07-23)

The `high-severity-self-audit-2026-07-22` run RESUMED after the v0.34.13 cluster fix and ran to an
honest completion: **8/8 nodes resolved**, all work landed on the remediation branch and merged to
main (`a663bac6`, released v0.34.16). Full merged-tree suite: 7,076 passed / 0 failed. This record
carries the resume's friction — five NEW defects were found live, three fixed same-session
(v0.34.14, v0.34.15, and the in-run fixes), two specced in the backlog. The run's own deliverables
are `.audit-tools/remediation-report.md` / `remediation-outcomes.json`; the original wall's
mechanism record is `implement-dispatch-cluster-mechanisms-2026-07-22.md`.

## What the resume validated (the v0.34.13 cluster, live)

- Handshake persisted at the decideNextStep seam: `state.host_capabilities` populated on the triage
  re-drive; capability resolved `claude-fable-5`/200k (was 32k/`model: null`).
- The wall node CP-BLOCK-CP-NODE-7 admitted (152.6k vs 200k) and completed.
- Honest structural pause: fired once live (`quota_paused`, fit-mismatch message) instead of a
  triage spin — and its firing is what exposed the slot-cost defect below.
- Transient-vs-structural retry: CP-NODE-8's `cap_reached` refusal left it PENDING
  (`undispatched_attempts: 1`) and it admitted cleanly on the next grant. No false-block.
- Refusal-carrying dispositions: not exercised (no structural refusals after v0.34.14).

## New defects found by the resume

1. **Agentic slot-cost model (FIXED, v0.34.14).** `estimateImplementSlotTokens` priced the access
   set as inlined content: CP-NODE-1's 182 referencing tests → 943k "cost" for a 14.5KB prompt →
   `no_capable_pool` against every window. Agentic model now: prompt + largest file + manifest
   overhead (127.6k → admitted).
2. **Worktree wipe on re-prepare (FIXED, v0.34.15).** `createNodeWorktree` reset unconditionally;
   a session-rebuild re-prepare destroyed CP-NODE-1's completed-but-uncommitted first
   implementation (~1 worker-hour lost). `worktreeHoldsUnlandedWork` guard: uncommitted edits or
   ahead-of-base commits → loud reuse, never reset. (Empirical detour: `rev-list --not
   --branches=main` counts 1 on a clean repo; replaced with explicit `^HEAD` exclusion.)
3. **Shared-state clobber from node context (OPEN, backlog HIGH).** Twice, mid-worker activity
   rewrote the real run state (`rolling-session.json` emptied; later a false all-blocked
   `complete` close that promoted premature deliverables and burned the final-gate coarse
   re-block). Contained by prompt bans + the wipe guard; the mechanical fix (refuse state-mutating
   CLIs from a node-worktree CWD / owner-token the session writers) is specced in backlog.
4. **Accept-latch + rollback family (OPEN, backlog).** (a) A failed accept latches the node as
   "accepted" in the rolling session, so a retry accept is an idempotent no-op — the fix-forward
   path has to land from the quarantine ref by hand. (b) The failed-accept rollback restored the
   branch to the session-recorded base, silently dropping a SIBLING's landed commit (CP-NODE-1's,
   re-cherry-picked). (c) The rollback also deregistered/emptied the node's worktree (post-guard
   this preserves un-landed work, but the deregistration still surprises the fix-forward worker).
   (d) A rolled-back node was mislabeled `resolved_no_change` by the subsequent merge (false-signal
   family).
5. **Build-free accept false-reds dist-importing verify commands (OPEN, backlog).** Three accepts
   in a row failed verify solely on suites that import/spawn `dist/` (linux-cycle-regression,
   config-error-handling, next-step wrapper e2es). The accept gate is build-free BY DESIGN
   (CE-001); a targeted command that needs `dist/` false-reds there deterministically. Each was
   validated by rebuild + rerun green, then landed from quarantine. Fix direction: verify-command
   admission should refuse (or build-first) dist-dependent commands at plan time, not fail the
   accept at run time.

## Driver-side protocol that worked (recovery recipes)

- **Quarantine land:** cherry-pick the quarantine ref → build → rerun exactly the failing suites →
  green ⇒ repair the accept sidecar (`merged:true` + landed oid) → tool merge → advance.
- **Session clobber:** park result file → triage-retry the node → next-step rebuilds
  session/frontier → restore result → accept. State surgery only from ground truth (accept
  sidecars + branch commits), never from memory.
- **Post-merge gate fix-forward:** hand the worker the exact gate failures; worker amends in its
  worktree + declares out-of-scope files via `amended_files`; driver lands both commits.

## Meta

Worker-prompt rules accreted during the run (each after a live failure): no whole-dir sweeps; no
`remediate-code`/`audit-code` CLIs against the shared artifacts dir; register new id families in
the glossary + declare via `amended_files`; flag dist-importing verify commands. All four belong in
the TOOL's worker-prompt template, not the driver's memory (enforce-in-tooling; backlog).
