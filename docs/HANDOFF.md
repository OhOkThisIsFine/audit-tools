# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **Published + live:** `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.26.0`.
  Global bins reinstalled; host assets deployed across 4 hosts (Claude Code/Codex/OpenCode/Antigravity).
- **`main` @ `4815ae3`.** Clean tree.
- The 2026-06-15 self-audit (227 findings) was remediated + shipped. A review of that run exposed that
  **30 of 42 design-review findings were auto-dispositioned without ever being shown to Ethan** (the
  contract pipeline's quality-tail blocks bulk-closed them). Ethan reviewed the surfaced items and
  approved a **go-forward program** — now the active work.

## Active work: the go-forward program

Program of record: **`docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)"** (full
per-item pros/cons in `.audit-tools/deferred-items-for-review.md`, gitignored). Order is flexible;
Ethan's standing directive: do them all, most-logical order, **small green-committed chunks** (quota
near cap). Execute each, build green, commit, push.

Items: **review-necessity approval gate** (item 1, in progress) · **A8** rolling engine → live default
(THE nightly-autonomy blocker) · **A1** fast path past the 15-phase pipeline · **A3+A4** unify the two
obligation engines + collapse the ~8 finding-keyed record types into one `RemediationItem` · **B1**
audit magic numbers · **B2+B3** diff-based re-reviews + obligation-set-keyed staleness · **B4**
hard-exclude tool-refuted findings · **B8** finding-merge location discriminator · **A5+A11**
own-vs-import dep policy + vetted TOML/YAML parsers · **A6** kill the schema dual-encoding (47 JSON
schemas + hand TS validators; dead `ajv`) · **A12** single-package collapse · **A7** validate the host
machinery on all 4 hosts (NOT cut — the multi-host vision is alive). Deferred: A2 (quality oracle),
A9/A10 (pending A8).

## Immediate next step: finish the review-necessity gate (chunk 1c)

**Done (green, pushed):** the gate ENGINE.
- `caea93c` — `src/review/reviewNecessity.ts`: deterministic `classifyReviewNecessity(finding)` →
  strategic | concrete | mechanical (architecture lens is ALWAYS strategic). + `partitionByReviewNecessity`.
- `4815ae3` — `src/review/reviewGate.ts`: `buildReviewRequest(findings, planId)` (tiered request,
  deterministic rationale + blast-radius cost, pros/cons = host slots) + `applyReviewResolution`
  (default-approve; decline-by-id/tier; declined items carry a recorded reason → never a silent close).
- 20 vitest green.

**Left: wire the engine into the state machine.** READ THIS RECON — do not re-derive it:
- The classic gate `classify_impl_risks` + `preview_implement` (`src/steps/nextStep.ts` ~1490-1742) is
  **NOT bypassed** — `handlePendingExtractedPlan` → `saveStateForPlan` sets `status:"planning"`
  (`nextStep.ts:1140`), so the contract-pipeline extracted plan DOES reach preview.
- **The real gap is granularity.** The DAG→extracted-plan conversion (`src/steps/contractPipeline.ts`
  ~1536-1680) collapses the 227 original findings into ~17 NODE "findings" (`source:"contract_pipeline"`).
  Preview shows node-level items; the design-review findings bundled inside the quality-tail nodes are
  bulk-dispositioned ("direction recorded") invisibly inside each node's worker.
- **Fix (option A):** gate the ORIGINAL findings BEFORE the pipeline collapses them — fire after
  intake-ready (`handlePendingIntake`, before `shouldEnterContractPipeline` kicks the first phase), over
  the `audit-findings.json` / `path_a_seed` finding set. Only approved findings seed the pipeline;
  declined → recorded declined disposition. Mirror `waiting_for_clarification` for halt/resume (handler
  ~3077, resolution-consume ~2225, collect step ~2279) via `review_request.json` / `review_resolution.json`.
- After 1c: converge the classic risk-tier preview onto this one review-necessity gate (separate task).

## Pointers
- Live working checkpoint (more design detail, gitignored): `.audit-tools/go-forward-progress.md`.
- Memory: `review-gate-execution-status`, `remediation-review-gate-must-be-tool-enforced`,
  `self-audit-2026-06-15-complete`, `enforce-robustness-in-tooling-not-host-discretion`.

## Working constraints
- **Quota near cap** → small sequential chunks; build green + commit + push each before the next.
- **Build order:** `npm run build -w @audit-tools/shared && npm run build && npm run check` (shared first).
- **CLAUDECODE** is set in-session; UNSET only for release gates (`env -u CLAUDECODE …` via Bash).
- Commit hook runs the full green gate. The async typecheck hook can false-alarm on stale `shared/dist`
  — a central `npm run build -w @audit-tools/shared` is authoritative.
- Ship via the `/ship` skill (encodes the publish-flow traps). Don't park at the push/publish boundary.
