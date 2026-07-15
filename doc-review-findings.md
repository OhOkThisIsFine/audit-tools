# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [CLAUDE-1] `CLAUDE.md` line 108 — the Providers paragraph omits `agy` — proposed: insert `agy` into
  the enumerated list after `antigravity` (`` `claude-code`, `codex`, `opencode`, `openai-compatible`,
  `subprocess-template`, `vscode-task`, `antigravity`, `agy`, `worker-command` ``), and extend the
  auto-detection sentence: `` `codex` is headless CLI auto-detected like `claude-code`; `agy` is likewise
  a headless CLI, auto-detected on `PATH` with a legacy `gemini` binary fallback (gated for a
  2026-07-18 sunset); `antigravity` is agentic-IDE backend routed through a configured command/task
  template. `` The "2026-07-18 sunset" detail is independently confirmed (not a hallucination) at 4
  production sites: `src/shared/providers/providerConfirmation.ts:120`, `agyProvider.ts:78`,
  `providerFactory.ts:137`, `providerPathGuard.ts:97`, plus a matching comment in `sessionConfig.ts:222`.

### Design decisions for you
- [DD-1] `spec/self-scaling-pipeline-design.md` — still open (re-verified, lines shifted slightly to
  ~15-21 and ~46): despite the doc's own preamble "Durable conceptual design; no dated status here," it
  still narrates history in changelog-creep style — (a) "...it has since been softened (see Mechanisms,
  Dial A) to a mandatory light-review floor... shipped (`docs/backlog.md` doc-review D-68)"; (b)
  "(`interpretLeanLightReviewVerdict`, **now in** `src/remediate/riskSignal.ts`)" — the latter matches
  `documentation-philosophy.md`'s own cited example of the forbidden pattern ("now in `dispatch.ts`").
  Both facts verified true (function confirmed at `riskSignal.ts:520`); only the framing is the issue.
  Rewrite both timelessly, or is this history load-bearing context worth keeping?
- [DD-2] `spec/multi-ide-concurrent-runs-design.md` lines ~178-180 — "concrete values set in slice 2"
  paired with `(taskLeaseMs, heartbeatMs)` is stale: `taskLeaseMs` shipped
  (`AUDIT_TASK_CLAIM_LEASE_MS = 20 * 60_000`, `src/audit/cli/dispatch.ts:135`), but `heartbeatMs` as a
  literal symbol has zero occurrences in `src/` — the doc's own next paragraph confirms "no live
  heartbeat" for long-lived task claims. Nuance from this run's independent re-check: the underlying
  *mechanism* isn't actually missing — `withClaimHeartbeat` is fully implemented and wired to the
  short-lived `phase:main`/bundle-mutation mutexes under the names `CLAIM_HEARTBEAT_MS` /
  `PHASE_CLAIM_HEARTBEAT_MS` (both `10_000`) — it's a naming/scope mismatch (the spec's informal
  `heartbeatMs` shorthand was never wired to the long-lived task claims specifically), not a fully
  fictional feature. Drop the "pair"/"slice 2 concrete values" framing to match settled reality
  (lease-only for long-lived claims, backstopped by merge-time ownership), or is heartbeat extension to
  long-lived claims still intended future work needing a real tracking home?
- [DD-3] `spec/host-validation.md` — two related gaps, both re-verified this run: (a) still open from
  prior runs — the doc only has GUI-host live-dispatch checklist rows for `/audit-code`;
  `scripts/remediate/verify-hosts.mjs` exists, near-byte-identical to `scripts/audit/verify-hosts.mjs`,
  targets the same GUI-host set, and is wired into `verify:release` via `verify:remediate-hosts` — add a
  sibling remediate-code checklist section, or explicitly scope the doc's title/intro to audit-code-only?
  (b) NEW this run: the doc's Codex carve-out ("Codex is a headless CLI, so its live dispatch is
  automated instead of listed here — see the `RUN_PROVIDER_MATRIX_E2E=1`-gated e2e...") doesn't mention
  `agy`, which is architecturally the same class (headless CLI, correctly absent from the GUI-host
  table — confirmed zero `agy` occurrences in `INSTALL_HOST_DEFINITIONS`/`INSTALL_HOST_ORDER`) but has
  **no live-dispatch e2e coverage at all** — `tests/audit/provider-matrix-dispatch-e2e.test.mjs` only
  names `codex`/`opencode`/`openai-compatible`. Should the Codex carve-out sentence generalize to name
  `agy` too (even though adding the actual e2e coverage is a code change, out of this routine's scope)?
- [DD-4] `spec/cross-provider-quota-matrix.md` — NEW this run: §3 (Antigravity, ~lines 212-221) has a
  "BUILD CAVEAT" anticipating `agy`: *"the CLI's token store likely differs from the IDE's `state.vscdb`
  (separate app) — resolve `agy`'s credential path before building."* The shipped code instead aliased
  `agy` straight into the existing `AntigravityQuotaSource`
  (`ANTIGRAVITY_PROVIDER_NAMES = new Set(["antigravity", "agy"])`,
  `src/shared/quota/antigravityQuotaSource.ts`), which still reads only `state.vscdb`/
  `ANTIGRAVITY_ACCESS_TOKEN` (the IDE credential path) — confirmed by reading the full implementation,
  no agy-specific credential path exists anywhere in the file. The caveat's concern was bypassed by
  aliasing, not addressed. Two questions: (1) should the doc note that `agy` shipped as a same-mechanism
  alias rather than a distinct `QuotaSource`, so a future reader doesn't think the caveat is still
  simply unaddressed; (2) is reusing the IDE's token store for the CLI actually correct (does the `agy`
  CLI genuinely share Antigravity IDE's credential store), or is this a latent gap where `agy` quota
  reads could silently return null? (Unverifiable without a live `agy` install — a question, not an
  asserted bug.)
- [DD-5] `docs/backlog.md` — still open, re-confirmed: the "ad-hoc Agent fan-out has no per-agent
  ledger" sliver appears both folded into "Tool-prescribed host Agent fan-out is quota-INVISIBLE"
  (line 131) and as sub-bullet (b) of "Friction-walk lesson (ledger-writer / acceptNode-inert-clean
  lap)" (line ~191), which additionally names "recon/review/compaction" as fan-out sites. "compaction"
  as a coded fan-out site is still unevidenced (`grep -rln "compaction" src/ tests/` → zero hits,
  reconfirmed independently twice this run). Dedup the two entries (the older one has no unique
  remainder beyond "compaction"), and separately judge whether "compaction" is accurate or should be
  dropped from the parenthetical.
- [DD-6] `docs/backlog.md` — still open, evidence refreshed: the friction-walk-entry template (line 32:
  "a bold title + the `[[memory-tag]]` for the durable lesson") implies every entry should carry a
  `[[memory-tag]]`, but the 2026-07-12 entry (line 35) and 2026-07-11 entry (line 36) items carry none.
  Note: the specific example this item cited in the prior run (an item with both an inline tag and a
  memory-tag) was itself shipped-deleted this cycle — the general pattern still holds on the current
  entries, but any future carry-forward should re-derive its example rather than trust a stale citation.
  Plausible explanation: a `[[memory-tag]]` only appears where a durable memory concept was actually
  captured for that item (by-design, not a bug). Either state that rule explicitly in the template
  preamble, or treat as a real formatting gap needing a fix?
- [DD-7] `spec/audit-workflow-design.md` Gate 2 section — residual after this run's citation fix (the
  wrong-function/invented-threshold citation was auto-applied, see FYI below): "Cap is high (exact value
  TBD) to handle unusual projects" — no cap is implemented at all today (`buildExcludedSummary` is
  unbounded, only implicitly compacted by prefix-grouping; confirmed no "200" or any count constant
  anywhere in either file). Should this doc state the aggregation is currently unbounded, or is a
  row-count cap still intended future work that needs a real tracking home (e.g. `docs/backlog.md`)?
- [DD-8] `.claude/skills/ship/SKILL.md` — still open, re-verified, unchanged (no diff since last check,
  same line numbers): two "now"-framed changelog-creep phrasings — line ~17 "CI **now** runs the full
  suite sharded across parallel jobs (~2× faster) as the real gate..." and line ~37
  "`scripts/release-and-publish.mjs` **now** admits any branch whose HEAD already equals `origin/main`
  (`evaluateReleaseBranch()`)" — both facts confirmed true, only the past→present narration is at issue,
  matching `documentation-philosophy.md`'s named forbidden pattern. Approve a mechanical word-drop, or is
  the historical framing intentional here (a meta-tooling runbook, not a strict concept doc)?
- [DD-9] `docs/backlog.md` line ~146 — the "A doc-review auto-apply / hook re-reverted a COMMITTED owner
  decision" entry mixes an incident narrative + a durable **Trap:** sentence + an open **Tool fix:** ask.
  `CLAUDE.md` has no "Durable traps" section of its own — it explicitly points at `docs/backlog.md`'s own
  `## Durable traps (environment / tooling reference)` section (confirmed present, line 586) for exactly
  this class of note. Since the underlying fix is NOT shipped, this isn't a clean auto-apply
  relocate-then-delete (that's licensed only when the whole finding is shipped): propose moving the
  **Trap:** sentence into backlog.md's own Durable-traps section, and trimming this Open-bugs entry to
  just the still-open **Tool fix (open):** ask + a pointer to the relocated trap. Approve?
- [DD-10] `docs/HANDOFF.md` — the five newest `docs/backlog.md` entries (NIM auto-detection,
  quota-before-cost-ordering, per-model-tiering, orchestrator-dispatch-coupling design — the agy entry
  among them was itself resolved/deleted this run, see FYI) have no corresponding line anywhere in
  HANDOFF's "Suggested ordering"/"IMMEDIATE NEXT" sections. HANDOFF's own contract says every open item
  should appear once, in suggested order. Sequencing/priority call for you — not a factual defect, but
  should these be threaded in, and where?
- [DD-11] `docs/backlog.md` line ~328 — "Shared-logic dedup bundle — one marginal item still open." Read
  in full, every one of its four sub-bullets is actually a *closed* disposition: "Second-pass — 6
  shipped" (done), "Deliberately NOT built — Tier C... revisit only if a 6th cap site appears" (a closed
  won't-build decision, not open work), "Not-actionable but philosophy-consistent" (closed/explained),
  "Rejected catalog rows" (closed) — nothing in the body describes active work. This directly
  contradicts `docs/HANDOFF.md`'s own "External-audit program SHIPPED in full (V1–V7 + dedup bundle);
  only low-severity documented residuals remain." Recommend deleting the entry outright per the
  shipped-entry-deletion rule (no genuine remainder found), but flagging rather than auto-applying since
  the "Tier C revisit" threshold is a live decision worth a one-line confirmation before it's gone.
  Delete, or is there a remainder I'm missing?

### Doc-set condensation
- [CX-1] `spec/audit/artifact-contract.md` + `spec/audit/dependency-map.md` + `spec/audit/executor-catalog.md`
  — still open from prior runs, re-verified accurate against current code (zero new drift; counts
  independently recounted twice this run: `ARTIFACT_DEFINITIONS` = 37, `EXECUTOR_REGISTRY` = 26, both
  match): "which executor produces which artifact" is hand-maintained independently in two places
  (`executor-catalog.md`'s Produces column and `dependency-map.md`'s per-artifact rows) over the same
  registry pair — a prior run already had to fix one live drift instance between them. Should this have
  exactly one home (fold one into the other), or is the duplication an acceptable, differently-shaped
  view (catalog = by-executor, map = by-artifact) worth keeping as-is?
- [CX-2] `spec/audit/state-machine.md` — NEW this run: 34 lines total, roughly two-thirds pointer content
  (states enum + an "Obligations" section that just points at `orchestration-policy.md`/`nextStep.ts`,
  plus 3 of its 5 "Rules" bullets substantially restate `audit-goals.md`/`orchestration-policy.md`
  content). Candidate to fold into `orchestration-policy.md` as a subsection (which already owns "how the
  next obligation is chosen"). Preservation nuance confirmed by independent re-check: two facts are NOT
  duplicated elsewhere and must survive a fold — the `synthesis_current`-gating precision (satisfied only
  when `audit-report.md` is current) and the "Blocked behavior" paragraph (write-minimal-state
  description). Fold with those two facts explicitly carried over, or keep as a standalone file?
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-agent gate ran this run, scoped to everything changed since the last check (commit
`428aed40` → `f0bcac3`, 4 commits: a new `agy` provider — headless Gemini CLI, PATH-auto-detected with a
`gemini` binary fallback — shipped across `src/audit|remediate|shared/providers` + quota wiring, plus one
`docs/backlog.md` friction-entry addition). 4 reviewer agents (ops/package/provider surface + meta-tooling;
backlog.md + HANDOFF.md; audit-side `spec/audit/*` cluster; remaining `spec/` + policy + philosophy),
each examining every in-scope item in their cluster against live code — including a dedicated sweep of
all 6 candidates flagged "unverified, needs a pass" by the prior run's DD-8 — then 4 independent adversary
agents re-checked every item from scratch (not just the reviewer's flagged ones; several adversaries
independently spot-checked "no-issue" files the reviewer hadn't found anything in, and independently
recounted registry sizes rather than trusting the reviewer's counts).

**Zero items were contested** (no reviewer/adversary disagreement in any cluster this run) — every
disposition converged, so no Judge calls were needed. Adversaries did add refinements incorporated above
(DD-2's "mechanism exists under a different name" nuance, DD-9's causal-trace correction, DD-11's
cross-doc corroboration, CX-2's preservation nuance) and surfaced 2 new findings of their own (the
`backlog.md:266` broken relative link, both auto-applied below).

10 stale-factual-fixes landed on `main` in 4 discrete commits:

- `docs/audit-pkg/operator-guide.md`, `examples/README.md`, `src/audit/README.md` — added the new `agy`
  provider to three provider-enumeration lists that predated it.
- `docs/backlog.md` — deleted a stray unmatched `**` left over from a botched entry-splice merge; deleted
  an orphaned duplicate paragraph (content already correctly present a few lines below under its own
  entry); deleted the "Gemini CLI (agy) not auto-detected" entry outright (the gemini-PATH fallback it
  asked for shipped in the same commit window, verified via the live predicate chain in
  `providerFactory.ts` plus a passing test exercising the zero-config case); trimmed the "A2b
  unmatched-quota fallback" entry to its two still-open residuals; fixed a relative link to
  `spec/audit/dispatch-admission-control.md` missing its `../` prefix.
- `docs/HANDOFF.md` — trimmed the Live-state section's changelog-creep bullet (narrated 8 sub-fixes +
  a status checklist duplicating the Track-status section further down), which the section's own
  preamble explicitly forbids.
- `spec/audit-workflow-design.md` — fixed a stale aggregation-function citation in the Gate 2 scope
  pre-digest section: the doc cited `buildFileDisposition` (whose own code comment says it deliberately
  does NOT aggregate) with an invented "vcs-ignored files above 200" threshold; corrected to
  `buildExcludedSummary` (`src/audit/orchestrator/intentCheckpointExecutor.ts`), which aggregates all
  excluded files generically with no count threshold.

Also resolved (closed, not carried forward): the prior run's DD-8 ("needs a dedicated pass" flag over 6
backlog.md entries) — this run did that pass; 5 of the 6 candidates verified genuinely clean (no
shipped-narrative bloat, no stale claims), the 6th became DD-9 above.

Green gate: `npm run build && npm run check && npm test` — 490 test files / 6432 tests, all green (11
skipped, expected gated e2es). `check-doc-manifest.mjs` also re-verified clean (18/18 tracked docs
registered). Each change landed as one discrete, revertible commit on `main` (`668621b`, `8740bd7`,
`e60fcf5`, `03339a4`).
