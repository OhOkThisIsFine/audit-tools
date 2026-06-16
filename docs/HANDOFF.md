# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **Published + live:** `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0`.
  Global bins reinstalled (postinstall ran via `--allow-scripts`); host assets deployed across 4 hosts.
- **`main` @ `918742a8`.** Clean tree, all pushed, all published.
- **Program item 1 (review-necessity gate) is COMPLETE and shipped** in remediator-lambda 0.27.0. There is
  now ONE review surface per run for both paths; the classic impl-risk preview is gone.
- **Active work:** the go-forward program from the 2026-06-15 self-audit review (which exposed that 30 of
  42 design-review findings had been auto-dispositioned without ever being shown). Program of record:
  `docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)". **Item 1 done → next is A8.**

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

## Immediate next step: program item A8 (rolling-default atomic cutover)

Item 1 is done and shipped (remediator-lambda 0.27.0). Work down the rest of the go-forward program
(order is yours; sequence to avoid rework). Next up:

- **A8 — rolling-default atomic cutover (THE nightly-autonomy blocker).** Flip the in-process rolling
  dispatch engine from opt-in to the live default and atomically delete the host-fanned wave fallback in
  `buildImplementDispatchStep` (`src/steps/nextStep.ts`). The engine + write-scope/verify are already folded
  into merge behind a flag (ARC-f378135d, shipped default-OFF); A8 = flip default-ON + remove the fallback +
  validate a multi-worker rolling run. Single atomic replace (new mechanism + deletion in one commit).
- Then: **A1** fast path, **A3+A4** unify obligation engines + `RemediationItem`, **B1** magic numbers,
  **B2+B3** diff re-reviews + obligation-set staleness, **B4** hard-exclude tool-refuted findings (re-scoped),
  **B8** finding-merge discriminator (re-scoped), **A5+A11**, **A6**, **A12**, **A7**. Deferred: A2, A9/A10.

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
