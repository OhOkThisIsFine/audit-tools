# HANDOFF — audit-tools

> The single rolling cross-machine handoff: current published state + anything in flight. Durable how-to is in
> `CLAUDE.md`; open work in [`docs/backlog.md`](backlog.md).

**Live:** `audit-tools@0.30.18` on npm (`latest`). `main` == `audit-tools/main`, clean tree, both global bins → 0.30.18.
Session shipped 0.30.16 (accept-node hardening) → 0.30.17 (P0 fix for it) → 0.30.18 (loop-friction C1/C4/D2/C5, lean).

**In flight:** an autonomous `/loop` of `/remediate-code docs/backlog.md` (self-paced, one bounded lap at a time → `/ship`
→ reinstall → next lap) is running until forward-tracks + friction settle. **Lap 2 surfaced a P0 regression in lap-1's
own 0.30.16 fix** (over-broad new-file enumeration tripping a fail-loud on incidental `node_modules` churn → rejected
all 4 lap-2 nodes + dropped their verified edits). P0 hotfix landing in 0.30.17 (enumeration scoped to under-write_paths;
incidental out-of-scope ignored churn skipped, not fail-loud). The 4 lap-2 friction fixes (C1/C4/D2/C5) were lost and
re-run as **lap 2b** through the fixed tool. Each lap re-scopes a bounded foundation at intake (auto-phasing unshipped)
and pauses for a host scope/approval decision.

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

**Loop cadence (Ethan, 2026-06-26): "keep looping but cheaper" — risk-tier each lap.** Full adversarial contract
pipeline ONLY for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
gate → ship), skipping the ~40-step ceremony. See project memory [[risk-tier-loop-laps-cheap-vs-heavy]] +
[[log-all-friction-categories-every-lap]].

**Lap 3 RESOLVED to a design, not code (2026-06-26).** The full pipeline (correctly, for a risky change) caught two
blocking design gaps (circularity in the routing signal; a document→Finding synthesis seam) that, with Ethan, reframed
the whole item: make-the-loop-cheaper is NOT a separate document lean path but a **self-scaling pipeline** — design of
record in [`self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md). The lap-3 contract-pipeline run
on disk (`.audit-tools/remediation`) is now **OBSOLETE (its design was the superseded lean-path framing)** — do NOT
resume it; the next `/remediate-code` will resume it as a stale run, so close/ignore it (or reset the remediation state)
before starting fresh, per the stale-pipeline-state friction in `backlog.md`.

**Next (loop continues, run lean unless risky):**
1. **Implement the self-scaling pipeline** ([`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md))
   — lowest-risk slice first: degenerate-phase collapse (pure architecture, no risk signal). Then the shared intake risk
   signal, the adversarial-depth dial (+ soften the audit skip-path to light review), the granularity dial. Highest
   leverage — makes every future lap cheaper.
2. Remaining host-friction inventory items (A1-A3 ambiguous-direction, B1-B5 tool-should-decide, C2-C4, D1) in `backlog.md`.
3. P0 follow-up: data-loss on a GENUINE fail-loud (quarantine worker edits before dropping the worktree).
4. Forward tracks (run the risky ones — auto-phasing, granular-staleness DAG — through the FULL pipeline).

**Release:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release → OIDC
CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`, forward-bump,
retry. Use the `/ship` skill. Run gate/test commands with `env -u CLAUDECODE` (set in-session → one audit-code
provider test fails otherwise).
