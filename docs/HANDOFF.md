# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main`: latest substantive change is the proactive cross-pool spill `0a620bf8` (INV-QD-14); prior was the
  rolling false-resolve fix `f18138fe` (docs syncs on top; `git log` for HEAD).** Clean tree, all pushed
  (synced with `audit-tools/main`). **NOT published** — commits sit on main unreleased (mid-program; release
  when A8 lands + is validated). Last published: `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` /
  `remediator-lambda 0.27.0` (global bins + host assets on 4 hosts current to that).
- **A8 host-subagent rolling driver — VALIDATED end-to-end this session via a real-subagent smoke, and a
  latent false-resolve bug found + fixed (`f18138fe`, green).** Drove the REAL machine in an isolated repo
  (`C:\Code\_a8-smoke`, deleted) to `dispatch_implement_rolling` (3 disjoint nodes, slots capped to 2),
  spawned REAL Task subagents into the worktrees, called `accept-node` per completion: confirmed all three
  directives **dispatch→wait→done**, real worktree commit→verify→merge (2 nodes landed on main), JIT worktree
  creation, finalization via `merge-implement-results`→`next-step`, and a failing node routed to triage (not
  silently closed). **Bug:** both rolling drivers discarded `acceptNodeWorktree`'s `{merged}` outcome, so a
  node that fails tool-owned verify with IN-SCOPE edits was marked `resolved` from its self-reported result
  while its fix never landed (silent false-close — worst case for autonomy). **Fix:** per-node
  `accept-outcome-<block>.json` sidecar written by both drivers + a merge-state gate in `mergeImplementResults`
  that blocks any self-reported-resolved node with `merged:false`. Red→green regression + real-git wiring test;
  remediate suite green (1622).
- **Quota detection — Claude PROACTIVE source SHIPPED to the tree (`a7eef160`, green).** The signal was confirmed
  live end-to-end (200 on this machine) and `ClaudeOAuthQuotaSource` (`packages/shared/src/quota/`) built + wired
  into BOTH orchestrators' dispatch: audit's `buildDispatchPool` already fed the cascade (so it got it for free via
  the `buildQuotaSource` default); remediate's `scheduleWave` + `buildConfirmedPools` now populate
  `quotaSourceSnapshot` too → the scheduler throttles/cools-down from live remaining quota BEFORE a 429. Working
  doc: `docs/quota-detection-build.md`. Green: shared 648, remediate 1610, audit 2192/1skip, build+check clean.
- **Quota detection — the CROSS-PROVIDER sources are now BUILT too (`a2cb6220`, green).** Extracted
  `BaseHttpQuotaSource` (cache/guard/degrade) + per-provider `fetchXxxUsage` fns, then built `CodexQuotaSource`
  (wham/usage), `CopilotQuotaSource` (copilot_internal/user), `AntigravityQuotaSource` (cloudcode-pa
  fetchAvailableModels), and an `OpenCodeQuotaSource` broker (delegates to the underlying provider by model
  namespace). All register in `buildQuotaSource` (provider-gated) → audit + remediate dispatch consume them for
  free. Fixture-tested + source-verified shapes. Matrix: `docs/cross-provider-quota-matrix.md`.
- **Quota detection — proactive CROSS-POOL SPILL now BUILT (`0a620bf8`, green) — closes remaining item (a).**
  Root gap found this session: `scheduleWave` floors `max_concurrent` at 1, so the old `selectProvider` always
  returned the top capability-ranked non-exhausted pool *regardless of live utilization* — the proactive
  `remaining_pct` only slowed the chosen pool, never redistributed. Now `selectProvider` (shared
  `dispatch/rollingDispatch.ts`) deprioritises a quota-degraded pool (live `remaining_pct` < LOW band, or in an
  active cooldown) so load spills to a peer WITH headroom BEFORE a 429 — the proactive complement to the
  reactive exhausted-pool re-route (INV-QD-07). Capability/cost rank preserved WITHIN each health group; a
  degraded pool stays a fallback (never a stall); inert when quota disabled. ONE shared seam → both
  orchestrators (audit `runRollingDispatch` + remediate `driveRollingImplementDispatch` wrap the same
  `createRollingDispatcher`). 4 new INV-QD-14 tests; shared rolling 27/27, remediate 1622, audit 2192/1skip.
- **Cross-IDE quota concern — RAISED + RESOLVED this session, no code change.** Confirmed the shipped quota code
  only ever queries the conversation's OWN provider (each source gates on `handlesProvider` before any I/O;
  `buildQuotaSource` registers all but non-matching sources are inert). Cross-provider **CLI** dispatch is the
  intended goal; the one red line is **IDE GUI automation, which is absent** (no keystroke/click/screenshot/
  computer-use code; `vscode-task`/`antigravity` are operator-configured command templates, not GUI driving).
  Don't re-audit — see memory `quota-dispatch-vision`.
- **Deliberate intermediate state (NOT bugs):** the rolling engine + host-subagent driver are functional but
  **default-OFF** (host-fanned wave path intact, nothing broken). The host-subagent driver is now
  **real-subagent validated + hardened** (this session); the remaining gate before flipping `rolling_engine`
  default-ON is the **in-process PROVIDER path real-run** — codex agentic run still unvalidated (codex quota
  resets **Jun 19**; the false-resolve fix `f18138fe` covers the provider path too via the shared seam, but it
  wants a real ≥2-node provider run + the Windows codex-sandbox check). The cross-provider quota sources are **fixture-tested +
  source-verified-shape, but only Claude is LIVE-confirmed (200)** — Codex/Copilot/Antigravity each want a
  one-shot live confirmation GET (like the Claude probe) when you OK touching that token; their token-extraction
  degrades cleanly where unavailable (Copilot needs the `gh`/`copilot` CLI token; Antigravity is opt-in). Program
  of record: `docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)".

## Standing directives (Ethan) — read before deciding anything

- **Effort/complexity/refactor-size is NOT a cost.** Only the cleanest/most-efficient/most-robust *endpoint*
  matters. Never defer, stage-to-avoid-work, or pick a lighter half-measure because something is big or a
  large atomic change. The ONLY thing that gates pace is **correctness** — green at every commit, no
  broken/lossy intermediate states. (CLAUDE.md "Ideal code over compatibility"; memory
  `prefer-ideal-code-no-backcompat`.)
- **Ask on genuine ambiguity; never defer merely because something is big.** When a decision is genuinely
  Ethan's and his preference is unclear, ASK (batch the questions) — don't guess or silently defer. (memory
  `ask-on-ambiguity-dont-defer-silently`.)
- **Order of program items is yours** — sequence logically so one refactor doesn't undo another.

## Immediate next: A8 provider-path real-run (Jun 19) + flip default-ON, then the rest of the go-forward program

**Quota detection is now COMPLETE** (research + all sources): Claude (`a7eef160`, live-confirmed + wired) and the
cross-provider sources (`a2cb6220`: Codex/Copilot/Antigravity + an OpenCode broker, on `BaseHttpQuotaSource`,
registered in `buildQuotaSource`). The A8 host-subagent rolling driver (`414e302e`) is built + flag-gated. All on
main, unreleased. Read FIRST — [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md),
[`docs/cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md), memory
`conversation-first-subagent-dispatch-first-class`, memory `cross-provider-quota-matrix`.

### 1. Quota detection — sources DONE; spill DONE (`0a620bf8`); remaining = a real 2nd pool + live confirmation
Item (a) **utilization-driven cross-pool spill is now BUILT** (INV-QD-14, `selectProvider`): the per-node
dispatch seam deprioritises quota-degraded pools so load spills to a healthy peer before a 429, capability/cost
rank preserved within health groups. STILL OPEN:
- (a-residual) **A real SECOND pool to spill INTO.** The spill *logic* is complete and unit-proven, but in a
  single-provider session there is only one pool, so it can't fire end-to-end yet. The concrete next capability
  is detecting/building an actual second pool — another CLI agent (`claude`/`codex`/`opencode`) or an IDE model
  — under its own provider+quota constraints. This is the *Heterogeneous multi-agent dispatch* backlog item
  (FINDING-020) + "detect and dispatch to CLI agents as additional pools." Bigger than spill itself.
- (b) a one-shot **live confirmation GET per provider** (Codex/Copilot — only Claude is live-confirmed; mappings
  are fixture-tested + source-verified-shape), each gated on your OK to touch that token. (Antigravity excluded
  per Ethan this turn; token rotation also dropped per Ethan.)

### 2. A8 host-subagent driver — ✓ VALIDATED + hardened this session; provider real-run + flip remain
(a) **DONE — real-subagent end-to-end smoke.** Drove the real machine to `dispatch_implement_rolling` in an
isolated repo (3 disjoint nodes, slots capped to 2 via `--host-max-concurrent 2`), spawned REAL Task subagents
into the worktrees, called `accept-node` per completion: confirmed dispatch→wait→done, real worktree
commit→verify→merge (2 landed), JIT worktree creation, and finalize via merge-implement-results→next-step. The
smoke surfaced a **false-resolve bug** (both rolling drivers discarded `acceptNodeWorktree`'s `merged` outcome →
a verify-failed, in-scope node was marked resolved with its fix never landing) — **FIXED `f18138fe`** (per-node
accept-outcome sidecar + merge-state gate in `mergeImplementResults`; red→green + real-git tests; suite 1622).
(b) **REMAINING before flip:** the in-process **PROVIDER path real-run** (codex, quota-blocked until **Jun 19**)
— set `sessionConfig.provider="codex"` + `dispatch.rolling_engine=true`, confirm ≥2 nodes land via
worktree→verify→merge AND that the false-resolve fix routes a verify-fail to triage on the provider path; also
settle the Windows codex-sandbox enforcement question. (c) **Then flip `rolling_engine` default-ON** (the
nightly-autonomy gate). Holding the flip per this plan since nightly autonomy runs headless → the provider path,
which isn't real-run-validated yet. Protocol: `docs/a8-rolling-cutover-plan.md`.

- Then the rest of the program: **A1** fast path, **A3+A4** unify obligation engines + `RemediationItem`,
  **B1** magic numbers, **B2+B3** diff re-reviews + obligation-set staleness, **B4** hard-exclude
  tool-refuted findings (re-scoped), **B8** finding-merge discriminator (re-scoped), **A5+A11**, **A6**,
  **A12**, **A7**. Deferred: A2, A9/A10.

**Review gate, as shipped (orientation):** Path A gates the ORIGINAL findings at intake (over the
filter-pass survivors); Path B gates the deduped/grounded node findings at the planning point
(`runPlanningReviewGate` in `nextStep.ts`, fires only when `review_decision.json` is absent → plan_id
`path-b-review`). Declined items become a recorded terminal disposition, never a silent close. The classic
impl-risk preview is gone. Triage auto-retry is now unconditional (capped), no longer keyed on the removed
preview ack. `classifyFindingRisk`/`FindingRiskTier` were KEPT (dispatch model-tier consumer, orthogonal to
the review surface).

**Provider-hang trap (logged in backlog "Deferred fixes"):** in a provider-less env (e.g. CLAUDECODE unset,
as in the release gate) `createFreshSessionProvider` auto-resolves a CLI backend whose subprocess hangs —
Ethan UNINSTALLED OpenCode, so `opencode run` auto-resolution is the prime suspect. It surfaced as a 30s
hang in `phase-plan.test.ts` under the release gate; that test was made hermetic (`b8c8c30a`, injects the
`extractFindings` seam), but the underlying auto-resolution hang is still OPEN — watch for it.

## Pointers
- Working doc for A8: [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md) (design + protocol +
  open items). Fold + delete it into here/backlog when A8 fully lands.
- Memory (this session): `conversation-first-subagent-dispatch-first-class`, `claude-oauth-usage-quota-endpoint`.
  Also: `review-gate-execution-status`, `prefer-ideal-code-no-backcompat`, `ask-on-ambiguity-dont-defer-silently`,
  `remediation-review-gate-must-be-tool-enforced`.
- **`MEMORY.md` consolidation IN PROGRESS by a concurrent agent (2026-06-16)** — do NOT edit memory files
  while that runs. PENDING fold once it settles: the INV-QD-14 cross-pool spill (root cause: `scheduleWave`
  floors `max_concurrent` at 1, so the pre-spill `selectProvider` never redistributed) belongs in memory
  `cross-provider-quota-matrix` / `quota-dispatch-vision`.
- Review-gate artifacts (under `.audit-tools/remediation/`): `review_request.json` /
  `review_resolution.json` / `review_decision.json` / `review_filter_dispositions.json`.

## Working constraints
- **Green at every commit:** `npm run build -w @audit-tools/shared && npm run build && npm run check` →
  zero errors (shared first). The commit hook enforces it.
- **Run remediate vitest FROM `packages/remediate-code`** (`cd` there first). Running `vitest` from the repo
  root globs shared's `node:test` `.mjs` files and reports a wall of false failures — they are NOT real.
- **CLAUDECODE** is set in-session; UNSET only for release gates (`env -u CLAUDECODE …` via Bash).
- The async typecheck hook can false-alarm on stale `shared/dist` or a mid-edit snapshot — a central
  `npm run build -w @audit-tools/shared` + the commit gate are authoritative; re-run `check` yourself to confirm.
- Ship via the `/ship` skill (encodes the publish-flow traps). Don't park at the push/publish boundary.
