# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate

Most open items below are **code-complete and only await a real run to confirm**. Each such item
carries a **⬇ Live-run watch** line: exactly what to observe during the run to confirm it validated —
or to catch it failing. Pick a run config from this matrix; watch the items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit, any provider | Selective-deepening convergence · knip `files`/`dependencies` dead-code leads |
| **Metered provider + LARGE target**, ideally `AUDIT_TOOLS_LIVE_QUOTA=1` (forces the wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
| **Codex backend** (`--provider codex`; Codex CLI is a nested-agent host) | Y-dispatcher driver selection · cross-provider quota (Codex live endpoint) |
| **openai-compatible / NIM backend** (`RUN_NIM_E2E=1` for the gated e2e) | openai-compatible dispatch pool · CE-004 emit-time-constraint build opportunity |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a *crash*
(not a graceful pause) when a rate limit is hit · an analyzer that silently skipped when it should have
spawned · knip dead-code leads that never reach the per-file lens. After a run, its findings are the
corpus to hand-label for the A2 oracle (see Deferred / waiting).

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **Two laps grabbed the same backlog item concurrently → duplicated whole-item work (tool-should-decide, 2026-07-07).**
  Two independent sessions each fast-forwarded at lap start, both read the same HANDOFF "immediate next" (A1 rename),
  and both did the full rename in parallel. One shipped v0.32.33; the other's identical commit was rejected on push
  (behind remote) and discarded — a full rename's worth of wasted work. `start-lap` fast-forwards *once* at open but
  there is no lap-level claim on "who owns which backlog item", so nothing prevents the collision mid-lap. This is the
  concrete manifestation of the cooperative-runs gap ([[multi-ide-concurrent-runs-design]] task-claiming): a lap
  should stake a claim on the item it starts (reuse the ClaimRegistry / step-slot design) so a second lap sees it
  taken and picks the next one. Salvage from the collision: the loser's sweep caught a stale comment the winner's
  rename missed — landed as a follow-up chore.

- **A test can drive a deleted code path through a module-namespace spy and pass vacuously (tool-should-decide).**
  Two `tests/remediate/wave-scheduler.test.ts` tests drove the quota-read failure path via
  `vi.spyOn(quotaModule, "readQuotaState")` on a *re-export*. When the source switched to an internal call, the spy
  stopped intercepting: one test failed loudly (good), but the sibling **negative** contract (CP-NODE-52,
  "the rejection does not throw") kept passing while never executing the failure path. A green negative test that
  exercises nothing is worse than no test. Both now drive a real corrupt `quota-state.json`. Generalizable guard:
  a lint/test-invariant that flags `vi.spyOn(<module namespace>, …)` on a re-export barrel — the failure mode is
  silent and survives the very refactor the test exists to protect. Related: [[worktree-tests-miss-integration-guards]].

- **THREE adversarial reviews in a row found a defect the author's own green suite missed (ambiguous-direction).**
  INV-QD-15's first cut left `tests/remediate/wave-scheduler.test.ts` RED and would have shipped; the bucket
  deletion's first cut promoted a latent `success`-clears-live-cooldown bug (INV-QD-16) to the sole failure mode;
  and the v0.32.31 bug-(4) fix's first cut DROPPED the `pool.quotaStateEntry` snapshot entirely (green suite +
  the new regression all passed), but an independent reviewer showed the snapshot is load-bearing in the
  transient-read window — a prior-run cooldown would be lost to proactive spill on a Windows EBUSY read flake.
  Corrected to `live ?? snapshot` order (keep the fallback). All three caught only by an independent reviewer agent,
  never the author pass. This is [[delegate-adversarial-phases-to-separate-agent]] earning its keep — but it is
  still a *host habit*, not a tool obligation. The remediate contract pipeline already runs adversarial rounds;
  the same gate should exist for hand-authored (non-node) changes to loop-core modules. A related, generalizable
  cause on the bug-(4) case: the backlog item stated the *fix-mechanism* ("prefer live") but not the *invariant*
  (don't lose a prior-run cooldown to a transient IO flake), so the mechanism read as "drop the snapshot" — the
  [[backlog-item-states-invariant-not-fix-mechanism]] failure mode, in the wild.

- **Remediate does no session-config field validation — parity gap (tool-should-decide, from C1 review).** The
  full field validator `validateSessionConfig` (`src/audit/validation/sessionConfig.ts`) runs ONLY on the audit
  orchestrator (`src/audit/supervisor/sessionConfig.ts`); remediate loads `session-config.json` and feeds it
  straight to the SHARED scheduler with no field checks. C1 closed the *correctness* half in the shared consumer
  (`resolveContextBudget` floors at 0; the discovered rung drops an inverted window), so a bad quota can no longer
  wedge either orchestrator — but a remediate operator gets no loud config-load error for a malformed
  `quota`/`sources[]`, just a silent degrade to the floor. "Keep orchestrators in parity" says both should reject
  bad config at load. Fix: route remediate's config load through the same validator (or single-source the
  field-validation into `audit-tools/shared` and call it from both). [[enforce-robustness-in-tooling-not-host-discretion]]

- **Session-config RMW helpers are unlocked (B1 review finding #4, minor).** `persistHostProvider` and the
  pre-existing `persistAnalyzerSettings` (`src/audit/supervisor/sessionConfig.ts`) do read→merge→validate→
  `writeJsonFile` with no `withFileLock`. `writeJsonFile` is atomic per-write (no torn file), but two concurrent
  writers can interleave read↔write → last-writer-wins lost update of the other's field. `persistHostProvider` is
  now idempotent (skips the write when unchanged), which shrinks but doesn't close the window. Harden BOTH helpers
  with the shared `withFileLock` on the multi-IDE cooperative path. [[multi-ide-concurrent-runs]]

- **Console-window popups on win32 — ✅ RESOLVED 2026-07-07. The "test-suite spawns" claim was FALSE.**
  Established by controlled probe (a SessionStart hook running `node -e "process.exit(0)"`, all else disabled →
  **zero** windows), so: the harness spawns hook TOP-LEVELS windowless; a console CHILD of a hook pops unless that
  spawn passes `windowsHide: true` (which DOES cover its whole subtree); and **Bash-tool children never pop at any
  depth** — `npm run check` (npm → node → tsc) is silent, because the Bash tool's shell owns a real console. The
  test suite and vitest's worker pool were therefore never involved; that line in this backlog sent three
  investigations down the wrong path. Actual causes, all fixed:
  (1) `.claude/hooks/` `async-typecheck.mjs` + `pre-commit-gate.mjs` unguarded child spawns — FIXED 332301a9.
  (2) Two **INV-WH guard holes** — the script check hardcoded two filenames (so `scripts/check-doc-manifest.mjs`,
  which runs inside `verify:checks`, and `scripts/remediate/smoke-linked-remediate-code.mjs` spawned unhidden), and
  its import regex matched only `"node:child_process"` (so the two smoke scripts importing bare `"child_process"`
  were never scanned at all). The guard now WALKS `scripts/**/*.mjs` and accepts `(?:node:)?child_process`; verified
  red-green. Also `.claude/hooks/doc-review-surface.mjs` (`git fetch` at SessionStart) and the
  `{ windowsHide: true, ...options }` clobber in `smoke-packaged-remediate-code.mjs`. — FIXED 33bd78c7.
  (3) **The flood itself was a SYMPTOM, not a spawn bug.** The headroom proxy WEDGED (alive, holding :8787, serving
  nothing) and its VBS supervisor watched for *exit*, so it never restarted. The headroom plugin's
  `PreToolUse(Bash|PowerShell)` `headroom init hook ensure` then tried to respawn it before every shell tool call;
  each attempt hung at pre-load, blew the hook's 15s timeout, and popped a console on the way out. Fixed OUTSIDE this
  repo with a `/readyz`-health-checked supervisor (verified by `NtSuspendProcess` fault injection).
  See [[headroom-proxy-wedge-and-supervision]] / [[hook-spawns-must-be-windowless]].
  **Standing rule:** any hook or test helper that spawns a subprocess must pass `windowsHide: true`, and
  `{ windowsHide: true, ...options }` is a bug — spread options FIRST, force the flag LAST.


- **Meta-frictions from the v0.32.27 code-fixable sweep (fix in tooling).** Four tool gaps surfaced driving +
  recovering that run (full detail in its friction record `.audit-tools/remediation/friction/backlog-code-fixable-sweep-2026-07-06.json`):
  - **Convergence guard keys on the reviewer-supplied counterexample *id string*, not CE content.** Two independent
    adversarial rounds each labeled their (genuinely distinct) top CE `CE-001`, so the judge↔repair loop read "same CE
    re-accepted after a repair" and raised a FALSE non-convergence block that escalated to a user decision — while a
    real, new, accepted defect was being correctly repaired. Fix: key convergence detection on a CE content /
    violated-obligation fingerprint, or auto-mint unique CE ids; never trust the reviewer's free-text id.
  - **Test-plan re-derive doesn't apply the empty-delta copy-forward.** The shipped B1 incremental re-convergence
    (CP-NODE-2) covers contract artifacts, but a `test_validator_plan` re-derive still presents an ALL-empty skeleton
    even though `test-plan-carry.json` holds the prior assertions and ~118/128 specs are byte-identical carries — the
    host had to script the carry every round. Extend the copy-forward (auto-carry unchanged specs by obligation_id;
    blank only specs whose obligation text changed) to the test plan.
  - **Drafting-prompt vs finalized-artifact schema disagree on `inputs`/`outputs` shape.** The per-module
    contract-drafting prompt lets drafters author `inputs`/`outputs` as objects, but the `finalized_module_contracts`
    validator requires `string[]`; the finalize step carries the objects through → validate-artifact rejects them.
    Single-source the shape (coerce/normalize at finalize, or constrain the drafting schema).
  - **Cross-file contract/invariant regressions escape node-local verify and surface only at ship-time CI.** Per-node
    implement workers verify their OWN targeted tests but don't run the repo-wide guards their refactors break
    (id-glossary INV-family registry, INV-WH raw-spawn, release-contract source-shape, drain-lifecycle analyzer-cache
    coupling) — four such breaks were caught one-CI-cycle-at-a-time across 3 failed publishes. The implement/verify
    (or accept-node) step should run the repo-wide contract/invariant guard suite against the merged tree, not just
    node-local tests. Extends [[worktree-tests-miss-integration-guards]].

- **NIM/Codex dispatch fix set — from a real run + adversarial review (2026-07-07).** `audit-code` in a Codex
  host against an external repo, NIM (openai-compatible) backend, Claude quota exhausted → a 13-issue cascade.
  Investigated + adversarially reviewed: the "host-proposes/broker-disposes" replan was **refuted** (`admitBatch`
  IS the cost-first router — can't "keep the chokepoint, delete the router"; a veto broker regresses *liveness*;
  host identity is a quota-**attribution** key, so moving it to host discretion violates
  [[enforce-robustness-in-tooling-not-host-discretion]]) → corrected to **tool-proposes / host-overrides**. Root
  cause is **mode-dependent**: headless → NIM keyed to its own pool, halt = every packet erroring tripping the
  no-progress guard; attended (`--host-can-dispatch-subagents`) → the complement review routes to the host pool
  mis-keyed `claude-code` (exhausted). Full root-cause + decided direction + file:lines in
  [[host-provider-misattribution-nim-codex]]. Fixes to build, in ship order:
  - **Lean halt fix — ✅ SHIPPED (v0.32.28, headless erroring-packets):** (C2) tolerant `openai-compatible`
    `result` parse — relays a bare result array/object at the top level when the `{files,result}` wrapper is
    absent (schema-gated downstream; bare primitives/null rejected); (C4) bounded fetch retry+backoff on transient
    failures (5xx/429/524/timeout/reject); (C3-floor) per-pool concurrency cap `source.quota.max_concurrent` →
    `CapacityPool.concurrencyCap` → rolling-engine in-flight ceiling AND host-path `declaredCap` (NIM source pools
    were built `hostConcurrencyLimit:null` so the cap was skipped → the 33/32 overrun; a ≤0 cap clamps to
    null-uncapped, never a 0-admit wedge); (D1) bounded no-progress retry (`driveWithNoProgressRetry`, backoff +
    `maxTotalMs` budget so an all-timeout pass spawns no extra passes) so a transient all-error pass self-heals
    instead of halting; (D2) `ingest-results --results` recovery path named in the blocked handoff. Landed through
    a full adversarial review pass (one clamp blocker + primitive-reject + retry-budget minors folded in).
  - **Host-identity sourcing (attended-mode wall) — ✅ SHIPPED (v0.32.29).** NEW single-sourced
    `resolveConversationHostProvider` (`providerPathGuard.ts`): explicit `--host-provider` →
    `sessionConfig.host_provider` → `isSelfSpawnBlocked("codex")`→codex → CLAUDECODE→claude-code → default. All
    3 demote/in-process host-key sites route through it; `--host-provider` override + `host_provider` config
    field wired both orchestrators (audit persists to session-config before load; remediate folds onto
    sessionConfigImpl). Full adversarial pipeline caught 1 MAJOR: the codex-host + `provider:codex`-inside-codex
    case double-booked ONE codex account (host pool + demoted-source pool both `codex/*`) — fixed by NEW
    `shouldDemotePrimaryInProcess` same-agent guard (demote only when `conversationHost !== provider`; else host
    self-drives as one pool). [[capability-is-per-auditor-not-per-audit]] / [[host-provider-misattribution-nim-codex]]
  - **C3 AIMD adaptive ceiling — ❌ CLOSED, NOT NEEDED (the owner, 2026-07-07). Do not re-propose.** Built, reviewed
    by three independent adversarial reviewers, and reverted. The premise was a category error: it tried to *learn a
    concurrency number from a rate-limit signal*. **Concurrency is either DECLARED by the provider or ABSENT — it is
    never learned.** Two cases, no third: (1) a provider states a hard in-flight cap (Codex 6, a NIM endpoint's
    `max_num_seqs`) → pass it through verbatim, which is the already-shipped `source.quota.max_concurrent` →
    `declaredCap` floor; (2) no hard cap → concurrency is not a meaningful quantity, and quota headroom + rate limits
    are the only throttle. If such an endpoint pushes back, that is a 429 → the reactive path (`cooldown_until`,
    `consecutive_429_count`, backoff) handles it. `spec/audit/dispatch-admission-control.md:243` ("never a value the
    tool computes") was correct as written and should have killed this design before it was built. The reviewers also
    showed the implementation stranded every packet under its own target condition (a burst of concurrent 429s applies
    one multiplicative decrease *per victim*, flooring the ceiling and exhausting the pool) and defeated the DC-4
    livelock guard. See [[concurrency-is-declared-or-absent-never-learned]].
  - **C1 real source-pool budget — ✅ SHIPPED.** `openai_compatible` gained a `quota?: QuotaModelLimits` field
    copied onto the folded/demoted source → reaches `buildSourcePool` `discoveredLimits`/`concurrencyCap` off the
    default floor, converged onto the `sources[].quota` shape; the shared `resolveContextBudget` floors at 0 and the
    `discovered_capability` rung drops an inverted `output ≥ context` reservation (holds on BOTH orchestrators);
    operator quota validated at config load. Residual (deferred, unchanged): the `/models` capability probe is a
    build lever ONLY after live-validating NIM exposes `context_length`/`max_model_len`, and MUST sanity-clamp
    before feeding the discovered rung (a too-large probe over-admits). [[openai-compatible-provider]]
  - **A1 rename `local-subprocess` → `worker-command` + gloss — ✅ SHIPPED.** Provider identity renamed across
    the name const (`WORKER_COMMAND_PROVIDER_NAME`), class (`WorkerCommandProvider` in
    `workerCommandProvider.ts`), `PROVIDER_NAMES` / `DISPATCHABLE_SOURCE_PROVIDERS`, factory, examples
    (`examples/session-config/worker-command.json`), and operator guide; gloss "runs `task.worker_command`;
    generic subprocess fallback, not an LLM backend" added at the const + operator-guide provider list.
    Sole-consumer, no back-compat shim (kebab string, PascalCase, camelCase import paths, and the message
    string all converged).
  B2 (host override at Gate-0) + the cost↔speed dial + free-pool max are the forward-track evolution of this —
  see *Forward tracks*. Issue 13 (Codex session usage/approval limit) = env, not ours.

- **Pipeline profiling is now standing (2026-07-06).** Always-on timing across test + release/publish,
  single-sourced in `scripts/shared/profile.mjs`; ledgers land in `.audit-tools-profile/` (gitignored) +
  a CI job-summary table. `verify:checks` runs its sub-steps through `scripts/shared/profile-run.mjs`;
  `scripts/shared/vitest-timing-reporter.mjs` is wired into `vitest.config.ts`; `release-and-publish.mjs`
  writes a `release` phase profile + a `publish-ci` per-job/per-step profile from the publish run's API.
  Use the `*-history.ndjson` trend line to catch time regressions. Durable how-to in `CLAUDE.md` →
  Release & publish → Pipeline profiling.

- **Top gate optimization lead (measured 2026-07-06, was the "vitest collect" item).** First profiled
  numbers (win32, Node 26 local; CI Linux will differ but the shape holds):
  - **`verify:checks` gate = 95.8s, of which `smoke:packaged-audit-code` alone is 70.2s (73%).**
    `smoke:packaged-remediate-code` is 13.2s; everything else is ~12s combined. **→ The highest-leverage gate
    win is the packaged-audit-code smoke.** Internal breakdown (measured): `next-step ×~7 to dispatch_review`
    = 35.9s (53% — the real audit-flow round-trips, inherent coverage), `npm install from tarball` 9.3s,
    `next-step to present_report` 10.1s, `npm pack` 7.2s (incl. a prepack rebuild). The next-step round-trips
    are fresh-process pipeline runs — cutting them cuts coverage, so this needs a real design (e.g. an
    in-process multi-step driver for the smoke, or packing once and sharing the tarball across both smokes
    since they build the identical `audit-tools` package), not a quick trim.
  - **Easy wins SHIPPED 2026-07-06:** (1) dropped the redundant `check` (`tsc --noEmit`) from `verify:checks`
    — `build` (tsc emit) type-checks identically, so it was a second full compile; gate 95.8s→90.8s local.
    (2) dropped the `Type-check` step from `audit-code-test-suite.yml` (its `Build` step covers it) — a `tsc`
    saved in each of 8 matrix jobs per push. (3) added the `release: vX.Y.Z` skip guard to
    `audit-code-test-suite.yml` (mirrors `ci.yml`) — the version-bump push no longer re-runs the 8-job suite
    (publish-package.yml runs the authoritative sharded suite for the release). `check` remains a standalone
    script (commit hook, local pre-tag gate, dev typecheck).
  - **Full vitest suite = 307s wall (452 files), `collect≈211s`** (confirms the old ~186s estimate), run
    time dominated by audit integration tests that spawn real subprocesses: `audit-code-completion` 285s,
    `audit-code-wrapper` 237s, `next-step` 165s, `cli-remediation` 111s. area:audit ≈ 1905s summed across
    workers vs remediate 451s / shared 62s. `pool: 'threads'` / `isolate: false` won't help the run-time
    tail (it's subprocess wall, not isolation overhead); the real lever is the sharding already shipped +
    possibly splitting the few 100s+ integration files across more shards. Only pursue collect/pool changes
    with per-file verification (many tests mutate fs / spawn subprocesses → isolation-off risks bleed).

- **Dispatch admission-control rework — residual (env-bound / deeper, not blocking).** Shipped in full
  (commits 1/2a/2b-AUDIT/2b-REMEDIATE/driver-unification/commit-3/defect-1 — see `docs/HANDOFF.md` T5-3 /
  `git log` for what landed). Design of record
  [`spec/audit/dispatch-admission-control.md`](spec/audit/dispatch-admission-control.md);
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]].
  - (a) **live validation** of the real host+codex+NIM concurrent run — a metered multi-pool run confirming
    the demoted backend actually fans out alongside the host (folds into the quota-aware-dispatch live-run
    watch below). (b) **Deeper simultaneity:** the audit hybrid path drives the in-process (codex/NIM)
    partition to completion within a `next-step` turn, THEN hands the complement to the host — so host and
    backend alternate ACROSS turns, not simultaneously WITHIN one. True within-turn simultaneity would need
    a detached background driver spanning host turns (architectural; only pursue if wall-clock on a real
    run shows the alternation is the bottleneck).

- **Quota-aware dispatch — live validation env-bound.** Still open: live validation of the token-budget
  dispatch gate (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees) on a real rate-limited
  multi-worker run — cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].
  - **⬇ Live-run watch** (metered provider + large target; `AUDIT_TOOLS_LIVE_QUOTA=1` to force it): at the
    rate wall the run must **pause gracefully, not crash**, and leave every in-flight worktree intact; on
    resume it continues from the pause with no lost/redone work. Early on, the tokens-per-percent slope
    should *learn* (dispatch pacing adjusts after the first window reading) rather than stay at the
    cold-start default. FAIL = crash/stall at the wall, discarded worktrees, or a resume that re-does or
    drops packets.

- **Friction detection — M-QUOTA escalation chain: live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is unit-tested end-to-end on both
  drivers (`tests/shared/rollingDispatch.test.mjs`; `tests/audit/rolling-audit-dispatch.test.mjs` §5).
  **Still open:** live validation on a real rate-limited run. [[meta-audit-friction-must-be-tool-enforced]]
  - **⬇ Live-run watch** (same wall run as quota-aware dispatch): when a packet escalates across pools at
    the wall, a **`quota_escalation` friction event** must be captured at the step boundary — check the
    run's friction log / meta-audit surface after the run and confirm the event is present with the
    escalated packet id. FAIL = wall hit but no friction event recorded (the chain didn't fire live).

- **Selective-deepening convergence — live validation env-bound.** Both known convergence loops
  (packet-result `task_id` mismatch; idempotency_key collision across rounds) have shipped fixes and need
  a real deepening-capable run to confirm. Recovery until validated: quarantine orphan pending
  `deepening:*` tasks.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, quarantine the orphan `deepening:*` tasks and note the round count here.

## Forward tracks

- **Free/cheap multi-account "quota-arbitrage" dispatch tier (9router-inspired) — exploration → build.**
  Fan dispatch across genuinely-free backends + (later) N captured subscription-OAuth accounts, rotating on
  429/cooldown to exceed any single subscription's limit. Key finding: this is **extra SOURCE POOLS on our
  existing machinery, not a new provider engine** — pool identity is already `(provider, account[, model])`,
  the admission loop (`admitBatch` cost-first + spill) already IS the rotation engine, the `ReservationLedger`
  already does per-key backoff, and Claude/Codex/Copilot arbitrage accounts get live per-account quota for free
  via `BaseHttpQuotaSource`. Worker shape ≈ `OpenAiCompatibleProvider` (thin `buildHeaders`/`buildUrl` subclass)
  except Kiro (AWS EventStream) + Cursor (protobuf). **Reuse (vendor+sync, MIT):** 9router's provider OAuth
  catalogue (`PROVIDER_OAUTH` + token-refresh endpoints/client_ids) — the someone-else-maintained table the
  corrected sourcing rule prefers; `ERROR_RULES` text classes. **Novel build:** a multi-account credential store
  + refresh-under-lock (encrypted, rotation-loss-safe) generalizing `ClaudeOAuthQuotaSource`. **Risks:**
  ToS/paid-account-ban (impersonating official CLIs — Claude/Codex/Cursor highest; opt-in, never default-on);
  token-security surface (multi-account refresh tokens; encrypted/never-logged/atomic — recall the Antigravity
  leak). **Phase 0 first slice (recommended, ~zero ban/security risk):** `opencode-free` (`Bearer public`) +
  `vertex-trial` (operator's own GCP $300 SA) as free source pools reusing `OpenAiCompatibleProvider` → priced
  ~0 by `deriveCostRank`, routed first, spill already handled. Then Phase 1 multi-account OAuth store
  (Claude/Codex/Copilot). Design of record + full phased plan in memory [[arbitrage-dispatch-tier-design]];
  a coverage diff (2026-07-07) confirmed 9router's price table adds nothing over models.dev, so skip it.
  Relates [[quota-dispatch-vision]] / [[dispatch-admission-control-design]] / [[cross-provider-quota-matrix]] /
  [[openai-compatible-provider]] / [[model-provider-ide-agnostic]].
- **Cost↔speed dispatch dial + free-pool maximization (owner, 2026-07-07).** Generalizes the cost-first router
  — which is the minimum-cost corner of a cost-vs-throughput Pareto frontier — into a tunable operating point;
  lands ON TOP of the kept router, does not replace it. Run through the same adversarial pass as the routing
  work before committing. Full design in [[host-provider-misattribution-nim-codex]] (forward-track section);
  extends [[cost-first-routing-design]].
  - **The dial (decided: cost ↔ throughput/speed, capability as a hard FLOOR).** Pool = (price $/Mtok, effective
    Mtok/s [rate ∧ concurrency ∧ speed], capability). Capability floor = the existing `capable()` filter
    (mechanical, per task/lens — a too-weak pool can't take a task at any price). Dial = operating point on the
    discrete/enumerable frontier among capable pools; λ=0 = today's cheapest-fill (so the current router is the
    corner, not a thing replaced). Set once at Gate-0 as durable POLICY; the router realizes it against the LIVE
    frontier (drifts under AIMD/contention) — same static-policy/dynamic-execution split as B2. UI: 1D slider MVP
    → 2D frontier plot (achievable curve, dominated region greyed) later. It's judgment/policy and low-dimensional
    → safe to expose, and dodges the per-packet menu's context-tax + livelock the review killed.
  - **B2 (near-term seed, the crude form of the dial):** keep the cost-first router as the default proposal
    (liveness guaranteed for weak/headless hosts); the host reorders/excludes pools once at Gate-0 (reuse the
    shipped interactive `provider_confirmation`), the router honors it live, falls through on a drained preferred
    pool, and keeps `ClaimRegistry` claim-before-assign for concurrent-IDE safety.
  - **Free-pool maximization (dial-independent).** Price-0 pools are first-fill at every operating point → free
    is saturated before any paid pool, automatically — a property of the frontier, not a new mechanism (precondition:
    each free source is registered as a price-0 pool). "Maxed" = saturated to LIVE sustainable throughput (AIMD
    ceiling + `declaredCap` floor), NOT flooded — the incident WAS naive free-flood, so safe free-max **depends on
    C3** (see Open bugs). Gated by the capability floor; $0 pools tie-broken by capability then speed (run in
    parallel, each to its own ceiling). Real work = **register every free source as a pool** (NIM, opencode-free,
    kilo, vertex-trial, multi-account) = the arbitrage-tier track [[arbitrage-dispatch-tier-design]] (Phase 0
    zero-ban-risk free first, Phase 1 multi-account OAuth).
  - **OPEN (owner calls):** (a) whether QUALITY also becomes tradeable vs cost (a true 2D dial, needs a per-task
    quality-worth weighting) — default recorded = 1D cost↔speed + capability floor; (b) **free ban-risk boundary**
    — "max free" = ALL free incl. ban-risk arbitrage sources, or zero-ban-risk-only by default with riskier ones
    opt-in? Undecided pending a written explainer of what's actually risky (multi-account / aggregator ToS-ban
    exposure, token security) before the owner lands it.

- **models.dev static window can over-state a specific deployment (carried from W1).** The snapshot lists e.g.
  `claude-opus-4-7` at 1M context; a real headless run serving a 200k variant with discovery absent would over-size
  work blocks off the static rung. Mitigated by `BLOCK_SAFETY_MARGIN` 0.7 + discovered-capability always overriding —
  watch on a real headless metered run.
- **Minor provider/dispatch cleanups (low-pri, bundle opportunistically).**
  ~~providerFactory Rule 6 (`hasClaudeCodeConfig && claudeAvailable`) is a provable strict subset of Rule 9
  (`claudeAvailable`) — delete the redundant rung~~ — **FALSIFIED 2026-07-05 (verify-before-implementing).**
  Not a no-op: the opencode/codex *config-gated* rungs sit BETWEEN Rule 6 (claude config-gated) and Rule 9
  (claude bare-availability tie-break) and resolve to *different* providers. For a dual-configured operator
  (`hasClaudeCodeConfig && claudeAvailable && hasOpenCodeConfig && opencodeAvailable`), Rule 6 makes explicit
  claude config win; deleting it lets the opencode config-gated rung fire first → resolution flips
  claude-code→opencode. Rule 6 is a predicate-subset of Rule 9 but NOT redundant in the ordered table. Leave it.
  Remaining (still valid): inline `makeProviderKeyedFactory` (19 LOC, 2 sites — but it's a cross-area generic
  with its own dedicated test `tests/shared/provider-keyed-factory.test.mjs`; inlining loses cohesion,
  marginal — low value).
  Do NOT delete working proactive quota sources (`BaseHttpQuotaSource` + one-array register is already clean);
  `copilot` is correctly broker-only.

- **Schema-enforced generation — CE-004 residual (provider-blocked only).** The openai-compatible / NIM
  guided-decoding path is **SHIPPED** — the AuditResult `outputSchema` is plumbed through and the dispatch site
  sets it, so those endpoints get emit-time constraint (`guided_json` / `response_format: json_schema`). The
  sole residual is the always-on conversation host (`claude-code`), which advertises no API-level constraint
  mechanism → on that path CE-004 reduces to the repair floor (no emit-time prevention). Genuinely
  host-blocked, not a defect; unblocks only if that host gains a constraint endpoint.
  - **⬇ Live-run watch** on an openai-compatible run: results conform on first emit (repair rounds for
    schema-shape errors drop to ~0).

- **Tool-enforced dispatch broker with capability-tiered driver.** Desired end-state: (1) a gated
  primitive set as the single dispatch chokepoint (read quota, estimate tokens locally, dispatch/await);
  (2) a capability-tiered driver — Y-dispatcher (thin agent, no judgment) where the host supports nesting,
  slot-pull where it can't; (3) classify agent hosts off the cold-start floor. The single-source
  classifier, broker primitive, `HostSessionQuotaSource`, and driver selection/prompt rendering are
  **shipped**. **Open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + live run)
  + proactive pre-wall quota-aware pacing.
  - **⬇ Live-run watch** (Codex backend, which nests agents): the driver-selection step must pick the
    **Y-dispatcher** path (thin dispatcher agent, no judgment) rather than slot-pull — confirm from the
    run's driver-selection log. Separately, on a metered run, pacing should slow *before* the wall (proactive)
    rather than only reacting after a 429. FAIL = slot-pull chosen on a nesting-capable host, or pacing that
    only ever reacts post-wall.

- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** if a future LLM-proposal channel is built for analyzer ids beyond
  the static registry, it must route through the same `admitSpawn` chokepoint; and
  `ExternalAcquisitionConfig.consent_token` must be stripped/redacted before any persistence of
  `SessionConfig` to a shared artifact. [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **Cross-provider quota — live-endpoint confirmation.** Per-provider mappings validated against
  live-shaped fixtures; confirming each source against its **real** endpoint (Claude/Codex live; Copilot/
  Antigravity gated→degrade) is environment-bound. Per-provider recipes:
  [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
  own-provider only, never IDE-GUI automation.
  - **⬇ Live-run watch** (run under each provider whose IDE/CLI you have — Codex CLI is available now):
    the provider's `QuotaSource` must return **live numbers off its real endpoint**, not the fixture/degrade
    fallback — confirm the quota reads are non-empty and move as the run consumes budget. Codex + Claude are
    reachable now; Copilot/Antigravity need those IDEs running. FAIL = a source stuck on degrade when its
    real endpoint is reachable.

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall.
  - **⬇ To close (after any live audit):** take that run's findings, hand-label each true-positive /
    false-positive into `corpus/<run-id>.labels.json`, then run `score-audit` → precision/recall. The
    labeling is ground-truth human judgment (can't be automated); one solid labeled run unblocks the oracle.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and
  green; the provider-matrix e2e is gated behind `RUN_PROVIDER_MATRIX_E2E=1`. **Remaining:** the
  release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only
  hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.
- **`/remediate-code` GUI-host manual checklist (parity with `/audit-code`).** `spec/host-validation.md` is
  a manual GUI-host live-dispatch checklist for `/audit-code` only; `/remediate-code` has the automated
  no-drift gate (`verify:remediate-hosts`) but no equivalent manual GUI-host checklist, which the
  "keep orchestrators in parity" convention says it should have. Add a sibling `/remediate-code` checklist
  (or extend `host-validation.md`). Folds into the A7 release-time GUI checklist work.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`,
  `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — revisit if a provider gains a real proactive rate-limit endpoint.
- **Doc-manifest scope for non-`docs/` host assets (doc-review D-45(a), owner call).** `.github/prompts/audit-code.prompt.md`, `.agent/skills/audit-code/SKILL.md`, and ~15 other un-manifested `*.md` outside `docs/` are not covered by `check-doc-manifest.mjs` (it scopes to `docs/**`). Now that a renderer drift guard pins the two audit host assets, the only residual is whether these should be *formally* listed in `doc-review-guidelines.md`'s routing table — a low-value owner judgment call, not code work.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment.** Prose-heavy fields feed
  downstream LLM prompts; a cosmetic edit forces wasteful re-emit. The narrowing = bounded judgment on
  meaning change, fail-safe to re-derive. Efficiency-only; defer until re-emit churn is measured.

## Doc-set hygiene (enforced)

- **Canonical doc set is mechanically reconciled.** `scripts/check-doc-manifest.mjs`
  (in `verify:release`) fails the build if any tracked `docs/**/*.md` is absent from the
  routing table in [`doc-review-guidelines.md`](doc-review-guidelines.md), or a row points
  at a deleted file. A stray/dated doc can no longer accumulate silently — it must be
  registered (type + reason) or deleted. The doc-review routine adds the soft layer:
  existence-review every run + version/date/status strings are escalate-not-auto-bump
  (a doc whose only diffs are version bumps is a status doc → propose generate-or-retire).
  Durable design captures go to a canonical design doc or backlog/HANDOFF, **never** a
  dated `*-plan-of-record.md` in the tracked tree (the gate now rejects the latter).

## Durable traps (environment / tooling reference)

Standing gotchas worth keeping for any agent (strong or weak):

- **Before starting ANY lap in a worktree, sync with remote main — landed work may be missing.** A worktree
  can be branched from a *stale* local main and miss commits that already landed on `audit-tools/main`. This
  session branched 4 commits behind and **re-implemented a full commit (admission-control 2a) already on
  main**, plus built 2b blind to a pinned design section it lacked — then had to `git reset --hard
  audit-tools/main` + cherry-pick + reconcile. First action of every lap:
  `rtk git fetch audit-tools main && git log --oneline HEAD..audit-tools/main` — if that lists commits,
  rebase/reset onto main BEFORE writing code. (Strengthens [[audit-tools-worktree-traps]].)

- **Codex CLI is a poor executor for large read-heavy audit packets under a wall-clock budget.** Observed
  2026-07-04: 2 concurrent codex executors ran 5+ min with zero results and 8k+ lines of echoed reasoning.
  Route only small / low-line packets to the codex pool, or drop it from the audit executor pool for
  read-heavy work. (Durable routing lesson from the admission-control rework.)

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes the
  tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because git
  cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒ blanket-ignore.
  Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent against the
  committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/` line OUTSIDE
  the managed markers — delete it, the managed block owns the tree.
- **Tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`**, never a
  bare `**/<name>/` — an unanchored glob (e.g. `**/friction/`) regenerates on every `ensure`/postinstall and
  can shadow a same-named SOURCE dir (`src/shared/friction/`), which a file-level edit can't fix. (`.audit-code/`
  is fine — distinct name, no source collision.)
- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.)
- **CLAUDECODE** is set in-session → UNSET for true-green gate runs (`env -u CLAUDECODE …`; set = one
  audit-code provider test fails).
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`).
  Run a single file with `npx vitest run <path>`. `node:assert/strict`
  is still permitted as an assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses.
- **Don't mask the test exit code.** `npm test > out; echo done` reports the *trailing* command's exit, not the
  suite's — and piping through `grep`/`rm` in the same Bash call races the output file, so a real failure reads
  as "green." Capture the suite's own status: `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`.
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts. Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **A NEW `.claude/hooks/*.mjs` needs an explicit `!.claude/hooks/<name>` re-include in `.gitignore`.**
  `.gitignore` ignores `.claude/hooks/*` then allowlists each tracked hook by name (deliberate — never ship
  arbitrary `.claude` files). Adding a hook and committing WITHOUT the `!` exception silently drops the file
  from the commit; if `.claude/settings.json` (committed) references it, main now points at an untracked hook
  = broken state. Add the `!.claude/hooks/<name>` line in the same commit as the hook + its settings.json
  registration. (Bit once 2026-07-05: `friction-stop-gate.mjs`.)

- **A `\0` in a Write-tool template literal lands as a RAW NUL byte → binary-flags the source file.** Writing
  `` `${a}\0${b}` `` (a NUL pair-key separator) via the Write tool put a literal 0x00 in the `.ts` source, so git
  treated it as **binary** (`git diff` shows `Bin`/`- -`, grep-hostile) even though tsc/vitest read it fine. Same
  for an in-comment control char. Detect with `python -c "print(open(p,'rb').read().count(0))"`; fix by using a
  text-safe escape that stays a source escape (`U+001F` unit separator) or a printable delimiter. Never embed a
  raw control byte in source — prefer a `\uXXXX` escape the compiler resolves at runtime. (Bit once 2026-07-05:
  `src/shared/decompose/consensus.ts` pairKey.)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **When you delete a *shipped* file, grep the smoke/verify scripts** for a `requiredPackagedPaths`-style list
  (the packaged-smoke gate asserts specific tarball files).
- **A production runtime `import` declared as a `devDependency` ships a broken packaged/global install** —
  local dev + the vitest suite still pass (devDeps are present there), so ONLY `smoke:packaged-*`
  (`verify:release`) catches the `ERR_MODULE_NOT_FOUND`. When you add an `import` to any `src/` module that
  lands in `dist/` on a production path, confirm the package is under `dependencies`, not `devDependencies`.
  (Bit once 2026-07-04: `zod-to-json-schema`, used by `src/audit/contracts/workerSchemas.ts`.)
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **Prefer a dependency-injection seam over module mocking** in tests. Under vitest, `vi.spyOn`/`vi.mock`
  and fake timers (`vi.useFakeTimers({ toFake: [...] })`) are available, but the codebase's established
  pattern is injectable deps (`WorkerRunDeps`, `createWriteStream`/`spawn` seams) — keep using those.
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A narrow Explore before contract authoring is the top
  repair-round-churn driver — search the WHOLE repo for equivalent logic AND independently re-verify the
  target symbol's own type/shape against source at least once per contract. The cost of one broader Explore
  call or one grep is far lower than a full adversarial repair round or an implement-time revert.
  [[front-load-broad-search-before-contract-authoring]]
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.**
  For a broad mechanical sweep over a shared file set, run it as ONE serial agent (or partition by
  NON-overlapping files), never an uncoordinated fan-out; and never hand-edit the same files while a
  background agent is live on them.
- **`rtk` compresses files you need verbatim.** When reading the `audit-code` skill body or `docs/backlog.md`
  through `rtk read`, content gets partially summarized with retrieval hashes → not exact. For any file you must
  act on verbatim, use raw `Get-Content -Raw` (or the Read tool), not `rtk read`.
- **`rtk proxy` runs executables, not PowerShell cmdlets.** `rtk proxy Get-Content` / `rtk proxy Get-ChildItem`
  fail (cmdlets aren't standalone exes). Working form: `rtk proxy powershell -NoProfile -Command "..."`.
- **`rtk proxy rg` fails with `Access is denied`** (Codex/win32). Fallback: PowerShell `Select-String` (or the
  Grep tool).
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree; adding the Agent tool's
  OWN `isolation: "worktree"` spawns a second, unrelated git worktree and the subagent edits source files there
  instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff.
  [[no-agent-isolation-worktree-for-dispatch-nodes]]
- **No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.** Host-side attempts to
  unblock a stuck audit (pending tasks that won't clear) do NOT work and actively corrupt gitignored
  run-state: marking `status:complete` in `audit_tasks.json` is ignored; writing
  `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency keys
  clears the obligation but cascades stale `planning_artifacts`. The only clean recovery is the tool-owned
  affordance — `audit-code force-synthesis` stamps an `operator_forced` partial-completion terminal over the
  pending task ids (durable direct write to `active-dispatch.json`, the special-loaded artifact
  `writeCoreArtifacts` doesn't own) and drives the synthesis executor from the intact ledger on partial
  coverage, with no hand-editing of gitignored run-state. (`src/audit/cli/forceSynthesisCommand.ts`;
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.mjs`.)
