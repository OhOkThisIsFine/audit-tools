# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` @ `a2cb6220`.** Clean tree, all pushed. **NOT published** — commits sit on main unreleased
  (mid-program; release when A8 lands + is validated). Last published: `@audit-tools/shared 0.22.0`
  / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0` (global bins + host assets on 4 hosts current to that).
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
- **A8 host-subagent rolling driver — BUILT this session (`414e302e`, green, flag-gated default-OFF).** Shared
  `acceptNodeWorktree` core extracted (both drivers reuse it); `accept-node` callback + `dispatch_implement_rolling`
  step + the lock-guarded `rollingSession` machine (`prepareHostRollingDispatch`/`advanceHostRolling`, bounded JIT
  worktrees). When `rolling_engine` is on AND the host can dispatch, next-step emits the worktree-per-node rolling
  step; the host spawns a subagent per node + calls `accept-node` on each completion. Unit + integration green
  (8 tests). Working doc: `docs/a8-rolling-cutover-plan.md`.
- **Deliberate intermediate state (NOT bugs):** the rolling engine + host-subagent driver are functional but
  **default-OFF** (host-fanned wave path intact, nothing broken); codex provider real but its agentic run
  unvalidated (codex quota resets **Jun 19**); the A8 drivers still lack a **real-subagent / real-provider
  end-to-end smoke** (unit + integration only). The cross-provider quota sources are **fixture-tested +
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

## Immediate next: A8 real-subagent validation + flip default-ON, then the rest of the go-forward program

**Quota detection is now COMPLETE** (research + all sources): Claude (`a7eef160`, live-confirmed + wired) and the
cross-provider sources (`a2cb6220`: Codex/Copilot/Antigravity + an OpenCode broker, on `BaseHttpQuotaSource`,
registered in `buildQuotaSource`). The A8 host-subagent rolling driver (`414e302e`) is built + flag-gated. All on
main, unreleased. Read FIRST — [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md),
[`docs/cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md), memory
`conversation-first-subagent-dispatch-first-class`, memory `cross-provider-quota-matrix`.

### 1. Quota detection — DONE; remaining = cross-pool spill + live confirmation
The sources PRODUCE per-pool snapshots and the scheduler already consumes `remaining_pct` per pool. STILL OPEN:
(a) **utilization-driven spill ACROSS heterogeneous pools** + per-model/cost routing (the multi-pool dispatch
half — bigger than the sources; the binding constraint is quota+rate, NOT max-parallel-`N`); (b) a one-shot
**live confirmation GET per provider** (Codex/Copilot/Antigravity — only Claude is live-confirmed), each gated on
your OK to touch that token. Security: rotate the Antigravity token (a research subagent decoded a fragment — see
`docs/cross-provider-quota-matrix.md`).

### 2. A8 host-subagent driver — BUILT; validate + flip default-ON
The driver is built + unit/integration-green + flag-gated (`rolling_engine`, default-OFF). REMAINING:
(a) a **real-subagent end-to-end smoke** — stage a small real remediation to the implement-dispatch point, set
`dispatch.rolling_engine: true` + a dispatching host, then actually spawn Task-subagents into the worktrees the
step lists and call `accept-node --id <block>` per completion (dispatch/wait/done); confirm each node
commits→verifies→merges and the run finalizes via merge-implement-results → next-step (no quota needed).
(b) Then **flip `rolling_engine` default-ON** (the nightly-autonomy gate) once both this and the provider path
(codex, quota-blocked until **Jun 19**) are real-run validated. Protocol + status:
`docs/a8-rolling-cutover-plan.md`.

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
- **`MEMORY.md` is over its size limit** — a `consolidate-memory` pass is due (merge/trim verbose index lines);
  not blocking, but do it before adding many more entries.
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
