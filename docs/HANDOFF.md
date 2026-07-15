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

## ▶ IMMEDIATE NEXT — the bounded forward remainder (quota cluster shipped)

The 2026-07-11 maximal-coverage run and the 2026-07-12 self-audit re-run both surfaced dispatch/quota
bugs; fixes shipped in the current release (see Live state). What remains is a short, bounded list — work top-to-bottom,
**full-suite-verify before each loop-core commit**:

1. **critical-flow LLM pass — BUILD it (owner decision locked). NOT loop-core → lower risk.**
   `spec/audit/audit-goals.md` allows an LLM fallback only when the deterministic confidence check fails.
   The deterministic side is real (`criticalFlows.fallback_required` in `src/audit/extractors/flows.ts`)
   but its only consumer (`structureExecutors.ts:173`) just appends an informational string — no
   executor/worker-prompt runs an actual LLM critical-flow pass on the flag. Wire the gated pass.
2. **C — host Agent fan-out is quota-invisible (HIGH, loop-core).** The design-review (5 perspectives +
   judge) and systemic-challenge steps dispatch host subagents that never touch the quota layer (no
   admission grant/lease, no /usage probe, no pre-wall pacing) → raw death at the session wall. Register
   the host pool + consume admission for those prescribed-fan-out steps. `docs/backlog.md` → Open bugs.
3. **D — empty_grant derives no reset-time + wall-pass counts NIM-progress passes (medium, loop-core).**
   `detectHostDispatchWall` (`hostDispatchWall.ts:27-49`) returns `earliestResetAt:null`; surface the
   per-pool binding window + derived budget + packet cost. And LIVELOCK_PAUSE_LIMIT shouldn't count
   passes where the in-process NIM partition ingested results. `docs/backlog.md` → Open bugs.
4. **openai-compatible config trace (VERIFY FIRST — do NOT blind-flip an already-on default).** The
   provider already inlines referenced files by default (since `fbbf3039`); the run still needing the
   `include_referenced_files` workaround is a contradiction → trace the hybrid review-dispatch →
   provider-config wiring, then build the "refuse to dispatch an unroutable review packet" guard.
5. **Low residuals:** doc-review auto-apply re-asserting a resolved decision after a process restart; the
   two A2b residuals; untracked-exclusion residuals (a–e). All in `docs/backlog.md` → Open bugs.

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

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
