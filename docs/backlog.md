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

- **A forward-track design memory outlived a major closure and sent a build in the wrong initial direction
  (ambiguous-direction, 2026-07-08).** The cost↔speed dial's design (memory
  [[host-provider-misattribution-nim-codex]] forward-track, written 2026-07-07) defined its throughput axis +
  free-pool-max in terms of the **AIMD adaptive concurrency ceiling** — which was CLOSED and reverted the SAME
  window ([[concurrency-is-declared-or-absent-never-learned]]). A lap that trusted the memory built a
  declared-*rate* throughput axis (v1) before the stale-AIMD dependency was caught and the owner re-steered to
  auto-derived concurrency. No lasting damage (caught pre-merge, λ=0 default kept it safe), but the lesson
  generalizes [[spec-degradation-and-doc-staleness]]: **when a forward-track predates a since-landed closure,
  re-reconcile its premises against current invariants BEFORE building, not after.** A design memory is a
  point-in-time proposal, not a live spec — the same "spec is right, the design is wrong" rule that killed
  C3-AIMD applies to a memory that cites a deleted mechanism.

- **A lap reported "merged" before its work was on remote `main` → the next lap re-did it (faithful-reporting /
  pipeline-ownership failure, 2026-07-07).** Two laps both did the A1 rename. Root cause, established from git: the
  first lap's rename commit (`7688febe`) was authored 23:24:56, committed 23:25:17, and did not land on remote `main`
  until **23:25:30** — yet it had been *reported* to the owner as "completed, committed, and merged" before the second
  lap was launched. The second lap's `start-lap` fetched the true remote tip (`db1c0e11`, v0.32.32, **no A1**) before
  23:25:30, so HANDOFF still queued A1 and it correctly built it; its identical commit was then rejected on push
  (behind remote) and discarded — a full rename's worth of wasted work. `start-lap` behaved correctly against the
  remote state that existed; the defect is upstream. Two independent fixes, both belong in tooling not host habit:
  (1) **a lap is not "done" until its work is on remote `main`** — the completion signal an operator trusts must be
  gated on the push having landed (pipeline-ownership; the first lap violated this by reporting merged pre-push).
  (2) **`start-lap` re-fetch-before-first-write guard** — re-fetch + re-read HANDOFF immediately before the first
  commit so a mid-lap merge is caught before the duplicate lands (bounds the blast radius to a rejected push, not
  wasted labor). The labor-saving fix is still the cooperative-runs claim ([[multi-ide-concurrent-runs-design]]
  task-claiming): stake a claim on the item at lap start so a second lap sees it taken. Salvage from this incident:
  the loser's sweep caught a stale `// Local-subprocess` comment the winner's rename missed — landed as a follow-up chore.

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

- **Meta-frictions from the v0.32.27 code-fixable sweep (fix in tooling).** Four tool gaps surfaced driving +
  recovering that run (full detail in its friction record `.audit-tools/remediation/friction/backlog-code-fixable-sweep-2026-07-06.json`):
  - **Convergence guard keys on the reviewer-supplied counterexample *id string*, not CE content.** Two independent
    adversarial rounds each labeled their (genuinely distinct) top CE `CE-001`, so the judge↔repair loop read "same CE
    re-accepted after a repair" and raised a FALSE non-convergence block that escalated to a user decision — while a
    real, new, accepted defect was being correctly repaired. Fix: key convergence detection on a CE content /
    violated-obligation fingerprint, or auto-mint unique CE ids; never trust the reviewer's free-text id.
  - **Cross-file contract/invariant regressions escape node-local verify and surface only at ship-time CI.** Per-node
    implement workers verify their OWN targeted tests but don't run the repo-wide guards their refactors break
    (id-glossary INV-family registry, INV-WH raw-spawn, release-contract source-shape, drain-lifecycle analyzer-cache
    coupling) — four such breaks were caught one-CI-cycle-at-a-time across 3 failed publishes. The implement/verify
    (or accept-node) step should run the repo-wide contract/invariant guard suite against the merged tree, not just
    node-local tests. Extends [[worktree-tests-miss-integration-guards]].

- **`validate-artifact` (singular, write-time self-check) skips the cross-artifact gates `next-step` enforces →
  authoring-agent round-trip (verified 2026-07-08).** The singular `validate-artifact --name X` command
  (`src/remediate/index.ts` ~L322, surfaced to authoring agents via `contractPipelinePrompts.ts:489`) runs ONLY
  the per-artifact structural `CONTRACT_PIPELINE_VALIDATORS[name]`; the positive+negative pairing / CE-006
  negative-scoping cross-gates run only in the PLURAL `validate-artifacts` sweep and at `next-step`. So a
  shape-valid `test_validator_plan` missing its scoped positive+negative pair self-validates "ok", then fails the
  gate at next-step → round-trip. Fix = single-source the cross-gate set and run it from the singular command too
  (load on-disk sibling CP artifacts, substitute the in-flight payload, absent-input-tolerant so a partial
  pipeline never false-fails). **DESIGN QUESTION before shipping:** making a single-artifact self-check load
  on-disk siblings + run cross-gates changes its nature — confirm that's intended (vs a lighter shape-only
  check). This is a contract-pipeline (loop-core) change → route through the adversarial pipeline, not a lone
  autonomous agent. Extends the CP-NODE contract-validation work.

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

- **`isolation:"worktree"` on a dispatch node is host-discretion — should be tool-enforced (traps audit
  2026-07-08).** The durable trap "never pass `isolation:"worktree"` to the Agent tool when dispatching a
  remediate/audit implement node" is currently a *host-remembers* rule: the dispatch plan already creates the
  node's worktree, but nothing stops the host from ALSO passing the Agent tool's own `isolation:"worktree"`,
  which spawns a second unrelated worktree where the subagent's edits land invisibly → `accept-node`'s
  cherry-pick sees no diff. Per enforce-in-tooling this latent failure should be made impossible/detected:
  e.g. `accept-node` fail-loud when the node's designated worktree has no commits (the edits went elsewhere),
  or the dispatch contract assert the subagent's git toplevel equals the designated worktree root.
  [[no-agent-isolation-worktree-for-dispatch-nodes]] / [[enforce-robustness-in-tooling-not-host-discretion]]

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
  — the minimum-cost corner of a cost-vs-throughput Pareto frontier — into a tunable operating point ON TOP of
  the kept router (does not replace it). Design of record now [`spec/dispatch-cost-speed-dial.md`](../spec/dispatch-cost-speed-dial.md);
  extends [[cost-first-routing-design]].
  - **✅ SHIPPED v0.32.34 (2026-07-08).** 1D dial, λ ∈ [0,1], capability a hard floor. Seven commits
    (substrate → Gate-0 capture → review hardening → concurrency pivot → R-1 fix + builder unification):
    - **Ordinal-blend admission ordering** (`admissionLoop.ts orderCandidates`): λ=0 = **byte-identical** to the
      pre-dial cost-first sort (adversarially confirmed); λ>0 blends per-axis ORDINALS within the capable set
      (total order, no scale-mixing). The dial reorders only — declaredCap/budget/ledger/claim gates untouched.
    - **Throughput axis = auto-derived declared CONCURRENCY** (`throughputOf` = `declaredCap`, null ⇒ +Infinity).
      **Superseded** the earlier "effective Mtok/s [rate∧concurrency∧speed]" sketch: that leaned on the deleted
      AIMD ceiling AND (v1 of this build) on declared TPM/RPM, which muted the dial on the percent-metered host
      and would have needed a manual rate declaration (owner: *a needed manual flag is a bug signal*, 2026-07-08).
      Concurrency is already on the pool, auto, honors "concurrency is declared or absent, never learned", and
      doesn't crown the sequential host (finite subagent limit < an uncapped parallel source).
    - **Gate-0 capture** = `provider_confirmation` durable policy: `provider-confirmation-input/v1` gains optional
      `dispatch_bias`; persisted on the shared confirmation (`readConfirmedDispatchBias`); both orchestrators
      thread it to `computeDispatchAdmission`. Headless auto-completes λ=0. Default 0 everywhere ⇒ zero behavior
      change until an operator sets it.
  - **✅ Adversarial pass on the concurrency axis DONE (2026-07-08) — found + fixed R-1.** The pass caught that
    `throughputOf = declaredCap (null⇒+Inf)` had RELOCATED R-1, not fixed it: the default zero-declaration
    claude-code host resolves `declaredCap=null` → crowned fastest AND monopolized the wave at λ=1 (null
    budget/cap). Root: `declaredCap==null` means opposite speeds on the host vs a source. Fixed (`a1bcc6a0`) by
    deriving throughput **pool-class-aware** (`deriveThroughputConcurrency`: source uncapped⇒+Inf, host
    unspecified⇒1-sequential) via an auto `is_conversation_host` discriminator — no manual declaration. **Also
    unified (owner steer):** the two near-duplicate AdmissionPool build maps DELETED → one shared
    `admissionPoolsFromSummaries`, so audit/remediate can't drift. Regression + non-vacuous ordering tests added.
  - **RESIDUAL / next:**
    - **`/models` concurrency probe = the future AUTO refinement** (discovered, still not declared) — feeds the
      throughput derivation a richer signal where a provider states nothing; must sanity-clamp a probed value
      before it reaches the rank (poison→over-admit). Ties into the deferred openai-compatible `/models` probe.
    - **B2 host-reorder seed** (host reorders/excludes pools once at Gate-0) already has its substrate in the
      shipped interactive `provider_confirmation`; the reorder wiring is separate from the λ dial and still open.
  - **Free-pool maximization (dial-independent).** Price-0 pools are first-fill at every operating point → free
    is saturated before any paid pool automatically (`costRank` already delivers it once a source is registered).
    "Maxed" = saturated to the pool's declared sustainable ceiling (`declaredCap` + rate limits + reactive 429
    floor), NOT flooded. **Correction:** the old note said this "depends on C3-AIMD" — C3-AIMD is CLOSED; the
    ceiling is now `declaredCap` + reactive backoff, no learned ceiling. Real work = **register every free source
    as a pool** = the arbitrage-tier track [[arbitrage-dispatch-tier-design]] (Phase 0 zero-ban-risk first).
  - **OPEN (owner call):** whether QUALITY also becomes tradeable vs cost (a true 2D dial, needs a per-task
    quality-worth weighting) — default recorded = 1D cost↔speed + capability floor.

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
- **Packaged/global-install drift is caught ONLY by `smoke:packaged-*` (`verify:release`), never by dev or
  vitest — so it fails the release gate loudly, not silently.** Two ways to break the tarball that pass every
  local check: (1) a production runtime `import` declared as a `devDependency` — devDeps are present in dev +
  the vitest suite, so only the packaged smoke hits `ERR_MODULE_NOT_FOUND` (when you add an `import` to any
  `src/` module that lands in `dist/` on a production path, confirm the package is under `dependencies`; bit
  once 2026-07-04 by `zod-to-json-schema` in `src/audit/contracts/workerSchemas.ts`); (2) deleting a *shipped*
  file that the smoke's `requiredPackagedPaths` list asserts (`scripts/audit/smoke-packaged-audit-code.mjs`,
  `verify-hosts.mjs`) → the gate fails on the missing tarball path. Diagnostic, not a silent trap: if
  `smoke:packaged` errors on a missing/absent module or path, this is why.
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
