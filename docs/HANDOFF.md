# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.30.11` on npm (`latest`). `main` == `audit-tools/main` (release commit `03b3e43c`), clean
tree, both global bins → 0.30.11. CI publish run: https://github.com/OhOkThisIsFine/audit-tools/releases/tag/v0.30.11

**In flight:** nothing — clean, verified, pushed, published 0.30.11, global bins reinstalled.

**Last landed (2026-06-26, shipped in 0.30.11): forward-tracks foundations-phase (mechanical decompose + boundary-enforce substrate).**
- Ran `/remediate-code` on the backlog Forward tracks, scoped (host intake decision) to the 3 enabling foundations
  (decompose+boundary-enforce / schema-enforced generation / dispatch broker); 4 consumer tracks deferred.
- Full contract pipeline: 5-module decomposition → 6-node dependency DAG → independent critique (2 blockers) +
  counterexample (9 CEs) → judge accepted 6 cheap contract fixes → one repair round closed all 6 → re-review
  **approved**; 3 residuals (CE-002/004/009) acknowledged.
- Shipped code (mostly verify-before-fix; net-new = the 6 CE fixes + classifier struct + guard tests):
  `touched_files` first-class+required on `RemediationBlockSchema`/validator; CE-003 block_id-PREFIX partial
  admission (`admitSubWaveUnderCapacity`); CE-006/007 claim-retaining redispatch (`NodeClaimDisposition`,
  `redispatchInFlight`); CE-008 merge/overlap/byte-size pinned to `canonicalizeFilePath`; CE-005 single-struct
  `classifyProvider` (floor constants de-exported); convergence guard tests locking dispatch through broker+boundary.
- Green on merged `main`: remediate vitest 1919 / 0 fail; audit+shared node:test 3269 / 0 fail; build + check clean.
- **Headline still open:** the tool does not yet AUTO-derive the phase cut — the foundations-only scope was a host
  intake decision, not DAG-derived. See `backlog.md` track #1 "STILL OPEN — the headline auto-phasing".

**Trap (release gate):** the release script's local pre-tag gate runs only `npm run check`, but CI runs the full
`verify:release` (check + check:doc-manifest + test + verify:hosts + 2 smokes). Run `env -u CLAUDECODE npm run
verify:release` locally **before tagging** to catch doc-manifest / smoke failures `check` alone misses.

**Previously shipped (in npm history):** 0.30.10 per-result granular staleness (O3 re-dispatch); 0.30.9
confirm_intent deferred-promotion fix; 0.30.7 rolling-dispatch same-file merge-serialization (file-ownership-disjoint
sub-wave scheduling `INV-SOO-*`, cross-node seam-signature guard `INV-SEAM-*`). Foundations O1/O2/O3 merged `cd089066`.

**Next:**
1. Highest-leverage open forward tracks ([`backlog.md`](backlog.md)): the **headline auto-phasing** of the
   decompose track (tool derives the phase cut, not the host); the **general DAG extension** of granular staleness
   (per-file coverage-matrix elements + incremental `runPlanningExecutor`).
2. Open bug: file-split sibling `idempotency_key` collision (backlog Open bugs).

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
