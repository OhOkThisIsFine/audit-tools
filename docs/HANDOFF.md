# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.32.8**. Per-lap shipped detail is NOT narrated here (changelog creep — see
  `git log` and project memory [[live-status]]); this section is current-state + open-work roadmap only.
- **Immediate next: Dispatch admission-control — commit 3 (the founding bug).** 2a + 2b-AUDIT +
  2b-REMEDIATE + the rolling-driver unification are all shipped (see `git log`; the admission model —
  concurrency is not a computed quantity, budget-gated admission, only a declared env hard-cap like Codex 6
  is explicit — is fully in place on both orchestrators' in-process paths, and the two forked in-process
  drivers are now one shared `driveRolling`). **Commit 3 = the founding capability-inheritance bug**
  ([[capability-is-per-auditor-not-per-audit]], full detail `docs/backlog.md`): a flagless resume by a
  *different* auditor still sizes/charges against the run's *original* provider. Scope: driver descriptor
  rides the returned continue-command (survives its own steps without the host re-appending flags); audit
  reaches `resolveHostProviderName` parity (`semanticReviewStep.ts` still uses raw `sessionConfig.provider`);
  include the host pool in the audit dispatch plan (`buildAuditSourcePools` parity with remediate
  `buildConfirmedPools`); demote `sessionConfig.provider` to the headless in-process pool only. Lands the
  NEW **different-auditor-resume-no-inherit** test (its regression guard, deferred out of C4). **Also then**
  the audit in-process wrapper `runRollingDispatch` + remediate's real per-pool budget: both now wire the
  ledger only when a pool reports a *finite* budget (metered provider); the token-budget path is live-
  validated only on a metered run (`docs/backlog.md` quota-aware dispatch, env-bound).
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
1. **Deterministic analyzers — own-vs-acquire acquisition engine.** Open: clippy/rubocop live spawn
   unvalidated (no Rust/Ruby repo here). *([[deterministic-analyzers-own-vs-acquire]])*
2. **Schema-enforced generation — CE-004 residual.** Provider-blocked (always-on host has no constraint
   endpoint); the openai-compatible/NIM guided-decoding path is the build lever.
3. **Dispatch admission-control rework — 🔨 commit 3 remaining (1 + 2a + 2b-AUDIT + 2b-REMEDIATE +
   driver-unification all shipped).** Design of record:
   [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md) (**concurrency is
   not a computed quantity** — admit on budget headroom; the only explicit cap is a declared env hard-limit
   e.g. Codex 6). [[dispatch-admission-control-design]]. The admission model is fully in place on both
   orchestrators' host + in-process paths, and the two forked in-process rolling drivers are now one shared
   `driveRolling` ([[dissolve-auditor-remediator-distinction]]). **Only commit 3 (the founding bug) is open:**
   - **Commit 3 — founding bug** ([[capability-is-per-auditor-not-per-audit]]): a flagless resume by a
     *different* auditor still sizes/charges against the run's original provider. Driver descriptor rides the
     returned continue-command; audit→`resolveHostProviderName` parity (`semanticReviewStep.ts` still uses raw
     `sessionConfig.provider`); include the host pool in the audit dispatch plan (`buildAuditSourcePools`
     parity with remediate `buildConfirmedPools`); demote `sessionConfig.provider` to the headless in-process
     pool only. Lands the NEW **different-auditor-resume-no-inherit** test (deferred out of C4 — it tests
     commit-3 behaviour). Full per-item detail + line-refs in `docs/backlog.md`; the spec is the durable source.

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
