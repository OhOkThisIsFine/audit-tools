# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.32.13** (models.dev W1 static-metadata resolver → real per-model context window).
  Per-lap shipped detail is NOT narrated here (changelog creep — see `git log` and project memory
  [[live-status]]); this section is current-state + open-work roadmap only.
- **Dispatch admission-control rework — ✅ COMPLETE (founding bug + defect-1, 2026-07-05).** The whole
  rework shipped end-to-end. Founding capability-inheritance bug (commit 3): host-review pool keyed to the
  driver via `resolveHostDispatchProviderName`; `HostDispatchDescriptor` rides every continue-command.
  **Defect-1 (host + codex + NIM CONCURRENT fan-out)** now shipped too: an attended host
  (`host_can_dispatch_subagents` default true) DEMOTES a configured in-process backend to a *source* pool so
  host + backend + NIM fan out concurrently; the in-process whole-frontier driver fires only when headless.
  Discriminator reuses the existing boolean (no new field). Both orchestrators gated in parity;
  `buildConfirmedPools` decouples host-pool identity (claude-code when demoting) from the source provider.
  Sub-2: `selectProvider` least-loaded tiebreak balances equal-rank pools. Sub-3: single-shot NIM
  output-contract override + read-neutral file framing + operator-tunable inline caps.
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]].
- **Immediate next: models.dev resolver W2 (real price → `costRank`).** **W1 (real context window) shipped this lap** —
  `resolveModelStatics` + vendored models.dev snapshot (`src/shared/quota/modelStatics.ts`, `src/shared/data/…`,
  `npm run update-models`) wired as a `static_metadata` rung in `resolveLimits` below discovery/config, above the
  conservative default; the `32_000`/`4_096` default-collapse prereq is done. Next-ready is **W2**: feed models.dev
  per-token price into `costRank` at the two build sites (`audit/cli/dispatch/quotaPool.ts:307`,
  `remediate/steps/dispatch.ts:515`) so "cheapest capable pool" = actual dollars. **Two W1 caveats to carry into W2**
  (detail in `docs/backlog.md` → Forward tracks): collision resolution is first-sorted-provider-wins (fine for context,
  but W2 price must prefer native/cheapest); and a static window can over-state a specific deployment (mitigated by
  discovery-override + 0.7 safety margin, watch on a real headless run). Rethink verdict stands: core dispatch/quota is
  sound + ahead of the field, NO big simplification exists, AI-SDK transport swap dropped as net-negative. Other
  standing T5 options unchanged: deterministic-analyzer live spawn, CE-004 NIM guided-decoding.
  **Residual on dispatch (env-bound / deeper, in `docs/backlog.md`):**
  (a) live validation of a real host+codex+NIM concurrent metered run; (b) deeper *within-turn* simultaneity
  (the audit hybrid path alternates in-process partition then host review ACROSS turns, not simultaneously
  within one — a detached background driver is architectural, pursue only if a real run shows the alternation
  is the bottleneck); (c) durable routing lesson: codex CLI is a poor fit for large read-heavy audit packets.
  **Also open:** the token-budget ledger path is live-validated only on a metered run (`docs/backlog.md`
  quota-aware dispatch, env-bound).
- **⚠️ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main` before
  starting a lap — this worktree branched behind main and had to fast-forward + re-read HANDOFF/backlog.
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
0. **Multi-provider routing rethink outcome (2026-07-05).** Verdict: core is sound + ahead of field, no big
   simplification, AI-SDK swap dropped. (a) `scheduleWave` quota-off **drift bug** — ✅ SHIPPED (remediate delegates
   to shared `scheduleWave`). (b) `rollingEngine.ts` **dead module** — ✅ DELETED (~268 LOC). (c) **models.dev
   static-metadata resolver**: W1 real context window (`resolveModelStatics` → `static_metadata` rung in
   `resolveLimits`, vendored snapshot + `npm run update-models`) — ✅ SHIPPED; **W2 real price → `costRank`** (true $
   cost-first routing, aligns with autonomy capstone) — NEXT-READY. Full detail + line refs in
   `docs/backlog.md` → *Forward tracks*. *([[provider-routing-offload-b-to-ai-sdk]])*
1. **Deterministic analyzers — own-vs-acquire acquisition engine.** Open: clippy/rubocop live spawn
   unvalidated (no Rust/Ruby repo here). *([[deterministic-analyzers-own-vs-acquire]])*
2. **Schema-enforced generation — CE-004 residual.** Provider-blocked (always-on host has no constraint
   endpoint); the openai-compatible/NIM guided-decoding path is the build lever.
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
