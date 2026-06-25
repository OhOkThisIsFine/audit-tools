# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.30.7` on npm (`latest`). `main == audit-tools/main` (remote is `audit-tools`, not
`origin`), both bins → 0.30.7.

**In flight:** `fix(audit): confirm_intent regression` — committed `20964a4`, not yet pushed or published.

**Last landed (2026-06-25, not yet published): confirm_intent regression fix (two root causes).**
- `promoteFinalAuditReport` deletes `artifactsDir` after promoting. Second `next-step` found empty dir →
  fold replayed → `confirm_intent`. Fix: write `{...state, status:"complete"}` sentinel back to
  `audit_state.json` (recreated by writeJsonFile). Force `status:"complete"` — the `state` arg to
  `buildTerminalStep` may carry `status:"active"` (captured pre-executor).
- `decideAuditFrictionCloseout` called AFTER promotion → friction dir already deleted → returned
  `status:"ready"`. Fix: call friction triage BEFORE promotion in both terminal paths.
- Tests: `nextStepUntilPresentReport` needed `mkdir(dirname(friction_record))` before writing observations.
- Net: fixed 4 tests (3 completion + present_report status). 3 pre-existing failures remain
  (2 narrative, 1 FINDING-018 write_paths).

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

**Next:** push + publish patch bump for the regression fix. Use `/ship`. Then pick up the next forward
track from [`backlog.md`](backlog.md) (mechanical multi-goal decompose + boundary-enforce remediator).

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
