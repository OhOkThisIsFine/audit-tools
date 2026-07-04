# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.32.6**. Per-lap shipped detail is NOT narrated here (changelog creep — see
  `git log` and project memory [[live-status]]); this section is the current-state + open-work roadmap only.
- **Immediate next:** (1) the owner is running the paused audit-tools self-audit to completion in a fresh
  conversation — note it will dispatch at the codex-pinned concurrency until the dispatch rework lands.
  (2) **Dispatch admission-control rework** — design of record captured at
  [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md) (status: proposed).
  Resolve its *Open tensions* (esp. output-token unknowability; ledger-is-a-proxy / possibly over-built vs
  reactive-only) **before** building. See T5.3 below.
- Staleness-churn fix (path-sort `repo_manifest.files`) committed + pushed to `main` 2026-07-03, **not yet
  published** (batch with the dispatch rework rather than cut a release for one `sort()`).
- **Open items** (all in `docs/backlog.md`): env-bound live validations (quota pre-wall pacing, friction
  escalation, selective-deepening convergence, multi-IDE cooperative runs, clippy/rubocop live spawn);
  provider-blocked schema CE-004.
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

### T1 — Self-scaling pipeline — ✅ COMPLETE
Design of record: [`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md)
([[self-scaling-pipeline-not-forked-paths]]). Nothing open on this track.

### T2 — Make the loop converge & safe — ✅ COMPLETE
Repair-cap/convergence-termination, friction detection wiring, and the quarantine-on-fail-loud data-loss
fix are all shipped. Nothing open on this track.

### T3 — Headline product capability — ✅ COMPLETE
Remediator auto-phasing (derivation + persistence + ordinal threading + scheduler barrier + per-phase
boundary gate) is fully shipped end-to-end. Nothing open on this track.

### T4 — Remaining host-friction inventory
Nothing open. All A/B/C/D items shipped (contract-pipeline host-friction inventory, phase-cut, boundary
gates, merge-to-base). Selective-deepening convergence (both known loops) has a shipped code fix; live
validation on a real deepening-capable run remains env-bound (T6-class).

### T5 — Product / analysis forward tracks
1. **Deterministic analyzers — own-vs-acquire acquisition engine.** Git-history mining, gitleaks, jscpd,
   osv-scanner, clippy (cargo), rubocop (bundle), hadolint + actionlint (binary), type-coverage (npx),
   and knip (whole-file + unused-dependency + unused-export dead-code leads) are all registered.
   **Open:** clippy/rubocop landed fixture-only (no Rust/Ruby repo here → live spawn unvalidated).
   *([[deterministic-analyzers-own-vs-acquire]])*
2. **Schema-enforced generation — CE-004 residual (env-bound only).** Sole residual: the always-on
   conversation host advertises no API-level constraint mechanism (provider-blocked).
3. **Dispatch admission-control rework — 🟡 DESIGN PROPOSED, not built.** Design of record:
   [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md)
   ([[dispatch-admission-control-design]], [[capability-is-per-auditor-not-per-audit]]). Root: dispatch
   capability/quota is inherited from the run's original auditor, and `concurrency` is the wrong primitive.
   Target: admit one task at a time on a live per-pool token budget (concurrency emergent); per-invocation
   self-describing pool descriptors; shared account-keyed reservation ledger. **Loop-core change → full
   pipeline.** Blocked on resolving the spec's *Open tensions* first (output-token unknowability;
   proxy-vs-meter / over-built vs reactive-only). Staleness-churn precursor fix already shipped to `main`.

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
