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
- **Almost everything still open is env-bound live validation, not code.** All major code tracks are
  complete (host-path quota enforcement ✅ 2026-07-10; access-memory ✅; cost↔speed dial ✅; admission
  control ✅; arbitrage Phase-0 CODE-COMPLETE; conceptual design review ✅). The bottleneck has flipped:
  the highest-leverage next action is the **maximal-coverage live run** below, not another code lap.
- **Local env note:** the box runs npm 12.0.0 — it blocks dependency install scripts by default and can
  emit object-shaped `npm pack --json`; smokes are fixed, but see `docs/backlog.md` → Durable traps
  before any manual `npm install -g` / packaged-install work.
- **⚠️ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main` before
  starting a lap — a worktree can branch behind main and must fast-forward + re-read HANDOFF/backlog first.

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

## ▶ IMMEDIATE NEXT — the maximal-coverage env-bound validation run (owner-attended)

One correctly-configured live audit clears most of the open env-bound watches at once. The owner has
been misdirected toward these piecemeal before — this is the consolidated recipe. Per-item pass/fail
detail lives in `docs/backlog.md` → **Live-validation guide** (the run-config matrix + each item's
"⬇ Live-run watch" line); this section is the *how to launch it*.

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

**Watch — summary only; the authoritative pass/fail per item is its ⬇ line in the backlog guide:**
- Wall: graceful resumable pause (never a crash), worktrees intact, resume with no lost/redone packets,
  pacing that *learns* (slope adjusts after the first window reading) and slows pre-wall.
- `quota_escalation` friction event recorded when a packet escalates pools at the wall.
- Every `deepening:*` task converges — no orphans, no `force-synthesis` needed to finish.
- Codex path: driver-selection log picks **Y-dispatcher** (not slot-pull); route only small packets to
  codex (known-poor at read-heavy — backlog Durable traps).
- NIM: results conform on first emit (schema-repair rounds ~0).
- opencode-free: fills first (declared free); demotion + `declared_cost_drift` friction if it bills.
- knip dead-code leads reach the per-file lens (leads-not-verdicts).
- Scratch-pollution fix (shipped 2026-07-10): untracked files are excluded from audit scope by the new
  `untracked` disposition rule, and dispatch prompts direct host scratch into
  `.audit-tools/<area>/scratch/<run-id>/` — confirm no worker/host scratch lands at the target repo root,
  and that the `file_disposition` artifact records the rule outcome (`untracked.applied` / guard branch).

**Fail-signal protocol:** any wedge needing `force-synthesis`, crash at the wall, orphaned `deepening:*`
tasks, silently-skipped analyzer, or missing friction event → one line under backlog *Open bugs* before
moving on.

**After the run:** hand-label the findings into `corpus/<run-id>.labels.json` — one labeled run is the
only thing blocking the A2 finding-quality oracle (backlog → Deferred / waiting).

**What this run can NOT cover** (separate, lower priority): clippy/rubocop live spawn (needs a Rust/Ruby
repo + toolchain — none on this box); Copilot/Antigravity quota endpoints (need those IDEs running); the
gated e2es (`RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`, `AUDIT_TOOLS_LIVE_QUOTA=1` — creds + env vars,
runnable any time).

---

## Suggested ordering — everything else open, sequenced

**Agent laps (while the validation run is pending / between its sessions) — the open-bugs cluster in
`docs/backlog.md`** (each lean unless noted): M-B3 citation gate re-emitting the wrong phase;
`validate-artifact --name judge_report` unsatisfiable self-check; doc-review auto-apply re-asserting a
resolved decision after a process restart; critical-flow LLM fallback spec'd-but-unwired (owner call:
build vs downgrade the norm). Pick by bite-frequency — the first two each burned a live run. (Audit
worker scratch polluting the audited repo root: FIXED 2026-07-10 — untracked disposition rule + host
scratch-dir prompt note; residuals under backlog *Open bugs*.)

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
