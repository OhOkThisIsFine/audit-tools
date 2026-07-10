# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- **Current version = `package.json`** (authoritative). Per-lap shipped detail is NOT narrated here
  (changelog creep — see `git log` + project memory [[live-status]]); this section is current-state +
  open-work roadmap only.
- **Host-path quota enforcement track (started this lap).** The conversation-first host-dispatch path
  bypassed the tool's reactive quota enforcement; recon + adversarial review found the real gaps.
  **Increment A SHIPPED:** the cold-start over-grant fix (host grant was unbounded on wave 1 — now
  clamped to the calibration batch via a per-pool `calibrating` flag through admission) + audit
  blind-dispatch loud-degrade parity (single-sourced with remediate). **Open:** Increment B
  (pause-at-wall step producer on the host path) + the host-path lease-TTL fix — see the
  "Host-dispatch path quota enforcement" entry in `docs/backlog.md`.
- **Local env note:** the box now runs npm 12.0.0 — it blocks dependency install scripts by default
  and can emit object-shaped `npm pack --json`; smokes are fixed, but see `docs/backlog.md` → Durable
  traps before any manual `npm install -g` / packaged-install work.
- **Standing state (all in `docs/backlog.md`):** context-efficiency access-memory track COMPLETE (items 1/2/3
  shipped); quota-arbitrage Phase-0 opencode-free CODE-COMPLETE (env-bound live validations remain);
  cost↔speed dial + dispatch admission-control shipped (env-bound / deeper residuals only); session-config
  validation single-sourced (v0.32.37).
- **⚠️ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main` before
  starting a lap — a worktree can branch behind main and must fast-forward + re-read HANDOFF/backlog first.
- the owner runs live/rate-limited/deepening-capable runs routinely and reports back — this doc does not
  carry "needs live validation" reminders for code that's otherwise complete; treat anything below as
  code-complete unless it says otherwise.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). This is the *host workaround* until the self-scaling pipeline makes it the tool's own job
  (tool-enforcement target now tracked as a forward-track in `docs/backlog.md`).
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

**▶ IMMEDIATE NEXT — Quota host-path enforcement, Increment B (pause-at-wall step producer).** FOCUSED,
delicate lap. When the host-dispatch admission grants zero at the wall (`granted.length===0` OR an
active `cooldown_until` — F1: cooldown-active leaves budget null→+Infinity, a real host-path hole), the
host branch must emit each orchestrator's OWN resumable pause step. Re-scoped by the Increment-A review:
this is a NEW snapshot→paused-state/terminal producer per orchestrator (audit `RollingEngineLifecycleState`
/`paused_state` advancing `pause_count`; remediate `partial_completion_terminal{earliest_reset_at}`) —
neither exists on the host branch today. Do NOT unify the two terminals
([[rolling-lifecycle-unify-full-unification-wrong]]). **Spec the resumability contract before coding**
(matches the "don't rush pause/claim/quota" caution). Also open: host-path lease-TTL (wave-length
`leaseTtlMs`). Full detail in `docs/backlog.md` → "Host-dispatch path quota enforcement".

**▷ THEN — D-66/67 slice-3** (heartbeat / merge-time ownership-gate CHECK on the LONG-lived
execution claims — `task-claims.json` 20-min lease, remediate node-claims — which today hold a lease
with no live heartbeat; FOCUSED-LAP, delicate, and **live-run-gated** — only pursue if a real
cooperative run shows the staleMs-wide probe window from slice-1 actually bites). Fold the `phase:main`
layer-2 asymmetry (slice-1 input) into its design. See the D-66/67 roadmap entry in `docs/backlog.md`.

**D-66/67 slice-1 SHIPPED, slice-2 VERIFIED-CLOSED (not worth building).** Design-of-record + residuals in
`docs/backlog.md` → "Unify the full rolling-dispatch lifecycle shell"; [[rolling-lifecycle-unify-full-unification-wrong]]
still governs (full unification is the WRONG endpoint). Only slice-3 (above) remains open.

**External-audit program SHIPPED in full** (V1–V7 + dedup bundle); only low-severity documented residuals
remain (`docs/backlog.md` → *Open bugs*, "External shared-logic audit … residuals"). Everything else open
is env-bound live validation (owner-run) or T6 deferred.

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work, and is the "redesign before scheduled autonomy" the north star requires
([[autonomous-pipeline-capstone-spec]]). Loop-infra (T1–T3) is COMPLETE end-to-end — nothing open on
those tracks. **This lap (2026-07-09) closed the remaining T5 loop-safety tooling: the per-node loop-core
cross-file guard, the pre-commit adversarial gate, and the D-68 leanFastPath→dial fold; D-69 assessed as
already-shipped.** Remaining sequencing: D-66/67 (above) → deferred (T6).

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
-1. **Conceptual + systemic-adversarial design review — ✅ COMPLETE (all five phases).** Design of record
   [`spec/conceptual-design-review-design.md`](../spec/conceptual-design-review-design.md);
   [[conceptual-design-review-design]]. Nothing open.
0. **Multi-provider routing rethink — ✅ COMPLETE.** Core sound; AI-SDK swap dropped; cost-first routing +
   Gate-0 confirmation all shipped. Design of record [`spec/cost-first-routing.md`](../spec/cost-first-routing.md);
   [[provider-routing-offload-b-to-ai-sdk]]. Nothing open.
1. **Deterministic analyzers — own-vs-acquire acquisition engine.** Open: clippy/rubocop live spawn
   unvalidated (no Rust/Ruby repo here). *([[deterministic-analyzers-own-vs-acquire]])*
2. **Schema-enforced generation — CE-004 residual.** Guided-decoding path SHIPPED; open residual = the
   always-on claude-code host stays repair-floor (no API-level constraint endpoint — provider-blocked, not a
   defect). Detail in `docs/backlog.md`.
3. **Dispatch admission-control rework — ✅ COMPLETE (founding bug + defect-1).** Design of record
   [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md);
   [[dispatch-admission-control-design]]. Open residual = env-bound live validation + deeper within-turn
   simultaneity (both in `docs/backlog.md` → dispatch admission-control rework).

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
