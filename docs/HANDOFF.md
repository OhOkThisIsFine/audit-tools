# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **Published + live:** `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.26.0`.
  Global bins reinstalled; host assets deployed across 4 hosts (Claude Code/Codex/OpenCode/Antigravity).
- **`main` @ `ce8d790`.** Clean tree. Unpublished commits ahead of the live npm versions: the
  review-gate program (`caea93c`, `4815ae3`, `ce8d790`). Publish when program item 1 is fully done.
- The 2026-06-15 self-audit (227 findings) was remediated + shipped. A review of that run exposed that
  **30 of 42 design-review findings were auto-dispositioned without ever being shown to Ethan** (the
  contract pipeline's quality-tail blocks bulk-closed them). Ethan reviewed the surfaced items and
  approved a **go-forward program** — now the active work.

## Active work: the go-forward program

Program of record: **`docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)"** (full
per-item pros/cons in `.audit-tools/deferred-items-for-review.md`, gitignored). Order is flexible;
Ethan's standing directive: do them all, most-logical order, **small green-committed chunks** (quota
near cap). Execute each, build green, commit, push.

Items: **review-necessity approval gate** (item 1, core SHIPPED `ce8d790`; 2 loose ends below) · **A8** rolling engine → live default
(THE nightly-autonomy blocker) · **A1** fast path past the 15-phase pipeline · **A3+A4** unify the two
obligation engines + collapse the ~8 finding-keyed record types into one `RemediationItem` · **B1**
audit magic numbers · **B2+B3** diff-based re-reviews + obligation-set-keyed staleness · **B4**
hard-exclude tool-refuted findings · **B8** finding-merge location discriminator · **A5+A11**
own-vs-import dep policy + vetted TOML/YAML parsers · **A6** kill the schema dual-encoding (47 JSON
schemas + hand TS validators; dead `ajv`) · **A12** single-package collapse · **A7** validate the host
machinery on all 4 hosts (NOT cut — the multi-host vision is alive). Deferred: A2 (quality oracle),
A9/A10 (pending A8).

## Immediate next step: finish program item 1's loose ends, then move down the program

**Review-necessity gate (program item 1) — core SHIPPED to main (commit + push, NOT published):**
- `caea93c` — `src/review/reviewNecessity.ts`: `classifyReviewNecessity` (architecture lens ALWAYS
  strategic) + `partitionByReviewNecessity`.
- `4815ae3` — `src/review/reviewGate.ts`: `buildReviewRequest` + `applyReviewResolution` (default-approve;
  decline-by-id/tier; declined carry a recorded reason).
- `ce8d790` — **WIRING (chunk 1c).** `runReviewApprovalGate` in `nextStep.ts` fires on the Path-A
  (structured_audit) intake INSIDE `handleReadyIntakeContractPipeline`, BEFORE the pipeline collapses the
  findings into ~17 DAG nodes (no node→original-finding provenance exists, so the gate MUST run
  pre-collapse — that collapse is what hid 30/42 design findings). File-driven + pre-state (NO new
  RemediationState status — mirrors the intake-clarification gate). Halt = `collect_review_approval` step
  + `review_request.json`; resume consumes `review_resolution.json` → durable `review_decision.json`
  {approved_ids, declined[{finding_id,reason}]}; idempotent (fires once). Declined findings are excluded
  from BOTH the path-A seed AND the pipeline source inputs (filtered `approved-findings.json` swapped in)
  — tool-enforced, not host-trusted. Approve-all is byte-identical to pre-gate. 8 wiring tests; harness
  `approveReviewGate()`.

**Item 1 status: CORRECTNESS COMPLETE.** Findings are surfaced (1c) and declines are recorded end-to-end
in the shipped outcome (1c-2). One product-judgment refinement remains:
- `072f4d6` — **1c-2 SHIPPED.** Declined findings surface in `remediation-outcomes.json` as a
  `declined_by_review` coverage disposition + `review_gate` drop_reason (never-planned analog of
  `dropped_by_checkpoint`). `buildCoverageLedger` appends them (separate optional `declined_review_count`,
  the 5-count source reconciliation stays intact); `buildOutcomeCoverageLedger` recovers payloads at close
  from the UNFILTERED intake source. buildCoverageLedger + close enrichment tests added.

**Remaining (NOT a correctness gap — needs product judgment, left for a deliberate pass):**
- **Classic-preview convergence.** `classify_impl_risks` + `preview_implement` (`nextStep.ts` ~1490-1742,
  `impl_preview_ack.json`) is a 2nd review surface at planning over node-level items. **A 1c side-effect:
  Path A now hits BOTH gates (intake review + classic node-preview) = double review.** Path B has NO
  intake gate (no pre-existing findings) so the classic preview is its ONLY surface — can't just delete
  it. Options + the open product question (is Path A's intake finding-approval sufficient, or do users
  still want the node-plan preview?) are written up in `.audit-tools/go-forward-progress.md`. Lean:
  surgical skip of the classic preview on Path A when `review_decision.json` exists. Deferred pending a
  deliberate decision — it changes a user-facing surface.

**Next down the program (pick clean, well-scoped items; A8 is big/risky — the rolling-default atomic
cutover — save it for a focused pass):** B8 (finding-merge location discriminator), B4 (hard-exclude
tool-refuted findings), then A1 / A3+A4 / B1 / B2+B3 / A5+A11 / A6 / A12 / A7.
Live working detail: `.audit-tools/go-forward-progress.md`.

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
