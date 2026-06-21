# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.29.3` on npm (`latest`). `main == origin/main`, clean tree, both bins → 0.29.3.
(Doc-review routine now gated on full `npm test`; A12 host-asset stragglers cleared. 0.29.0/0.29.2 publish-CI
failed on stale host-asset assertions and were republished — npm has 0.29.1 then 0.29.3.)

**In flight:** nothing — clean, verified, fully pushed.

**Next:** pick from [`docs/backlog.md`](backlog.md) — open bugs/frictions, design commitments not yet built,
larger tracks.

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
