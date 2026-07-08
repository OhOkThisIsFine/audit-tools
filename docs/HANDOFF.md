# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- **v0.32.33 published on npm as `latest`.** Latest lap shipped the **A1 `local-subprocess`→`worker-command`
  provider rename** (sole-consumer, no shim — see the A1 bullet below). Prior (v0.32.32): **C1 real source-pool budget**
  (legacy `openai_compatible` block gains a `quota` that converges onto the source pool, off the default floor;
  shared-consumer robustness — `resolveContextBudget` floors at 0, discovered rung drops an inverted `output ≥ context`;
  operator quota validated) — see the C1 bullet below. Prior (v0.32.31): bug (4) `selectProvider` reads the live quota entry. Prior
  (v0.32.30): quota-state durability (INV-QD-15) and the
  **deletion of the concurrency bucket learner** (−862 LOC), which unmasked and fixed INV-QD-16 (a concurrent
  `success` must not cancel a live cooldown) — see the quota bullet below. Prior (v0.32.29): B1 host-identity
  sourcing. Prior (v0.32.28): the NIM/Codex dispatch-fix lean tranche. Prior (v0.32.27): the "everything code-fixable" backlog sweep landed (11 nodes) **plus
  the HIGH remediate worktree-safety fix** — per-node worktree isolation + total lock order + OID-ancestry
  reconcile + `resolved_no_change` captured-OID grounding, so concurrent `accept-node` can no longer wipe sibling
  in-flight worktrees or desync `state.json` from git. **Conceptual design-review Phases A–E all landed** (charter
  LAYER, overlay-and-delta structure operator, charter extraction + charter-aware conceptual prompt, charter-delta
  clarification loop, systemic improvement-seeking challenge loop). Design of record
  [`spec/conceptual-design-review-design.md`](../spec/conceptual-design-review-design.md),
  [[conceptual-design-review-design]]. Per-lap shipped detail is NOT narrated here (changelog creep — see `git log`
  and project memory [[live-status]]); this section is current-state + open-work roadmap only.
- **⚠️ `main` is AHEAD of published v0.32.33 — a release is PENDING.** Two unreleased lap commits (2026-07-08):
  `2296e52f` session-config RMW-lock code fix (real code → wants a publish) + `ab444072` CLAUDECODE-ceremony/
  standing-traps docs cleanup (docs-only). The next `release:patch:publish` picks them up; the lap was wrapped
  before releasing per owner. Also on main unreleased: the `validate-artifact` singular-self-check gap is FILED
  (not fixed) in `docs/backlog.md` for the adversarial pipeline (a drafted patch exists but was held — loop-core).
- **NIM/Codex dispatch fix set — lean halt fix + B1 host-identity ✅ SHIPPED (v0.32.28 / v0.32.29).** Lean tranche
  (v0.32.28): C2 tolerant result parse + C4 bounded transient fetch retry + C3 per-pool concurrency cap + D1 bounded
  no-progress retry + D2 recovery handoff. **B1 host-identity sourcing (v0.32.29):** NEW `resolveConversationHostProvider`
  auto-detects the real host off `isSelfSpawnBlocked("codex")` (codex-first) with a `--host-provider` /
  `sessionConfig.host_provider` override; `resolveHostProviderName` moved to `providerPathGuard.ts` and its
  unset/auto fallback now delegates to the detector (was literal `claude-code`); all 3 demote/in-process host-key
  sites route through it. Full adversarial pipeline caught 1 MAJOR (codex-host + `provider:codex`-inside-codex
  double-booked one codex account) → NEW `shouldDemotePrimaryInProcess` same-agent guard.
  **C3-AIMD is CLOSED — not needed, do not re-propose** (the owner, 2026-07-07): concurrency is DECLARED by the
  provider or ABSENT, never learned. The shipped `declaredCap` floor covers case 1; quota + rate limits cover case 2.
  It was built, adversarially reviewed by three independent reviewers, and reverted — see
  [[concurrency-is-declared-or-absent-never-learned]] and `docs/backlog.md`.
  **Quota-state bugs (1)–(3) are CLOSED.** (1) `quota-state.json` torn read failed OPEN → `writeQuotaState` is now
  atomic (temp+rename via the shared `writeJsonFile`), `readQuotaState` throws `QuotaStateUnavailableError` rather
  than conflating an unusable file with cold start, `readQuotaStateOrDegrade` is the one loud opt-in degrade, and the
  lock-held RMW path quarantines corrupt bytes aside and rebuilds (INV-QD-15; `reservationLedger` + `claimRegistry`
  had the same truncating-write shape and are now atomic too). (2)+(3) resolved **by deletion**: the bucket learner
  (`buckets`, `computeMaxSafeConcurrency`, `computeRampUpConcurrency`, `clearBucketFailureEvidence`, the decay
  machinery, `ObservedWaveOutcome.concurrency`, `quota.{empirical_half_life_hours,ramp_up_enabled}`) was
  pre-admission-control legacy that inferred a concurrency number from a rate-limit signal — the exact category error
  [[concurrency-is-declared-or-absent-never-learned]] closes. It is gone; `updated_at`-as-decay-clock went with it.
  What survives on the entry is reactive backoff (`cooldown_until` / `last_429_at` / `consecutive_429_count`) plus
  `tokens_per_pct` / `output_per_input`, which are what actually gate admission. The deletion **unmasked** a latent
  bug the poisoned buckets had been compensating for: `recordWaveOutcome` cleared a *live* `cooldown_until` on any
  success, though a concurrent success was dispatched before the 429 and is no evidence the limit is over
  (**INV-QD-16**, fixed: only an already-expired cooldown clears).
  **Bug (4) CLOSED (this lap):** `selectProvider`'s `scheduleForPool` now reads the LIVE `quotaStateEntries[poolKey]`
  first and only falls back to the frozen `pool.quotaStateEntry` snapshot when the live read is transiently
  unavailable — so a `cooldown_until` learned mid-run is observed (INV-QD-14 spill), and a prior-run cooldown still
  drives proactive spill through a transient-read window instead of waiting for the reactive 429 floor.
  Adversarially reviewed (independent reviewer confirmed no regression; the `live ?? snapshot` order is what
  preserves the transient-read fallback the snapshot-only drop would have lost).
  **C1 real source-pool budget — ✅ SHIPPED (this lap).** A legacy `openai_compatible` block gained a
  `quota?: QuotaModelLimits` field that `openAiCompatibleSource` copies onto the folded/demoted source, so a
  configured window/concurrency reaches `buildSourcePool`'s `discoveredLimits`/`concurrencyCap` instead of the
  `DEFAULT_CONTEXT_TOKENS`/`DEFAULT_OUTPUT_TOKENS` floor — converged onto the SAME `sources[].quota` shape. Full
  adversarial pass corrected the premise (a bad window fails CLOSED / starves, not over-admits) and moved the
  guarantee into the SHARED consumer so it holds on both orchestrators regardless of validation:
  `resolveContextBudget` floors at 0 (never negative) and the `discovered_capability` rung ignores an inverted
  `output ≥ context` reservation. Operator quota is also validated at config load (audit path, defense-in-depth;
  `max_concurrent: 0` = unlimited sentinel honored). [[openai-compatible-provider]].
  **A1 rename `local-subprocess`→`worker-command` — ✅ SHIPPED:** provider identity renamed across name const
  (`WORKER_COMMAND_PROVIDER_NAME`), class (`WorkerCommandProvider`/`workerCommandProvider.ts`), `PROVIDER_NAMES` /
  `DISPATCHABLE_SOURCE_PROVIDERS`, factory, example config, operator guide + gloss; sole-consumer, no shim. Detail in
  `docs/backlog.md`.
  **Immediate next:** finish the cost↔speed dial — see the dedicated bullet below.
- **⚙️ Cost↔speed dispatch dial — BUILT + adversarially reviewed on branch `claude/start-lap-command-d1ca1a`,
  NOT merged/released (2026-07-08).** 1D dial (λ∈[0,1], capability a hard floor) on TOP of the kept cost-first
  router: λ=0 = byte-identical to today (adversarially confirmed); λ>0 = ordinal-blend of cost vs **auto-derived
  pool-class-aware parallelism** (`deriveThroughputConcurrency`: source uncapped⇒+Inf, host unspecified⇒1); Gate-0
  `dispatch_bias` captures it as durable policy; both orchestrators build pools through ONE shared
  `admissionPoolsFromSummaries` (no drift). Default 0 ⇒ zero behavior change until set. **Six commits** (88652854 →
  9dcf3474 → 092f729b → 3abf6f25 → ab5e6fab → a1bcc6a0), all green + dead-code clean. Two independent adversarial
  passes ran; the 2nd caught R-1 (declaredCap-null crowned the sequential host at λ=1) → fixed pool-class-aware +
  regression-tested. Design of record [`spec/dispatch-cost-speed-dial.md`](../spec/dispatch-cost-speed-dial.md).
  **Residual (in `docs/backlog.md` → Forward tracks, dial bullet): (1)** the `/models` concurrency probe as the
  future *auto* refinement; **(2)** B2 host-reorder seed. Both are additive; the dial is code-complete + reviewed.
- **Then:** the free/cheap multi-account "quota-arbitrage" dispatch tier (`docs/backlog.md` → Forward tracks;
  [[arbitrage-dispatch-tier-design]]). Then the remaining env-bound live validations (quota pre-wall pacing,
  friction escalation, selective-deepening convergence, clippy/rubocop live spawn).
- **Dispatch admission-control — residual (env-bound / deeper, in `docs/backlog.md`):**
  (a) live validation of a real host+codex+NIM concurrent metered run; (b) deeper *within-turn* simultaneity
  (the audit hybrid path alternates in-process partition then host review ACROSS turns, not simultaneously
  within one — a detached background driver is architectural, pursue only if a real run shows the alternation
  is the bottleneck); (c) durable routing lesson: codex CLI is a poor fit for large read-heavy audit packets.
  **Also open:** the token-budget ledger path is live-validated only on a metered run (`docs/backlog.md`
  quota-aware dispatch, env-bound).
- **⚠️ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main` before
  starting a lap — this worktree branched behind main and had to fast-forward + re-read HANDOFF/backlog.
- **✅ Max-sweep remediation run COMPLETE (2026-07-06); the HIGH worktree-safety bug it exposed is FIXED + shipped
  in v0.32.27.** The 10-node `backlog-handoff-max-sweep-2026-07-06` plan fully landed (manual node-by-node recovery
  after the original worktree-wipe/state-desync incident). Durable status/recovery in
  [[remediate-max-sweep-run-2026-07-06]] / [[remediate-worktree-wipe-state-desync]].
- **Open items** (all in `docs/backlog.md`): the NIM/Codex dispatch fix set (immediate-next above); the cost↔speed
  dial + free-pool / quota-arbitrage forward tracks; env-bound live validations (quota pre-wall pacing, friction
  escalation, selective-deepening convergence, clippy/rubocop live spawn); provider-blocked schema CE-004 residual
  (claude-code host only — the NIM guided-decoding path shipped).
- the owner runs live/rate-limited/deepening-capable runs routinely and reports back — this doc does not
  carry "needs live validation" reminders for code that's otherwise complete; treat anything below as
  code-complete unless it says otherwise.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). This is the *host workaround* until the self-scaling pipeline makes it the tool's own job.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`; don't
  trust the empty mechanical friction set.
- **Release:** `npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump.
  Run `npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
  CI gate is split for speed (2026-07-04): `verify:release` = `verify:checks` (cheap deterministic chain) +
  vitest; `ci.yml`/`publish-package.yml` run `verify:checks` and a **4-way sharded vitest matrix** as
  parallel jobs, publish `needs:` both. vitest was ~93% of the old serial gate → sharding is the only lever
  that moved release latency. Remaining redundancy (suite runs 3× per push) tracked in `docs/backlog.md`.
- **Branch-strand trap (bit twice already):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code
  implement node** — the tool's dispatch plan already names the correct worktree; a second isolation
  worktree strands the subagent's edits where `accept-node` can't see them. See backlog → durable traps.

---

## Suggested ordering — everything open, sequenced

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work, and is the "redesign before scheduled autonomy" the north star requires
([[autonomous-pipeline-capstone-spec]]). Loop-infra (T1–T3) is COMPLETE end-to-end — nothing open on
those tracks. Remaining sequencing: cheap ergonomics (T4) → product/analysis tracks (T5) → deferred (T6).

### T1–T3 — Loop infra — ✅ COMPLETE
Self-scaling pipeline ([`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md),
[[self-scaling-pipeline-not-forked-paths]]), loop convergence & safety (repair-cap / convergence
termination, friction-detection wiring, quarantine-on-fail-loud data-loss fix), and remediator auto-phasing
(derivation + persistence + ordinal threading + scheduler barrier + per-phase boundary gate) are all
shipped end-to-end. Nothing open.

### T4 — Remaining host-friction inventory
Selective-deepening convergence has a shipped code fix; live validation on a real deepening-capable run
remains env-bound (T6-class). Detail in `docs/backlog.md`.

### T5 — Product / analysis forward tracks
Each item's full spec lives in `docs/backlog.md` (Forward tracks / Open bugs) — pointers only here:
-1. **Conceptual + systemic-adversarial design review — ✅ COMPLETE (all five phases).** ONE build
   ([[conceptual-design-review-design]]; design of record
   [`spec/conceptual-design-review-design.md`](../spec/conceptual-design-review-design.md)): Phase A (data-model
   spine), B (overlay-and-delta operator), C (charter extraction + charter-aware conceptual prompt, LLM), D
   (charter-delta clarification/triangulation loop, obligation `charter_clarification_current`), E (systemic
   improvement-seeking challenge loop, obligation `systemic_challenge_current`, true-lens seam) all landed.
   Durable design in `docs/backlog.md` → "Systemic reviewers must be pushed adversarially" forward track.
0. **Multi-provider routing rethink outcome (2026-07-05).** Verdict: core is sound + ahead of field, no big
   simplification, AI-SDK swap dropped. (a) `scheduleWave` quota-off **drift bug** — ✅ SHIPPED. (b) `rollingEngine.ts`
   **dead module** — ✅ DELETED (~268 LOC). (c) **models.dev static-metadata resolver**: W1 real context window — ✅
   SHIPPED; **W2 real price → `costRank`** + Gate-0 cost-aware confirmation — ✅ SHIPPED, now an **interactive
   `provider_confirmation` step** (host-prompt visibility + operator reorder + host-roster-at-Gate-0 all shipped; design
   of record [`spec/cost-first-routing.md`](../spec/cost-first-routing.md)); **collision-price preference ((provider,model)
   keying in `modelStatics` + snapshot generator) SHIPPED.** *([[provider-routing-offload-b-to-ai-sdk]])*
1. **Deterministic analyzers — own-vs-acquire acquisition engine.** Open: clippy/rubocop live spawn
   unvalidated (no Rust/Ruby repo here). *([[deterministic-analyzers-own-vs-acquire]])*
2. **Schema-enforced generation — CE-004 residual.** The openai-compatible/NIM guided-decoding path is **SHIPPED**
   (`outputSchema` plumbed + set at dispatch); only the always-on claude-code host stays repair-floor (no
   API-level constraint endpoint — genuinely provider-blocked, not a defect).
3. **Dispatch admission-control rework — ✅ COMPLETE (founding bug + defect-1).** Design of record:
   [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md) (**concurrency is
   not a computed quantity** — admit on budget headroom; the only explicit cap is a declared env hard-limit
   e.g. Codex 6). [[dispatch-admission-control-design]]. Everything shipped: commits 1 + 2a + 2b-AUDIT +
   2b-REMEDIATE + driver-unification + commit 3 (founding capability-inheritance bug) + **defect-1 (attended
   host demotes backend to source → host + codex + NIM concurrent; sub-2 least-loaded pool balancing; sub-3
   single-shot NIM output-contract + read-heavy file routing)**. Residual is env-bound live validation +
   deeper within-turn simultaneity (both in `docs/backlog.md` → dispatch admission-control rework).

### T6 — Deferred / waiting (user-owned or low priority)
- A2 finding-quality oracle (needs a hand-labeled corpus); A7 release-time manual GUI checklist
  (Antigravity/OpenCode); provider `queryLimits` (revisit if a provider gains a proactive endpoint);
  narrow staleness
  on prose-heavy artifacts (bounded semantic judgment, defer until churn is measured); cross-provider quota
  live-endpoint confirmation (Claude/Codex live-confirmed, Copilot/Antigravity gated→degrade).
  *(full detail in `docs/backlog.md` → "Deferred / waiting")*

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
