# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **Published + live:** `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0`.
  Global bins reinstalled (postinstall ran via `--allow-scripts`); host assets deployed across 4 hosts.
- **`main` @ `0fa13d35`.** Clean tree, all pushed. **NOT published** — two A8 commits sit on main
  unreleased (mid-program; release when A8 lands + is validated). Last published: shared 0.22.0 /
  auditor-lambda 0.27.0 / remediator-lambda 0.27.0.
- **Program item 1 (review-necessity gate) shipped** in remediator-lambda 0.27.0 (one review surface per run).
- **Active work: A8 — and it was REFRAMED this session (the framing below the fold is now wrong; see next
  section).** Program of record: `docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)".

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

## Immediate next step: A8 step 4 — the host-subagent full-rolling driver

**A8 was reframed this session — read [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md)
and memory `conversation-first-subagent-dispatch-first-class` FIRST.** A8 is NOT "delete the host
fallback / flip a flag." It is: **one shared rolling `acceptNode` core + two co-equal full-rolling
drivers** (in-conversation subagent dispatch is first-class — subscription/no-API users depend on it).

Done + pushed this session (both green, default-OFF, nothing broken):
- `dc4d9c2` — the in-process / provider driver made functional (it was a dormant 0-caller engine):
  `makeProviderNodeDispatcher` + tool-owned worktree commit + node_modules link + worktree-rooted prompts.
- `0fa13d3` — codex provider made real (verified `codex exec --sandbox … --cd … --add-dir …` + stdin;
  the old `--prompt` guess was wrong). Codex is a usable CLI-dispatch backend (no extra wiring).

**Next build (the meaty one — start fresh):** the **host-subagent full-rolling driver** + extract the
shared **`acceptNode`** core. Exact protocol in the plan doc ("Host-subagent driver protocol"):
extract `acceptNodeWorktree` from `dispatchNodeWithWorktree` → add an `accept-node --id X` per-completion
callback command → a dispatch step that pre-creates eligible worktrees and drives the host to spawn
subagents + call `accept-node` as each finishes (dispatch-next-on-complete) → select driver by
availability. **Validate it IN-SESSION** (the host instance spawns real Task-subagents via the Agent tool
— no quota). Provider-path real validation is quota-blocked until **Jun 19** (codex usage limit).

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
- Memory: `review-gate-execution-status`, `prefer-ideal-code-no-backcompat`,
  `ask-on-ambiguity-dont-defer-silently`, `remediation-review-gate-must-be-tool-enforced`.
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
