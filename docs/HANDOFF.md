# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Orientation (single-package reality — internalize before touching anything)

ONE package `audit-tools` (A12 collapsed the old 3-package monorepo). `src/{shared,audit,remediate}` →
`dist/{shared,audit,remediate}`; imports use `audit-tools/shared` (self-reference + tsconfig `paths`),
NEVER `@audit-tools/shared`. One `tsconfig.json`, one `npm run build`. Both bins (`audit-code`,
`remediate-code`) from the root package. Tests: node:test `.mjs` (tests/shared, tests/audit) + vitest
(tests/remediate). Plain `vX.Y.Z` release tags; one `publish-package.yml` (OIDC, tokenless).

## Where things stand

- **LIVE on npm = `audit-tools@0.28.10`** (`latest`, release commit `f061f25`, OIDC CI run `27888048799` green);
  `main == origin/main` (docs commits may sit on top of the release tag). Global bins reinstalled + postinstall
  run; both `--version` → 0.28.10.
- **A-8 hybrid program: ✓ COMPLETE — both orchestrators, live-validated, shipped.** BOTH next-steps split the
  eligible frontier host-vs-NIM via the ONE shared `planHybridDispatch` (coordinator claims each node;
  classification injected). Remediate runs the NIM partition in-process + hands the host partition to the
  `accept-node` loop; audit reviews the NIM partition in-process + the host batch-reviews the coverage-driven
  complement. Dispatcher brain fully shared (quota fold, rolling engine, claim registry, A-8 coordinator, split
  layer, generic `DispatchableSource` pools `buildSourcePools`, host-pool core `buildHostModelPools`, DC-4
  settled-pool store). DC-4 cross-cycle pause: an exhausted backend pool settles (shared store) → next cycle
  excludes it → stranded work falls to the host pool. Memory: `a8-hybrid-full-scope`, `dispatchable-sources-generic`.
  - **Live crit-3 e2e both sides ✓** (gated `RUN_NIM_E2E=1`, live NVIDIA NIM):
    `tests/remediate/hybrid-nim-e2e.test.ts` (split a 4-node frontier, NIM fixed B-003 → HEAD, host got 3) +
    `tests/audit/hybrid-nim-audit-e2e.test.mjs` (NIM reviews its partition in-process, host gets the clean
    complement). The audit live e2e caught + fixed **3 real bugs that 0.28.9 shipped** (now fixed in 0.28.10):
    lock ENOENT on a missing parent dir (fixed at the `acquireLock` primitive — mkdir's the lock dir); the NIM
    partition's review results were never ingested (the in-process run now lists the NIM tasks, not the
    complement, so its mergeAndIngest folds them); the host complement was orphaned (the ephemeral NIM run now
    passes `updateDispatch:false` so it doesn't own the dispatch pointer + the host re-derives the complement).
  - **Follow-ups (this sprint, all DONE):** per-node verify runs derived + `targeted_commands` ("run both",
    `task_7d35176d` closed); host-pool-from-roster core unified into shared `buildHostModelPools`.

## Immediate next

The A-8 program is shipped and verified — no blocking work outstanding. Go-forward program of record is
[`docs/backlog.md`](backlog.md). Salient open items there:
- **Ambiguity-step `deemed_inappropriate` fix-in-tooling — OPEN.** The ambiguity step silently DECLINED 5/7
  approved findings in a dogfood run (recovered by hand). A real fix-in-tooling is not yet done. Memory:
  `ambiguity-step-deemed-inappropriate-drops-finding`.
- **Spawned tasks still open:** `task_2092be69` (complete_redelivery stale-report gate).
- **Deliberate test seams (not bugs):** DC-4 injectable `discoverProviders` stub (hermetic default); A-2 real
  scoring needs operator-authored `corpus/<run-id>.labels.json`; gated live e2es skip without creds
  (`RUN_NIM_E2E=1`, INV-2 `AUDIT_TOOLS_LIVE_QUOTA=1`, A-7 `RUN_CODEX_E2E=1`, A-9 `RUN_AUTONOMY_E2E=1`).
- **Redesign-before-scheduled-autonomy (memory):** architecture is now stable + the A-9 autonomy capstone ran
  live — the scheduled audit→remediate→PR loop is the next big build when picked up.

## Working constraints (single-package)
- **Green at every commit:** `npm run build && npm run check` → zero errors. Commit hook enforces it.
- **CLAUDECODE** is set in-session; UNSET it for true-green test/gate runs (`env -u CLAUDECODE …`).
- **Tests:** `npm test` (build + node:test shared+audit + vitest remediate). vitest runs source-mode (no build).
- **verify:release** = check + test + 4 smokes. The smokes pack ONE tarball; Windows-flaky on temp-dir
  EPERM/EBUSY — re-run a smoke before calling it a regression.
- **Release/publish:** `env -u CLAUDECODE npm run release:patch:publish` (bumps + tags `vX.Y.Z` + GitHub Release
  → OIDC CI publishes → waits for npm). Recover a bad attempt: `gh release delete vX.Y.Z --cleanup-tag`,
  forward-bump, retry. Use the `/ship` skill.
