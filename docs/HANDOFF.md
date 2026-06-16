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

**Two loose ends remain on item 1 (do these next — small, build on ce8d790):**
1. **1c-2: surface declined findings in the SHIPPED outcome.** Today declined items are recorded in
   `review_decision.json` (on disk, reasoned) but NOT in `remediation-outcomes.json`. **RECON DONE — the
   path is clean:** `handlePendingExtractedPlan` (`nextStep.ts:1963`) builds `plan_coverage` via
   `buildCoverageLedger({...})`, which ALREADY takes a `droppedByCheckpoint` list → `dropped_by_checkpoint`
   disposition (findings filtered before planning, not in the node set). Mirror it: (a) add
   `declined_by_review` to `CoverageLedgerEntry["disposition"]` (state/types.ts); (b) add a `review_gate`
   `NeverPlannedDropReason` + map `declined_by_review → review_gate` in `DROP_REASON_BY_DISPOSITION`
   (`close.ts:259-266`); (c) add a `declinedByReview` param to `buildCoverageLedger` (plan.ts ~642) that
   emits one entry per declined id (template = the droppedByCheckpoint branch); (d) in
   `handlePendingExtractedPlan`, read `review_decision.json` and pass `declined.map(d=>d.finding_id)`.
   **Payloads recover for free at close:** the gate only swaps the filtered `approved-findings.json` into
   `sourcePaths`, NOT the intake source-manifest, so `loadStructuredSourceFindingsById` (close.ts:277)
   still reads the ORIGINAL audit-findings.json (with declined findings) → `buildOutcomeCoverageLedger`
   enriches each `declined_by_review` entry with its full Finding payload. Extend the buildCoverageLedger +
   outcome-contract tests. Completes the never-silently-closed guarantee end-to-end.
2. **Converge the classic preview onto this gate.** `classify_impl_risks` + `preview_implement`
   (`nextStep.ts` ~1490-1742, `impl_preview_ack.json`) is a SECOND review surface at the planning phase
   over node-level items. Collapse it onto the one review-necessity gate so there's a single surface.

Then continue down the program (next: **A8** rolling engine → live default, the nightly-autonomy blocker).
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
