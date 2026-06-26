# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.30.16` on npm (`latest`). `main` == `audit-tools/main`, clean tree, both global bins → 0.30.16.
CI publish run: https://github.com/OhOkThisIsFine/audit-tools/actions/runs/28264441942

**In flight:** an autonomous `/loop` of `/remediate-code docs/backlog.md` (self-paced, one bounded lap at a time → `/ship`
→ reinstall → next lap) is running until forward-tracks + friction settle. Lap 1 landed below. Each lap re-scopes a
bounded foundation at intake (auto-phasing still unshipped) and pauses for a host scope/approval decision.

**Last landed (2026-06-26, shipped in 0.30.16, loop lap 1): accept-node new-file-drop + merged-base-green hardening.**
- `/remediate-code` scoped to the one live Open-bug (accept-node merge silently dropping a worker-created file → red
  base → false-quarantines). Naive 2-mode fix reshaped by **2 source-grounded adversarial repair rounds** (converged at
  a true round-3 fixpoint, within the N=2 cap) into 6 defenses: CE-004 `git ls-files --others --ignored` enumeration;
  CE-003 source-extension-only force-add under write_paths else fail-loud; CE-002 merged-base `npm run check` in the
  MAIN checkout (worktree junction is unfaithful); CE-001/005/CD-201 serialize the base-mutating section under a DISTINCT
  base-branch lock acquired once in `acceptNodeWorktree` (not the non-reentrant per-run `rolling-session.lock`), capture
  base HEAD OID + `reset --hard`/scoped-clean/self-quarantine on a red check. Files: `src/remediate/steps/dispatch.ts` +
  `rollingSession.ts`; tests in `tests/remediate/dispatch-worktree.test.ts`.
- Green on merged `main`: remediate vitest 1944 / 0 fail; full `npm test` exit 0; build + check clean.
- Logged this lap's full contract-pipeline **host-friction inventory** (categories A/B/C/D/E) to `backlog.md`.

**Trap (release gate):** the release script's local pre-tag gate runs only `npm run check`, but CI runs the full
`verify:release` (check + check:doc-manifest + test + verify:hosts + 2 smokes). Run `env -u CLAUDECODE npm run
verify:release` locally **before tagging** to catch doc-manifest / smoke failures `check` alone misses.

**Next (loop continues):**
1. Lap 2 scope (host-picked at intake): a bounded foundation toward the **headline auto-phasing** forward track, or the
   **repair-cap → convergence-termination** track (lap 1 converged within the N=2 cap but a 3rd new CE would have been
   cut — real data point), or another Open-bugs/friction item. See [`backlog.md`](backlog.md).
2. The lap-1 host-friction inventory (A/B/C/D/E in `backlog.md`) is itself fixable-tooling backlog to burn down.

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
