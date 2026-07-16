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
  Memory [[unified-dispatch-worker-model]]. The decomposition's inventory/handshake half is DONE through G3;
  what remains (incl. the repair-proxy kind-1 transport that was the original goal) is an open worth-it call —
  see ▶ IMMEDIATE NEXT. Full dogfood findings: `docs/backlog.md` → "Live dogfood: BOTH dispatch paths failed".
- **Env cruft (harmless):** two empty git-deregistered worktree dirs (`.claude/worktrees/beautiful-euclid-1514e9`,
  and in repair-proxy `repair-proxy-tool-calls-7e075d`) are held by a stale Windows handle — gitignored,
  inert, clear on reboot. Also: `INV-shared-core-14` fails in this shell but identically on `main`
  (pre-existing + env-sensitive; re-proved on a stashed clean HEAD during the G3 A″ lap) — never a branch's doing.
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

## ▶ IMMEDIATE NEXT — G4 (or: stop here — see "Is the rest worth it?")

**G3 is COMPLETE** (A′ `043832a5` · A″ `e0deb96f` · B+D+C this lap). The confirmed pool is split along
policy-vs-reach: the artifact carries the operator's DECISION only (exclusions in an open three-tier
`provider:model` grammar, cost order, λ), reach is re-resolved per-auditor and applied as a
set-difference FILTER, and the `autonomous_mode`-keyed reconciliation gate is live. Per-commit detail is
in `git log` + the spec's Decomposition (NOT restated here — this doc is the open-work roadmap).
Design of record: [`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md)
→ Decomposition G3. Plan + its four refuted drafts (dated record):
[`docs/reviews/g3-dispatch-policy-plan-2026-07-16.md`](reviews/g3-dispatch-policy-plan-2026-07-16.md).

### ⚠ Is the rest of the G-series worth it? — OPEN OWNER CALL, ask before starting G4

The rework began as the repair-proxy dogfood fix and has run ~a dozen laps (commit 1 → 2a-i/ii → G1 →
G2 → G2.5 → G3 A′/A″/B+D/C). The remaining items are NOT obviously worth the same ceremony, and the
owner has flagged the total cost. Assess each on its own merits BEFORE opening a lap:
- **G4** split quota/block_quota by capability-vs-policy. The spec itself says it "may fold into G2" —
  check whether G2 already covered it rather than assuming it's outstanding.
- **G5** never-inherit enforcement (auditor-id stamp + `declared ∩ ambient-verifiable` reach +
  lies-reachably quarantine). NOTE: G2.5 established that multi-IDE isolation falls out of per-process
  env inheritance with NO `auditor_id` — so G5's premise needs re-verification, not implementation.
- **G6** remediate `--auditor` round-trip. This is what unphases policy's home (artifact → intent).
- Orthogonal: **commit 3** repair-proxy as a kind-1 launch-transport (the ORIGINAL goal of the whole
  rework — arguably the only remaining item with a live user-facing payoff); **commit 4** fix C (host
  cold-start wall, needs a clean minimal repro); **commit 5** decide kind-3's fate.

**⚠ Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

**⚠ NOTHING IN THE G-SERIES IS RELEASED — deliberate, and G1 is a BREAKING transport change.** The audit
CLI's `--host-*` capability flags are GONE (one `--auditor <json>` descriptor replaces them) and a repo
`session-config.json` can no longer carry `provider`/`sources`/backend blocks (rejected at load). The
installed GLOBAL bins are pre-G1, so a stale host dogfooding this batch has its handshake **silently
ignored** (unknown flags → defaults). Don't dogfood the G-series via a stale global bin without
reinstalling. Publish is deferred until the sequence reaches a coherent shippable point — see the
worth-it call above.

**G3+ is loop-core** (`intakeExecutors.ts`, `dispatch.ts`, `marshal.ts`, `steps/nextStep.ts`,
`costRank.ts`, **`src/shared/quota/`**) → green + independent review + attestation required.

Design of record: **[`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md)**
→ "Greenfield endpoint (owner-approved 2026-07-16)" + Decomposition (memory
[[unified-dispatch-worker-model]]). Shipped G-series detail lives in `git log` + that Decomposition's
`[SHIPPED]` markers — deliberately NOT narrated here. Per-step plan docs (dated records, with their
refuted drafts) are in `docs/reviews/g{1,2,2-5,3}-*.md`.

**Offload lanes (as of the G3 session):** the free `llm read` lane works (zero Claude-read cost for recon).
`llm write`/NIM completion + `ANTHROPIC_BASE_URL` subagent-fronting are UNRETESTED. Mechanical bulk offloads
cleanly to **Haiku subagents** (parent orchestrates + verifies green + independent review) — but ALWAYS
review offloaded test diffs for assertion QUALITY, not just green (a Haiku agent once weakened a test to an
incidental TypeError). Fastest full unblock: point `ANTHROPIC_BASE_URL` at a running repair-proxy on a free
model.

## Older track — bounded quota-cluster remainder (secondary, not blocking the rework)

1. **Low residuals:** doc-review auto-apply re-asserting a resolved decision after a process restart; the
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

**Configure (before launch).** Source pools are declared **off-repo** now (G2 removed `sources` /
`provider` / per-backend blocks from the session config; G2.5 resolves them from a machine-level
declaration). Write `~/.audit-code/sources-declared.json` — start from
`examples/catalog/sources-declared.json`:
1. A NIM entry — operator-supplied `endpoint` / `model` / `api_key_env` (never hardcoded). Exercises the
   openai-compatible dispatch pool + CE-004 first-emit conformance.
2. The **opencode-free** entry (`cost_per_mtok: 0`, `api_key_env: OPENCODE_ZEN_API_KEY=public`).
   Exercises arbitrage Phase-0: declared-free routing + the `declared_cost_drift` demotion if the free
   tier ever bills.
3. Codex needs nothing — the CLI is auto-detected. No `--root`/provider/model flags anywhere
   (conversation-first; a needed manual flag is a bug — report it, don't work around it).

⚠ **Export the key env vars in the shell that launches the IDE.** G2.5 admits a lane only if the
audit-tools process can PROVE reach — an `api_key_env` pointing at an unset var is dropped with a reason,
by design. If a pool is missing from Gate-0, that is the mechanism working; check the env, not the config.

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
