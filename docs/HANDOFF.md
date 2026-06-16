# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **Published + live:** `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.26.0`.
  Global bins reinstalled; host assets deployed across 4 hosts (Claude Code/Codex/OpenCode/Antigravity).
- **`main` @ `5a820a4`.** Clean tree, all pushed. Unpublished commits ahead of the live npm versions = the
  review-gate work (`caea93c`, `4815ae3`, `ce8d790`, `072f4d6`, `86b4621`, `5a820a4`).
  **PUBLISH IS HELD until program item 1 is fully done** (Ethan).
- **Active work:** the go-forward program from the 2026-06-15 self-audit review (which exposed that 30 of
  42 design-review findings had been auto-dispositioned without ever being shown). Program of record:
  `docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)".

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

## Immediate next step: finish program item 1 (the review-necessity gate), then move down the program

**Item 1 goal:** ONE review preview per run, tiered by review-necessity, over the DEDUPED/grounded
survivor set (never showing findings that will later be deduped/dropped). **Shipped so far (all green, pushed):**
- Engine: `caea93c` (`classifyReviewNecessity`) + `4815ae3` (`buildReviewRequest`/`applyReviewResolution`),
  in `src/review/`.
- `ce8d790` + `072f4d6`: Path-A intake review gate; declines recorded in `remediation-outcomes.json`.
- `86b4621` (**chunk A**): `src/findingFilter.ts` `runFindingFilterPass` — the single filter pass
  (no-evidence → cross-lens dedup → phantom-grounding → intent-checkpoint).
- `5a820a4` (**chunk B**): Path A runs the filter pass at INTAKE over the ORIGINAL findings; the gate
  previews the deduped/grounded SURVIVORS tiered; approved survivors seed the pipeline; coverage rebuilt
  over the originals (every audit finding → exactly one disposition; `declinedByReview` now in-source).
  Path A also now honors intent-checkpoint filters (no-op unless the checkpoint has filters set).

**CURRENT INTERMEDIATE STATE (know this before editing):** Path A now has TWO review surfaces — the new
intake gate AND the still-present classic impl-risk preview at the planning phase = a temporary double
review. Functionally correct and green; just redundant. **Chunk C removes it.** This is the only "untidy"
spot and it is deliberate/known, not a bug.

**REMAINING for item 1:**
- **Chunk C** (one atomic delete-and-replace): remove the classic impl-risk preview machinery —
  `classify_impl_risks` + `preview_implement` steps inside `buildImplementDispatchStep`
  (`src/steps/nextStep.ts` ~1443-1700), `classifyFindingRisk`/`FindingRiskTier` (`src/steps/stepUtils.ts`),
  `impl_risk_preliminary.json`/`impl_risk_reviewed.json`/`impl_preview_acknowledged.json`,
  `renderTierSection`/`renderNoOpSection` — and route **Path B** (document/conversation; findings are
  derived as DAG nodes, already deduped/grounded by `handlePendingExtractedPlan`) through the
  review-necessity gate at the planning point, firing ONLY when `review_decision.json` is ABSENT (Path A
  already gated at intake → its decision exists → no double review). The planning gate previews the nodes
  tiered, halts → collects → applies (declined nodes → terminal disposition). Rework the
  `next-step-preview-ack` tests. **Full design + exact steps in `.audit-tools/go-forward-progress.md`.**
- **Chunk D**: publish item 1 (shared/auditor/remediator version bumps → npm → reinstall global bins) via
  the `/ship` skill. Held until C is done.

**After item 1 → continue the program** (order is yours, sequence to avoid rework): **A8** rolling-default
atomic cutover (THE nightly-autonomy blocker), **A1** fast path, **A3+A4** unify obligation engines +
`RemediationItem`, **B1** magic numbers, **B2+B3** diff re-reviews + obligation-set staleness, **B4**
hard-exclude tool-refuted findings (re-scoped — see backlog), **B8** finding-merge discriminator
(re-scoped — original premise was wrong, see backlog), **A5+A11**, **A6**, **A12**, **A7**.

**OpenCode bug** (logged in backlog "Deferred fixes"): Ethan has UNINSTALLED OpenCode, so the trigger should
now surface as an `opencode`-not-found CLI error rather than opening the app — watch for that error; it
pinpoints the caller. Prime suspect: `opencode run` via the OpenCode provider when it's auto-resolved.

## Pointers
- Live working checkpoint (detailed chunk A–D design + recon, gitignored): `.audit-tools/go-forward-progress.md`.
- Memory: `review-gate-execution-status`, `prefer-ideal-code-no-backcompat`,
  `ask-on-ambiguity-dont-defer-silently`, `remediation-review-gate-must-be-tool-enforced`.
- New review-gate artifacts (under `.audit-tools/remediation/`): `review_request.json` /
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
