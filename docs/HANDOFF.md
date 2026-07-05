# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` at **v0.32.8**. Per-lap shipped detail is NOT narrated here (changelog creep — see
  `git log` and project memory [[live-status]]); this section is current-state + open-work roadmap only.
- **Immediate next: Dispatch admission-control rework — commit 1/3 shipped, commit 2 next.** Owner resolved
  the spec's Open tensions + sharpened framing (2026-07-04): full proactive reservation ledger; concurrency
  is not a computed quantity (budget-gated admission; only a declared env hard-cap like Codex 6 is explicit).
  Substrate shipped (`5e0a4479`); **commit 2 = the atomic replace** (wire ledger into the rolling engine as
  shared in-flight accounting + remove the `max_concurrent_agents` scalar from the host-dispatch path + grant
  the admitted set). Full three-commit plan + line-refs in T5.3 below. The prior "owner running the paused
  self-audit" note is void — that audit errored out and its partial results were manually finalized.
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
3. **Dispatch admission-control rework — 🔨 ACCEPTED, building (commit 1/3 shipped).** Design of record:
   [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md) (owner-resolved
   *Resolved decisions* + sharpened framing: **concurrency is not a computed quantity** — admit on budget
   headroom; the only explicit cap is a declared env hard-limit e.g. Codex 6). [[dispatch-admission-control-design]].
   Three-commit atomic sequence:
   - **Commit 1 — DONE (`5e0a4479`):** additive substrate — `ReservationLedger`
     (`src/shared/quota/reservationLedger.ts`, ClaimRegistry pattern generalized to token leases),
     output-envelope `estimatePacketCost` (`src/shared/quota/packetCost.ts`), `output_per_input` ratio EWMA
     (`state.ts`/`types.ts`). 34 tests. No dispatch wiring.
   - **Commit 2 — NEXT (the atomic replace):** the in-process rolling engine is *already* emergent
     (`src/shared/dispatch/rollingDispatch.ts` header: "No max_concurrent in the public API") — wire the
     `ReservationLedger` in as **shared cross-process/account in-flight accounting** (lease at
     `dispatchOnePacket`, reconcile at `handleResult`; augment `selectProvider` in-flight to include ledger
     outstanding). The `max_concurrent_agents` scalar lives in the **host-dispatch prompt path** — remove it
     (schema `audit/quota/index.ts` v1alpha2→v1alpha3; producers `quotaPool.ts:278`/`tierRouting.ts:159`/
     `dispatch.ts:574`; consumers `semanticReviewStep.ts:125`/remediate `nextStep.ts:279`/`prompts.ts:81-83`)
     and instead have the tool **grant the admitted set** (leases at grant, reconcile at result-ingest); the
     granted set is the admission width. Add per-admission explain records. Packet `estimatedTokens` becomes
     the output-envelope cost at packetization. **Note:** ratio-learning is dormant on the claude-code host
     path (no actual-usage return); declared-cap envelope is the operative behavior there — active only where
     a provider reports usage (NIM/openai-compatible). Update `capacity`/`rollingDispatch`/`quota-scheduler`/
     `seam-host-only-next-step`/`rolling-audit-dispatch`/`quota-command` tests + NEW co-located double-run
     overshoot test. Ships atomically (scalar deletion + replacement together).
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
