# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- **v0.32.42 published on npm as `latest`.** Per-lap shipped detail is NOT narrated here (changelog
  creep — see `git log` and project memory [[live-status]]); this section is current-state + open-work
  roadmap only.
- **Context-efficiency access-memory track — increments 1 + 2a + 2b + 2c + 2d + remediate-consumer SHIPPED (v0.32.42);
  items (1) AND (2) complete on BOTH orchestrators. Only item (3) remains.**
  - **Increment 1 (v0.32.38): prefix-ordering fix (#4)** — `buildPacketPrompt` static `## Output` prefix leads,
    volatile payload trails; tool-enforced guard. Cross-cutting cache-safety guard now real.
  - **Increment 2a (v0.32.39): persistence spine** — `access_memory.json`, first-class per-run audit artifact
    harvested from the ingested result ledger (`deriveAccessMemory`, `src/audit/orchestrator/accessMemory.ts`);
    DAG edge `→ audit_results.jsonl`; `run_id` stripped from hash.
  - **Increment 2b (v0.32.40): continuity scoring + packet-order bias** — `computeContinuityScores`
    (`src/audit/orchestrator/continuityScore.ts`): recency×frequency seed → deterministic personalized PageRank
    (α=0.85, fixed 20 iters) over the dependency graph → biases packet ORDERING (single-sourced
    `orderReviewPackets`, strictly below priority) at the load-bearing sorts (`buildReviewPacketsFromPartition` +
    `fitPacketsToTierBudgets`). Cache-safe (order/selection only). Adversarially reviewed; folded fixes: tier-refit
    re-sort (closed a pre-existing priority-monotonicity break), dropped an inert ordering thread, NaN guard.
  - **Increment 2c (v0.32.41): remediate-parity harvest** — the deterministic core is now single-sourced in
    `audit-tools/shared` (`deriveAccessMemoryFromEvents` over a normalized `AccessTouchEvent` stream); audit is a
    thin adapter (byte-identical). Remediate `deriveRemediationAccessMemory` (`src/remediate/state/accessMemory.ts`)
    populates `edited_count` from the declared edit surface of RESOLVED items (per-item `item_spec.touched_files`,
    block fallback), writing `.audit-tools/remediation/access_memory.json` from the merge under the state lock.
    Adversarially reviewed; fixes folded (resolved-only not `resolved_no_change`, per-item attribution, crash guard).
  - **Increment 2d (`path::symbol` slicing) — SHIPPED v0.32.42.** Sub-file targeted-read guidance in the
    isolated-large-file back-payload: the mechanical anchor scanner (`src/audit/orchestrator/fileAnchors.ts`) assigns
    each TOP-LEVEL (zero-indent) symbol an approximate body span (`FileAnchor.end_line`, bounded by the next top-level
    decl, clamped to the file's line count); `renderAnchorPreview` (`src/audit/cli/dispatch/packetPrompt.ts`) renders
    it as a `path:START-END` slice with advisory "read the span for your lens, expand if evidence crosses" guidance.
    Token lever: packets hand PATHS + workers self-read, so the win is cutting god-file re-reads
    ([[worktree-large-files-reread-loop]]), not packet bytes. Fail-safe (nested/indented bindings get no span),
    cache-safe (back-payload only), zero schema/validator change. Adversarially reviewed (6 vectors REFUTED).
  - **Remediate continuity CONSUMER + scorer single-sourced — SHIPPED v0.32.42.** Owner principle: auditor/remediator
    mirroring is common logic ([[auditor-remediator-mirroring-is-common-logic]]) — the consumer should have been shared
    from the start (as the 2c harvest core was), not audit-only. Scorer EXTRACTED to `audit-tools/shared`:
    `computeContinuityScores` + new single-sourced `continuityMassForPaths` (`src/shared/continuityScore.ts`) + graph
    primitives `normalizeGraphPath`/`collectGraphEdges` (`src/shared/graph/graphPaths.ts`); audit re-exports all four
    (28+6 import sites + 2b behaviour byte-identical). Remediate consumer (`readRemediationAccessMemory` +
    `computeBlockContinuityScores`, `src/remediate/state/accessMemory.ts`) reduces `access_memory.json` to a per-block
    mass (seed-only — remediate has NO graph), threaded via `DriveRollingDispatchOptions.continuityScores` → `toNode`
    → shared `ownershipSubWaves` (`OwnershipSchedulerNode.continuity?` = secondary sort key below file-disjointness,
    above `block_id`; no-op default). Adversarially reviewed (6 vectors A–F REFUTED).
  - **Still open on the track (the immediate next item):**
    - **(B) #3 — token-efficiency eval harness (measure first):** the measurement gate confirming 2b's ordering bias,
      2d's slice guidance, AND the remediate consumer actually cut tokens *without busting prefix cache*. Cost
      counterpart to the A2 quality oracle; reads recorded run ledgers/headroom telemetry (post-hoc, allowed), reuses
      the A2 corpus. The "MEASURE not assert" discipline the track's own cross-cutting guard calls for. **The only
      remaining track item — recommended next.**
    Design-of-record [[access-memory-layer-design]]; full track detail `docs/backlog.md:406`. Loop-core → full
    adversarial pipeline.
- **Quota-arbitrage tier Phase-0 opencode-free — CODE-COMPLETE (A2 = increment 1 + increment 2, shipped 2026-07-08,
  released v0.32.36).** ([[arbitrage-dispatch-tier-design]]; `docs/backlog.md` → Forward tracks.) Increment 1
  (a-priori declared per-source cost → free-first ordering, `6349bdc5`) + increment 2 (reactive cost verification:
  demote a declared-free pool that reports cost>0 + `declared_cost_drift` friction, `65ace2c1`) both landed. The
  only remaining Phase-0 work is **env-bound live validations** (a real opencode-free run confirming declared-free
  routing + a live lapsed-free demotion + the friction event) — owner runs these. vertex-trial deferred (needs a
  GCP $300-trial SA). Other standing env-bound validations: quota pre-wall pacing, friction escalation,
  selective-deepening convergence, clippy/rubocop live spawn.
- **Session-config validation is now single-sourced across both orchestrators (v0.32.37).** The full field
  validator `validateSessionConfig` moved to `audit-tools/shared`; remediate's `session-config.json` reads route
  through a shared `readValidatedSessionConfig` load-boundary helper, so a malformed config fails loud in remediate
  too (was a silent degrade — the closed parity gap). **Deliberate behavior change:** a remediate run with a
  technically-invalid config (e.g. `timeout_ms: 0`) now throws at load instead of silently ignoring it — this is
  remediate conforming to the shared config contract audit has always enforced, not a new contract.
- **Cost↔speed dial residuals — ALL CLOSED 2026-07-08 (owner):** the `/models` concurrency probe is
  DROPPED (owner: concurrency is an almost-irrelevant primitive — stop hunting for a concurrency value;
  use a handed signal if one arrives, never go looking; [[concurrency-is-declared-or-absent-never-learned]]);
  B2 host-reorder is CLOSED (the shipped provider `exclude`/`include` + `cost_order` IS the capability);
  dead `buildProviderConfirmationDisplay` (D-71) deleted. Dial itself code-complete + reviewed — nothing open.
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
- **Open items** (all in `docs/backlog.md`): the free-pool / quota-arbitrage forward track; the
  context-efficiency track (items (1)+(2) SHIPPED v0.32.42 — **only item (3) token-efficiency eval harness
  remains, the recommended next item**); env-bound live validations (quota pre-wall pacing, friction escalation,
  selective-deepening convergence, clippy/rubocop live spawn); provider-blocked schema CE-004 residual (claude-code
  host only — the NIM guided-decoding path shipped).
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
