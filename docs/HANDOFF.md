# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.32.8**. Per-lap shipped detail is NOT narrated here (changelog creep — see
  `git log` and project memory [[live-status]]); this section is current-state + open-work roadmap only.
- **Immediate next: Dispatch admission-control — 2a + 2b-AUDIT shipped; 2b-REMEDIATE lands WITH the
  driver-unification (next arc).** Concurrency is not a computed quantity — budget-gated admission; only a
  declared env hard-cap (Codex 6) is explicit. **2a DONE** (`361f8f7c`): `ReservationLedger` wired into the
  in-process rolling engine. **2b-AUDIT DONE** (`5f7ef048` + `36623383`): the atomic scalar replace on the
  audit host-dispatch path — `max_concurrent_agents` deleted; dispatch-quota schema v1alpha3 carries an
  `admission` block (`granted_packet_ids` + `declared_cap` + `leases` + `explains`); new shared
  `admitBatch` does **cost-first-capable** routing (cheapest capable pool with budget+cap headroom; owner
  steer 2026-07-05, native not bolt-on); `computeDispatchAdmission` single-sources the derivation; host
  prompt says "dispatch exactly the granted set, re-invoke for the next grant"; merge-and-ingest reconciles
  the grant's leases. Built to the pinned spec §"Host-path admission shape (2b build) — resolved" (whole
  plan stays, admission ⟂ top-K coverage budget, budget = declared-envelope-only on claude-code). Full audit
  + shared suites green. **2b-REMEDIATE = next arc, coupled to driver-unification** — see below: remediate's
  host rolling session is a *continuous-refill* model whose `slots` IS the concurrency width; removing it
  cleanly (worktrees == granted set, per-grant re-grant, reconcile at accept-node) reshapes the rolling
  lifecycle, and `docs/backlog.md`'s driver-unification track explicitly says do it WITH the unification so
  the driver is not restructured twice. **⚠️ Trap logged:** this worktree branched from a STALE main (4
  commits behind incl. 2a) → a full 2a was re-implemented + had to be reset/reconciled. ALWAYS
  `git fetch audit-tools main && git log HEAD..audit-tools/main` before starting a lap.
- **Open items** (all in `docs/backlog.md`): remediate-side `opencode.json` drift/`INV-RCI-16`
  reconciliation; env-bound live validations (quota pre-wall pacing, friction escalation,
  selective-deepening convergence, clippy/rubocop live spawn); provider-blocked schema CE-004.
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
- **Release:** `env -u CLAUDECODE npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run gate/test with `env -u CLAUDECODE`.
  Run `env -u CLAUDECODE npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
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
1. **Deterministic analyzers — own-vs-acquire acquisition engine.** Open: clippy/rubocop live spawn
   unvalidated (no Rust/Ruby repo here). *([[deterministic-analyzers-own-vs-acquire]])*
2. **Schema-enforced generation — CE-004 residual.** Provider-blocked (always-on host has no constraint
   endpoint); the openai-compatible/NIM guided-decoding path is the build lever.
3. **Dispatch admission-control rework — 🔨 building (commit 1 + 2a + 2b-AUDIT shipped; 2b-remediate+unification next).** Design of record:
   [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md) (owner-resolved
   *Resolved decisions* + sharpened framing: **concurrency is not a computed quantity** — admit on budget
   headroom; the only explicit cap is a declared env hard-limit e.g. Codex 6). [[dispatch-admission-control-design]].
   Three-commit atomic sequence:
   - **Commit 1 — DONE (`5e0a4479`):** additive substrate — `ReservationLedger`
     (`src/shared/quota/reservationLedger.ts`, ClaimRegistry pattern generalized to token leases),
     output-envelope `estimatePacketCost` (`src/shared/quota/packetCost.ts`), `output_per_input` ratio EWMA
     (`state.ts`/`types.ts`). 34 tests. No dispatch wiring.
   - **Commit 2a — DONE (this lap):** the in-process rolling engine is *already* emergent
     (`src/shared/dispatch/rollingDispatch.ts` header: "No max_concurrent in the public API") — the
     `ReservationLedger` is now wired in as **shared cross-process/account in-flight accounting**: optional
     `reservationLedger` + `resolvePoolBudget` + `resolveOutputReservation` config; `admitAgainstLedger` leases
     a packet's output-envelope cost BEFORE `dispatchOnePacket` and `handleResult` reconciles it; the liveness
     backstop keys off the ledger's `outstandingBefore` (0 ⇒ a single packet exceeds the whole budget with
     nothing to free room ⇒ force-admit unbounded; >0 ⇒ a peer/in-flight lease will free budget ⇒ wait — this
     is what stops two co-located loops both force-admitting into overshoot). Additive: default OFF (no ledger
     ⇒ behaviour identical); the two wrappers (audit `runRollingDispatch`, remediate `createRollingDispatcher`
     at `nextStep.ts:830`) pass no ledger yet — they get a real budget in 2b. Tests:
     `tests/shared/reservation-dispatch-overshoot.test.mjs` (co-located overshoot / liveness / output-envelope /
     inert-without-ledger).
   - **Commit 2b-AUDIT — DONE (`5f7ef048` + refactor `36623383`):** the atomic scalar replace on the AUDIT
     host-dispatch path. `max_concurrent_agents` deleted; dispatch-quota schema v1alpha3 (`DISPATCH_QUOTA_V1ALPHA3`)
     carries an `admission` block (`granted_packet_ids` + `declared_cap` + `leases` + `explains`). New shared
     `admitBatch` (`src/shared/dispatch/admissionLoop.ts`) does **cost-first-capable** routing — each packet to
     the cheapest pool capable of it with budget+cap headroom, overflow spills to the next-cheapest (owner steer:
     multi-provider cost routing is native, not a bolt-on). `computeDispatchAdmission` single-sources the
     derivation (audit + remediate both call it). Producers `quotaPool.finalizeDispatchQuota` / `dispatch.ts` /
     `tierRouting.computeDispatchFanout` emit `granted_count`/`declared_cap`; consumers `semanticReviewStep` /
     `prompts.ts` / `steps.ts` render the granted-set prompt ("dispatch exactly `admission.granted_packet_ids`;
     re-invoke for the next grant"); `mergeAndIngest` reconciles the grant's leases (`createReservationLedger`,
     ledger path single-sourced, per-pid temp fallback when the quota dir is unset). In-process path passes
     `grantLeases:false` (engine leases per-packet — no double-count). Built to the pinned spec §"Host-path
     admission shape (2b build) — resolved". Tests updated: dispatch-fanout/features, schema-contracts,
     render-dispatch-review-prompt, seam-host-only-next-step, seam-dispatch-…-routing, next-step, exports-parity
     + NEW admission-loop test. Full audit+shared suites green.
   - **Commit 2b-REMEDIATE — NEXT, COUPLED TO DRIVER-UNIFICATION.** Same scalar replace for remediate
     (`RemediationDispatchQuota.max_concurrent_agents` → `admission`, v1alpha3; `buildDispatchQuota` +
     `prepareImplementDispatch` call `computeDispatchAdmission`; host prompt granted-set prose; reconcile at
     accept-node). BUT remediate's host rolling session (`rollingSession.ts` `prepareHostRollingDispatch` /
     `advanceHostRolling`) is a **continuous-refill** model — `slots` (the removed scalar) IS the concurrency
     width, and `advanceHostRolling` JIT-dispatches the next frontier node on each completion. Making it
     worktrees==granted-set (owner-confirmed) means removing the JIT-refill and re-granting per next-step —
     which reshapes the rolling lifecycle. `docs/backlog.md`'s **"Unify the two rolling-dispatch drivers"**
     forward track explicitly says do remediate's rework WITH the unification ("not restructured twice"), so
     land 2b-remediate + the driver-unification together as one arc. Wire the ledger into the unified driver
     with a real per-pool budget then (audit's in-process wrapper `runRollingDispatch` also still passes no
     ledger — the 2a capability is dormant at both call sites). NEW different-auditor-resume-no-inherit test
     belongs here / commit 3.
   - **Commit 3 — founding bug:** driver descriptor rides the continue-command; audit→`resolveHostProviderName`
     parity (`semanticReviewStep.ts`); include host pool in audit plan (`buildAuditSourcePools` parity with
     remediate `buildConfirmedPools`); demote `sessionConfig.provider` to headless in-process only. NEW
     different-auditor-resume-no-inherit test. (Detailed line-refs/scratch design captured mid-build; the spec
     is the durable source.)

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
