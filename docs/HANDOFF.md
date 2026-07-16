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
- **The maximal-coverage validation run's dispatch/quota fix cluster shipped in the current release.**
  All major code tracks remain complete (see Track status below). Next is the bounded forward remainder
  below + a confirming re-run.
- **repair-proxy dispatch integration — SUPERSEDED (the source-pool model was wrong); reworking to the
  unified worker model.** The owner-attended dogfood ran 2026-07-15 and proved the integration is the wrong
  abstraction: a host-driven `/audit-code` planned 430 tasks and dispatched **zero** (repair-proxy sources
  failed on a missing key the loopback proxy doesn't need; audit packets exceeded the single-shot inline
  caps; the host review path then walled at 56%). Root: repair-proxy is NOT a cost-ranked source pool — it is
  a loopback Anthropic `/v1/messages` **tool-repair transport** for agentic claude-harness workers (owner-
  confirmed). New **design of record: [`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md)**
  (ONE core, three worker KINDS; repair-proxy = kind-1 launch-transport; per-auditor handshake inventory;
  retire the source-pool wiring). The old `spec/repair-proxy-dispatch-integration.md` is retired with the code.
  Memory [[unified-dispatch-worker-model]]. **▶ Next = the decomposition in the new spec** (retire source-pool
  wiring → move inventory to the handshake → wire repair-proxy as a kind-1 transport → fix C cold-start wall);
  each a loop-core commit (green + attestation). Full dogfood findings: `docs/backlog.md` → "Live dogfood:
  BOTH dispatch paths failed".
- **Env cruft (harmless):** two empty git-deregistered worktree dirs (`.claude/worktrees/beautiful-euclid-1514e9`,
  and in repair-proxy `repair-proxy-tool-calls-7e075d`) are held by a stale Windows handle — gitignored,
  inert, clear on reboot. Also: `INV-shared-core-14` fails in this shell but identically on `main`
  (pre-existing, env-sensitive, spawned as a separate task) — not this branch's doing.
- **Local env note:** the box runs npm 12.0.0 — it blocks dependency install scripts by default and can
  emit object-shaped `npm pack --json`; smokes are fixed, but see `docs/backlog.md` → Durable traps
  before any manual `npm install -g` / packaged-install work.
- **⚠️ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main` before
  starting a lap — a worktree can branch behind main and must fast-forward + re-read HANDOFF/backlog first.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). **Tool-enforced**, not a host workaround: the lean path is taken automatically when the
  effective risk tier is `low` via the risk-tier → Dial A/B continuum fold (`findingRiskEvidence` in
  `src/remediate/riskSignal.ts`); accepted residue in `docs/backlog.md`.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`.
  **Mechanically backstopped**: step-boundary capture + an in-run blocking per-category close-out gate +
  a session-end Stop-hook (`.claude/hooks/friction-stop-gate.mjs`); accepted residue (hand-fix laps that
  never invoke an orchestrator) in `docs/backlog.md`.
- **Release:** `npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump.
  Run `npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
  CI gate is split for speed: `verify:release` = `verify:checks` (cheap deterministic chain) + vitest;
  `ci.yml` runs the cheap chain only, `audit-code-test-suite.yml` owns the vitest suite once per Node line
  (20 + 22, each sharded 4 ways) with a release-bump skip guard, and `publish-package.yml` runs the
  authoritative release-time gate (`verify:checks` + a 4-way sharded vitest matrix). vitest was ~93% of the
  old serial gate → sharding is the only lever that moved release latency. No open per-push redundancy.
- **Branch-strand trap (bit twice already):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code
  implement node** — the tool's dispatch plan already names the correct worktree; a second isolation
  worktree strands the subagent's edits where `accept-node` can't see them. See backlog → durable traps.

---

## ▶ IMMEDIATE NEXT — the unified-dispatch-worker-model rework (IN PROGRESS)

Design of record: **[`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md)**
→ "Greenfield endpoint (owner-approved 2026-07-16)" + Decomposition (memory
[[unified-dispatch-worker-model]]). A 3-person independent design panel (greenfield mandate) converged
unanimously; **owner approved the greenfield endpoint** — full synthesis in
[`docs/reviews/dispatch-inventory-greenfield-design-2026-07-16.md`](../docs/reviews/dispatch-inventory-greenfield-design-2026-07-16.md).

**The two "open decisions" are RESOLVED (they were one cut — INTENT vs CAPABILITY):**
- **confirmed_provider_pool → SPLIT:** persist the operator's route DECISION (exclusions + cost order +
  confirmed flag) as intent; re-resolve the concrete pool per-auditor + apply the decision as a filter;
  reconciliation on a newly-reachable backend is `autonomous_mode`-keyed (attended → prompt the delta;
  autonomous → fail-closed-exclude + friction).
- **quota/block_quota → SPLIT** by "asserts capability vs asserts policy": windows/host_model/subagent-
  limit/per-source-quota = capability (handshake, never persist); safety_margin/thresholds/λ = policy
  (repo); learned rpm/tpm = the account-keyed ledger (not config).

**Shipped:** commit 1 (`f5bca305`, retire the source-pool integration, reviewed+attested) + 2a-i
(`c167fbee`, additive `--host-inventory` channel) + **2a-ii (`605d8a0a`, switch dispatch consumers to
READ the handshake via `applyDispatchInventory` — loop-core, reviewed+attested; the correct RUNTIME
overlay but a transitional half-measure — the repo still HAS the dispatch slots)** + **G1 (`e7b593ac`,
collapse the `--host-*` flag-bag into ONE `--auditor <json>` `AuditorDescriptor`; independent-reviewed,
full-suite green, NO release — inert intermediate; NOT loop-core by path so no attestation).** Inert until
the host loaders emit inventory (no host does yet → today's behavior byte-for-byte).

**⚠ G1 is a BREAKING transport change, unreleased.** `--host-*` capability flags are GONE from the audit
CLI (only `--host-provider` / `--host-model` remain). The canonical + derived host assets already emit
`--auditor`, but the installed GLOBAL bins still emit the old flags — a stale host dogfooding G1 would have
its handshake SILENTLY IGNORED (unknown flags → defaults). Harmless until the next release picks it up;
just don't dogfding G1 via a stale global bin without reinstalling.

**Greenfield build sequence (each loop-core: green + independent review + attest):**
- **G1 — ✅ SHIPPED (`e7b593ac`).** Scope was larger than the plan documented: `prepare-dispatch` + `quota`
  (both live subcommands) also read the handshake directly and were converted; `--host-model` was NOT dead
  (two callers) and is retained. `getAuditorDescriptor` re-validates each `self` field to the retired
  parsers' exact strictness (roster via shared `parseHostModelRoster` — a review-caught drop). Plan doc:
  [`docs/reviews/g1-auditor-descriptor-plan-2026-07-16.md`](../docs/reviews/g1-auditor-descriptor-plan-2026-07-16.md).
- **G2 (IMMEDIATE NEXT — PLANNED + ADVERSARIALLY REVIEWED + owner-approved; ready to BUILD).** Plan:
  [`docs/reviews/g2-repo-session-intent-plan-2026-07-16.md`](reviews/g2-repo-session-intent-plan-2026-07-16.md).
  Split the persisted type (`RepoSessionIntent`, no dispatch INVENTORY fields; `resolve(intent, descriptor)`
  produces the in-memory EFFECTIVE `SessionConfig`) + fold `provider` into `descriptor.self` + retire
  `persistHostProvider` (`semanticReviewStep` resolves from the descriptor, no disk re-read). **Owner steer:
  ideal code / no backcompat.** Two decisions locked: **(a) Path A** — bundle the deterministic
  source-emitter INTO G2 as ONE atomic commit (so operator multi-pool never goes dark); **(b)** the emitter
  reads the spec-mandated per-auditor home-dir **identity-keyed** declaration → `declared ∩
  ambient-verifiable` → `--auditor sources[]` (NOT an env-file; NOT host-LLM prose — that's the banned
  host-discretion anti-pattern). **Review found 2 blockers now folded into the plan:** the emitter must be a
  DETERMINISTIC component the slash loader shells out to (Q2); and "unrepresentable" requires the SHARED
  validator (`src/shared/validation/sessionConfig.ts:494-604`) + remediate's `readValidatedSessionConfig`
  read-path to reject/strip dispatch keys too — not just the audit-store TS types (Q4). Honest scope: G2 is a
  **half-type** milestone (`confirmed_provider_pool`/`quota`/`block_quota`/`host_can_dispatch` remain →
  G3/G4/G5). Recon in plan: ~110 read sites / ~45 fns, most read the EFFECTIVE config (small migration
  surface — 4 non-overlaying `loadSessionConfig` sites → `resolve()`). Inert like G1 (no release) until host
  loaders emit inventory; update this launch recipe once the emitter lands.
- **G3** split confirmed_provider_pool (policy on intent + re-resolved reach + autonomous-keyed reconciliation
  + pin the exclusion-key grammar, default `provider:model`).
- **G4** split quota/block_quota (may fold into G2). **G5** never-inherit enforcement (auditor-id stamp +
  `declared ∩ ambient-verifiable` reach + lies-reachably quarantine). **G6** remediate `--auditor` round-trip.
- Orthogonal (retained): **commit 3** repair-proxy as a kind-1 launch-transport; **commit 4** fix C (host
  cold-start wall — needs a clean minimal repro first); **commit 5** decide kind-3's fate.

**Quota / offload (as of G1 session):** the free `llm read` lane is BACK (used for G1 recon at zero
Claude-read cost — the earlier "endpoint times out/returns empty" note was stale). `llm write`/NIM
completion + `ANTHROPIC_BASE_URL` subagent-fronting were NOT retested. G1's mechanical bulk (5 test-file
conversions, asset regen) was offloaded to **Haiku subagents** (parent Opus orchestrates + verifies green
+ independent review) — the working pattern when the free write-lane is uncertain. NOTE: a Haiku agent
weakened one test (malformed-roster assertion → incidental TypeError); ALWAYS review offloaded test diffs
for assertion quality, not just green. Fastest full unblock still = owner points `ANTHROPIC_BASE_URL` at a
running repair-proxy backed by a free model.

## Older track — bounded quota-cluster remainder (secondary, not blocking the rework)

1. **Low residuals:** doc-review auto-apply re-asserting a resolved decision after a process restart; the
   two A2b residuals; untracked-exclusion residuals (a–e). All in `docs/backlog.md` → Open bugs.

_(openai-compatible content-inlining + unroutable guard — SHIPPED v0.32.68. Root cause was NOT the
`include_referenced_files` default (already on); the provider only ever inlined by scavenging path tokens
from rendered PROSE, and prompts are authored paths-only for tool-using hosts → a single-shot NIM worker
got no content, fabricated empty, was dropped. Fix: `LaunchFreshSessionInput.referencedFiles` (authoritative
repo-relative granted read set) inlined deterministically + a refuse-to-dispatch guard when a granted file
can't be inlined. Audit feeds a new repo-relative `DispatchPlanEntry.file_paths` (NOT the absolute
`access.read_paths` host-grant — adversarial-review-caught HIGH). Remediate feeds `access.read_paths`.
[[openai-compatible-content-inlining]].)_

_(Item C — host fan-out quota gate — SHIPPED v0.32.66: `gateHostFanout` + budget-only `fanoutMode` +
bounded livelock→skip. Item D — empty_grant binding-window reset + progress-aware livelock — SHIPPED
v0.32.67: `detectHostDispatchWall` surfaces the binding window/reset (gated on a real `budget_exhausted`
block, not `cap_reached` ledger contention) via `renderHostWallExplanation`; `advanceHostDispatchPause`
resets the wall-pass counter on a pass that accepted in-process coverage.)_

**Confirming re-run (verification track, not blocking the remainder):** re-run the maximal-coverage audit
on a fresh Claude window to confirm the shipped fixes hold live, finish the parked self-audit (14/261
packets, resumable), then hand-label `corpus/<run-id>.labels.json` (the A2 oracle unblock). Recipe below.

<details><summary>Reusable launch recipe for the maximal-coverage validation run</summary>

**Where.** A Claude Code conversation opened at the **primary `C:\Code\audit-tools` checkout, branch
`main`, clean tree — never a lap worktree** (slash workflows run the GLOBAL bin, so worktree state is
irrelevant anyway, but scratch/artifacts must land on main's tree). Verify the global bins are current
first (`audit-code --version` == `package.json` on main; reinstall per the Durable-traps npm-12 notes if
not). Target repo: audit-tools itself is fine and has a **pending clean self-audit re-run** on record
(the charter-fix dogfood run paused before ever reaching the dispatch/quota watches); if a genuinely
LARGER metered target is available, prefer it — **size is what forces the quota wall**; a small target
never exhausts a window and validates none of the wall items. On audit-tools, compensate with a deep
ceiling so the frontier is large.

**Configure (before launch).** The run's session config must register every source pool so the
multi-pool machinery lights up:
1. An `openai_compatible` NIM block — operator-supplied `base_url` / `model` / `api_key_env` (never
   hardcoded). This exercises the openai-compatible dispatch pool + CE-004 first-emit conformance.
2. The **opencode-free** source entry — copy from `examples/session-config/opencode-free.json`
   (`api_key: "public"`, `cost_per_mtok: 0`). This exercises arbitrage Phase-0: declared-free routing +
   the `declared_cost_drift` demotion if the free tier ever bills.
3. Codex needs nothing — the CLI is auto-detected. No `--root`/provider/model flags anywhere
   (conversation-first; a needed manual flag is a bug — report it, don't work around it).

**Launch.** `/audit-code` in the conversation. At the interactive Gate-0 `provider_confirmation`,
confirm the priced roster shows **host + codex + NIM + opencode-free**; accept the proposed lens set;
pick a deep ceiling. Then let it run — **do not rescue it at the wall; the failure modes ARE the data.**
Resume after the quota window resets.

**Mid-run, optional but uniquely valuable:** open a **second IDE session** on the same repo mid-wave and
start a step. That is the only live check for the just-shipped lease-TTL fix ([[host-path-quota-enforcement]])
and the multi-IDE concurrent-admitter model: the second admitter must see the account's cap still held
(no double-grant) while the first wave is in flight.

**Watch:** see `docs/backlog.md` → Live-validation guide — each item's ⬇ Live-run watch line is the
authoritative pass/fail.

**Fail-signal protocol:** any wedge needing `force-synthesis`, crash at the wall, orphaned `deepening:*`
tasks, silently-skipped analyzer, or missing friction event → one line under backlog *Open bugs* before
moving on.

**After the run:** hand-label the findings into `corpus/<run-id>.labels.json` — one labeled run is the
only thing blocking the A2 finding-quality oracle (backlog → Deferred / waiting).

**What this run can NOT cover** (separate, lower priority): clippy/rubocop live spawn (needs a Rust/Ruby
repo + toolchain — none on this box); Copilot/Antigravity quota endpoints (need those IDEs running); the
gated e2es (`RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`, `AUDIT_TOOLS_LIVE_QUOTA=1` — creds + env vars,
runnable any time).

</details>

---

## Suggested ordering — everything else open, sequenced

**Agent laps — the forward remainder is the IMMEDIATE NEXT list above.** Residuals from earlier shipped
fixes (M-B3/`judge_report` self-check, audit worker scratch pollution) live under `docs/backlog.md` →
Open bugs.

**WAITING (gated, not next): D-66/67 slice-3** (heartbeat / merge-time ownership-gate CHECK on the
LONG-lived execution claims — `task-claims.json` 20-min lease, remediate node-claims; FOCUSED-LAP,
delicate, **live-run-gated** — only pursue if a real cooperative run shows the staleMs-wide probe window
from slice-1 actually bites; the second-IDE check above is exactly the run that could show it). Fold the
`phase:main` layer-2 asymmetry (slice-1 input) into its design; the lease-TTL lap's ledger-spin follow-up
(backlog → Open bugs) also folds in here. See the D-66/67 roadmap entry in `docs/backlog.md`.

**D-66/67 slice-1 SHIPPED, slice-2 VERIFIED-CLOSED (not worth building).** Design-of-record + residuals in
`docs/backlog.md` → "Unify the full rolling-dispatch lifecycle shell"; [[rolling-lifecycle-unify-full-unification-wrong]]
still governs (full unification is the WRONG endpoint). Only slice-3 (above) remains open.

**External-audit program SHIPPED in full** (V1–V7 + dedup bundle); only low-severity documented residuals
remain (`docs/backlog.md` → *Open bugs*, "External shared-logic audit … residuals").

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work ([[autonomous-pipeline-capstone-spec]]). Loop-infra (T1–T3) and loop-safety tooling
are COMPLETE end-to-end. With the code tracks closed, the live-validation run above IS the current
loop-improvement work — it is what gates "redesign before scheduled autonomy" advancing to the scheduled
audit→remediate→PR capstone.

### Track status (pointers only — detail in `docs/backlog.md`)
- **T1–T3 loop infra — ✅ COMPLETE.** Self-scaling pipeline, convergence/safety, auto-phasing all shipped.
- **T4 host-friction inventory:** selective-deepening convergence fix shipped; live validation = part of
  the run above.
- **T5 forward tracks:** conceptual design review ✅; routing rethink ✅; admission control ✅ (residual =
  live validation above + deeper within-turn simultaneity, only if the run shows alternation is the
  bottleneck); analyzers open only for clippy/rubocop live spawn (needs Rust/Ruby target); CE-004
  residual is provider-blocked (claude-code host has no constraint endpoint — not a defect).
- **T6 deferred / waiting:** A2 oracle (unblocked by labeling the run above); A7 manual GUI checklists
  (Antigravity/OpenCode); provider `queryLimits`; narrow prose-staleness; Copilot/Antigravity quota
  endpoint confirmation. Full detail in `docs/backlog.md` → "Deferred / waiting".

### Forward tracks — provider/dispatch design (lower priority, backlog-tracked, not IMMEDIATE NEXT)
- **NIM (openai-compatible) auto-detection** — NIM only appears in the pool with explicit `openai_compatible`/`sources[]` config; make it auto-appear (`docs/backlog.md` → Open bugs, [[nim-not-auto-detected]]).
- **Quota-before-cost ordering** — Gate-0 `suggestCostOrdering()` sorts by $/Mtok only; demote/flag quota-saturated pools (`docs/backlog.md` → Open bugs, [[quota-before-cost-ordering]]).
- **Per-model/effort tiering** — `capabilityTier` is per-provider, wrong granularity for multi-model backends; tier per `(provider, model, effort)` (`docs/backlog.md` → Open bugs, [[per-model-tiering]]).
- **Relax dispatch source-forcing** — dispatch pre-binds nodes to pools up-front; move to pool-agnostic claims + JIT quota reservation (`docs/backlog.md` → Open bugs, [[relax-dispatch-source-forcing]]).

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
