# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- **Current: ~v0.32.44 (backlog-clearance lap, shipping now).** Per-lap shipped detail is NOT narrated here
  (changelog creep — see `git log` + project memory [[live-status]]); this section is current-state + open-work
  roadmap only. Authoritative version = `package.json`.
- **This lap closed the remaining code-fixable backlog + two of four owner-picked design tracks.** Shipped
  (detail in `git log` / [[loop-core-enforcement-layer]]): the per-node loop-core cross-file GUARD + shared
  `LOOP_CORE_PATTERNS` + the pre-commit adversarial GATE (tree-bound attestation); **D-68** leanFastPath folded
  into the risk dial (parallel `evaluateFastPath` classifier deleted); INV-WH scanner hermeticity fix; and a
  PRE-EXISTING fail-open fix (the pre-commit gate's scratch index under `.git` failed open in every linked
  worktree). **D-69** assessed — its substance is already shipped (friction 3-layer enforcement + D-68's
  risk-tiering); residue is host-inherent / owner-deferred (see `docs/backlog.md`).
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

**▶ IMMEDIATE NEXT — D-66/67 unify the rolling-dispatch lifecycle shell (FOCUSED-LAP track).** The last
open design forward-track; the 2026-07-09 recon captured the design-of-record in `docs/backlog.md` +
[[rolling-lifecycle-unify-full-unification-wrong]]. **Read it before building — it overturns the naive
framing: full unification is the WRONG endpoint** (audit vs remediate pause semantics genuinely diverge).
Bounded shareable core = a pause-state reducer with the terminal-policy branch injected + a merge-time
ownership-gate on the long-lived claims; recommended slice-1 = the merge-time ownership-gate alone (no
heartbeat machinery). It is the most delicate machinery in the repo (pause/claim/quota) — do NOT rush it;
the owner's "redesign before scheduled autonomy" caution applies.

**Also open (2026-07-09 external-audit triage):** a validated defect cluster **V1–V7** (verification-report
contract break, close-phase staging sweep, OpenCode permission parity, quoting hardening, path-sourcing
sweep, co-change cap, one dead test) in `docs/backlog.md` → *Open bugs* — V1/V3/V6/V7 are lean-tier,
V2 touches close-phase behavior (full pipeline); plus a **shared-logic dedup bundle** forward track
(Tier B mechanical sweep + Tier C obligation-engine adoption) in `docs/backlog.md` → *Forward tracks*.
These are code-fixable and can slot before or alongside D-66/67 at owner preference. Everything else open
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
