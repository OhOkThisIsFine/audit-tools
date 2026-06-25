# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.30.6` on npm (`latest`). `main == audit-tools/main` (remote is `audit-tools`, not
`origin`), clean tree, both bins → 0.30.6.

**In flight:** nothing — clean, verified, fully pushed.

**Next — resume remediate-code on the foundations phase.** Point `/remediate-code` at the
**backlog-remediation foundations** only: O2 append-only-ledger+lock (data-loss fix → **leads**), then O1
friction-capture, then O3 emit-validate-repair-seam (the first three Open-bugs entries in
[`backlog.md`](backlog.md); consumers F1/F3/F4/F5/F6 already shipped). Reference + run-invariants (CE-001…006,
FC-001/002/005; land `captureFrictionEvent` as a no-op first per FC-005):
[`docs/backlog-remediation-design.md`](backlog-remediation-design.md).
- **Do NOT point it at the whole `backlog.md`** — the remediator can't yet mechanically decompose a
  multi-goal input, so it returns blocking over-scoping (see *remediator-must-decompose* in the backlog).
  Feed one bounded phase.
- **Before a fresh run:** clear any stale `.audit-tools/remediation/` state (leftover `state.json` /
  `remediation-report.md`) from the earlier whole-backlog attempt — it can short-circuit or mis-seed the run.

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
