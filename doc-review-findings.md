# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [IF-1] `CLAUDE.md` — the remediate-code architecture section still describes a "document phase
  (`ItemSpec` per finding: concrete changes, tests to write) — in `src/remediate/steps/dispatch.ts`"
  as a current phase — but `tests/remediate/n-r13-document-phase-dissolved.test.ts` (N-R13) confirms
  this phase is dissolved: planning transitions directly to implementing, `"documenting"` is not a
  valid status, and `item_spec` is optional with dispatch falling back to `finding.affected_files`.
  Approve rewording this bullet to describe the actual mechanism (`runPlanningReviewGate` +
  `runPlanAmbiguityGate`, no per-item LLM write-up)?

### Design decisions for you
- [DD-1] `docs/project-philosophy.md` §B3 — the raw item, verbatim: *"Keep the two orchestrators in
  parity — a fix in one usually belongs in both; shared logic → `audit-tools/shared`."* This
  contradicts CLAUDE.md's current Preferences bullet ("One core, two draws"), which explicitly
  rejects the "parity" framing: *"the default is one shared core + per-mode policy/draw, NOT two
  forks kept 'in parity.'"* The home moved; B3's restatement didn't follow. Reword B3 to match?
- [DD-2] `docs/glossary-ids.md` `FND-` row — verbatim: *"Obligation-bound finding reference — the
  same auditor finding id wrapped as a remediation obligation handle (`FND-OBS-99e3a861`); the `FND-`
  prefix marks it as the unit a remediation node satisfies."* Every `FND-` occurrence in the tree is
  an audit-side self-referential source comment citing this repo's own past self-audit finding
  (`ARC-d81a55ab` pattern) — zero hits anywhere in `src/remediate/**`. Remediate never mints or
  consumes an `FND-`-prefixed obligation handle. Reword to describe it as a self-audit finding
  citation, not a remediation-obligation wrapper?
- [DD-3] `docs/backlog-remediation-design.md` — verbatim: *"D8 is the only genuinely-open item in
  this doc; it should be tracked as open work in `backlog.md`."* Zero "D8" hits anywhere in
  `docs/backlog.md`. The thematically-matching entry ("Narrow staleness on prose-heavy artifacts via
  bounded semantic judgment," Deferred/waiting section) is unlabeled. Is that the same item — should
  it be labeled D8 — or should this doc stop naming a backlog id it can't guarantee stays synced?
- [DD-4] `docs/HANDOFF.md` ▶ IMMEDIATE NEXT — its ~9-line "Watch — summary only" recap duplicates
  `docs/backlog.md`'s Live-validation guide closely enough that one can drift without the other,
  despite the explicit "authoritative pass/fail is the ⬇ line in backlog" disclaimer. Trim to a bare
  pointer, or is the standalone recap intentional (HANDOFF launchable without cross-referencing
  backlog mid-run)?
- [DD-5] `docs/backlog.md` — the "Friction-walk" entries are trending back toward a per-lap
  changelog even after this run's condensation (3 full-paragraph entries added this window, now
  condensed/deleted using the same pattern already applied to older entries). Formalize a standing
  "Friction-walk template: title + `[[memory-tag]]` + open slivers only, no shipped narrative"
  convention note near the top of "Open bugs / frictions" so future entries self-condense at write
  time instead of needing a subsequent doc-review pass?
- [DD-6] `docs/audit-pkg/product.md` — verbatim: *"provider adapters such as `claude-code`,
  `opencode`, `subprocess-template`, and `vscode-task` are compatibility bridges..."* `PROVIDER_NAMES`
  (`src/shared/types/sessionConfig.ts`) also includes `codex`, `openai-compatible`, `antigravity` —
  omitted from this hedged "such as" example set. Expand the roster, or keep intentionally
  illustrative (accepting it trails new backends)?
- [DD-7] `docs/audit-pkg/contracts.md` — "Current deterministic import edges include..." / "Current
  deterministic reference edges also include..." (Graph contract section). Every named edge kind
  checked out accurate today, but the "Current X include Y" enumeration is exactly the
  changelog/progress-creep pattern `documentation-philosophy.md` forbids in concept docs — it will
  silently understate as new edge kinds ship. Reword as a durable pointer to the extractors registry
  (`src/audit/extractors/`), or accept the enumeration as intentionally illustrative?
- [DD-8] `docs/audit-pkg/release.md` — verbatim: *"Routine CI exercises the Node majors matrixed in
  `.github/workflows/*.yml` (currently Node 20 and Node 22)."* A pinned status string per
  `documentation-philosophy.md`'s smell list (confirmed accurate today: `20.19.2`/`22.14.0`, each
  introduced once with no subsequent churn). Drop the parenthetical (self-describing from the
  workflow file), or keep it as a convenience note this routine re-verifies each pass?
- [DD-9] `.claude/skills/start-lap/SKILL.md` — verbatim: *"risk-tier it first
  (`[[risk-tier-loop-laps-cheap-vs-heavy]]`: loop-core work → full pipeline, trivial mechanical →
  lean) — unless the owner redirects."* Reads as a binary fork, the exact shape
  `project-philosophy.md`'s A6 ("Two continuous dials... explicitly ONE pipeline, not a separate
  lean path") was written to correct. Reword to a dial framing ("scale pipeline depth to
  risk-tier"), or is the underlying `[[risk-tier-loop-laps-cheap-vs-heavy]]` memory item genuinely a
  continuous dial that this SKILL is just summarizing tersely?
- [DD-10] `.claude/skills/ship/SKILL.md` — verbatim: *"the local preflight is a quick fast-fail, not
  the full run"* (CI-staging split). Both reviewer and adversary independently concluded this is
  likely out of A6's scope (Part B dev-ops CI staging, not Part A's product review-pipeline
  conviction) — flagging only for your confirmation; no change proposed unless you disagree.
- [DD-11] `spec/audit/audit-goals.md` — the doc never mentions `audit-findings.json` anywhere and
  calls `audit-report.md` "the final authoritative output," but CLAUDE.md states
  `audit-findings.json` is the machine contract / source of truth and `audit-report.md` is its
  render (both are promoted together by `promoteFinalAuditReport`). Reconcile which is
  "authoritative" here, or name both explicitly?
- [DD-12] `spec/audit/audit-goals.md` — the "LLM responsibilities" list (semantic review of assigned
  files + critical-flow fallback only) omits the entire charter/conceptual-design-review/systemic-
  challenge/synthesis-narrative `host_delegation` layer — 9 executors
  (`provider_confirmation_executor`, `intent_checkpoint_executor`, `charter_extraction_executor`,
  `charter_delta_executor`, `design_review_contract`, `design_review_conceptual`,
  `charter_clarification_executor`, `systemic_challenge_executor`, `synthesis_narrative_executor`),
  all live in the `PRIORITY` chain. This is a NORMATIVE doc; fixing this needs a conceptual rewrite
  of the section (not a one-line patch) describing when this layer runs. How would you like it
  described?
- [DD-13] `spec/audit/audit-goals.md` — `edgeReasoning.ts` (part of `graph_enrichment_current`,
  called "deterministic") accepts host/LLM-supplied rewrites for low-confidence graph edges — an
  additive LLM touch with no carve-out in this doc's deterministic-responsibilities list. Add a
  parenthetical noting this optional sub-step (mirroring the synthesis-narrative carve-out
  elsewhere), or is "deterministic" meant structurally (edge identity/confidence), leaving current
  wording fine?
- [DD-14] `spec/audit/entrypoint-contract.md` — verbatim: *"The current shipped surface for that call
  is the conversation-first `audit-code next-step` CLI / `/audit-code` slash command... `advance_audit`
  is the logical name those executors sit behind."* Reads as current-state narration
  (`documentation-philosophy.md`'s forbidden "now in dispatch.ts" shape) rather than durable
  aspirational/precursor framing, though the doc's own opening line does declare an
  aspirational/current split as its intended durable content — a genuinely borderline call. Reword
  to defer the concrete command names elsewhere and keep this doc to "the product surface is
  `advance_audit`; everything else is an interim precursor," or is the current wording acceptable?
- [DD-15] `spec/cross-provider-quota-matrix.md` — verbatim: *"**Refresh** (on 401):
  `POST https://auth.openai.com/oauth/token`, `grant_type=refresh_token`,
  `client_id=app_EMoamEEZ73f0CkXaXp7hrann`."* `src/shared/quota/codexQuotaSource.ts` implements no
  refresh-on-401 logic at all (`fetchSnapshot` just returns `null` on failure); zero hits for this
  client id or endpoint anywhere in `src/`. This line isn't `✓ LIVE-CONFIRMED`-tagged like the
  verified claims elsewhere in the same doc, so it may be intended as ecosystem/protocol background
  rather than a claim about our own code — but it reads ambiguously alongside the confirmed facts.
  Add a "not implemented in `CodexQuotaSource` — informational only" caveat, or is the research-log
  framing itself the intended content?
- [DD-16] `spec/conceptual-design-review-design.md` — verbatim: *"`ClarificationRequest` /
  `waiting_for_clarification` — charter-alignment questions are these, sourced from charter-deltas
  instead of implementation ambiguity."* Audit built a separate `CharterClarificationRequest` type
  (`src/audit/types/charterClarification.ts`) with a materially different shape from remediate's
  `ClarificationRequestSchema`, and audit has no `waiting_for_clarification` status at all (only
  `not_started`/`active`/`blocked`/`complete`). Was building a parallel type a deliberate,
  scope-appropriate divergence, or should this be reconciled under CLAUDE.md's "one core, two draws"
  — and should the "reuse, don't rebuild" heading be corrected either way?
- [DD-17] `spec/multi-ide-concurrent-runs-design.md` — the OD3 paragraph ("Partially shipped for the
  long-lived-claim mechanism...") narrates shipped/open status with a specific backlog ticket
  ("D-66/67 slice-1... shipped") inside an otherwise-timeless design doc — `docs/backlog.md` already
  tracks this in more detail. Trim to a timeless two-layer-architecture statement, leaving
  shipped/open narrative solely to backlog.md, or is this an acceptable exception for an
  actively-landing mechanism?
- [DD-18] `spec/multi-ide-concurrent-runs-design.md` — verbatim: *"No TTL/heartbeat as run-liveness
  (D2 from the first draft still holds)."* No "D2" is defined anywhere in the repo — a dangling
  reference. What does this point to, or should it be restated standalone?
- [DD-19] `spec/remediate/remediation-goals.md` (NORMATIVE) — the "Phase 2: Document" section, Core
  Principle #2, and the "Parallelism" section's `public_contract` claim all describe/assume a
  per-item LLM document-authorship phase that `tests/remediate/n-r13-document-phase-dissolved.test.ts`
  (N-R13) confirms is dissolved — planning now transitions directly to implementing via
  `runPlanningReviewGate` + `runPlanAmbiguityGate` (a materially different, deterministic-heuristic-
  seeded mechanism, not a drop-in rename). Separately, the "Parallelism" section's claim that
  `public_contract` dependency inference "can be revoked by the LLM in Phase 2" is dead — zero
  consuming logic anywhere — and contradicts the doc's own earlier caveat that this isn't wired.
  This needs a substantive rewrite across ≥4 sections of a NORMATIVE doc, not a narrow patch: how
  should the replacement architecture (deterministic-seeded ambiguity gates, no per-item write-up)
  be described? (Note: CLAUDE.md's own remediate-code section carries the identical staleness — see
  [IF-1] above.)
- [DD-20] `spec/remediation-workflow-design.md` — the pipeline-order diagram (now includes
  `critique`/`cyclic_seam_resolution`/`assessment` per this run's fix) doesn't explicitly map onto
  CLAUDE.md's 5-state machine (`pending→planning→implementing→closing→complete`) — a reader has to
  infer that everything through `contract_pipeline` is "planning" and `rolling_dispatch` is
  "implementing." Worth one explicit mapping sentence?
- [DD-21] `spec/self-scaling-pipeline-design.md` — `leanFastPath.ts` now holds only the low-tier's
  two small mechanisms post-fold (confirmed a genuine dial-branch, not a forked path — A6-compliant).
  Is keeping it as a separately-named module still justified long-term, or should its functions
  relocate into `riskSignal.ts`/`contractPipeline.ts` so the filename stops reading as a vestige of
  the pre-fold "separate lean path" era?

### Doc-set condensation
- [CX-1] `spec/audit/audit-goals.md` + `spec/remediate/remediation-goals.md` — both NORMATIVE goals
  docs carry the same drift pattern this run: each was not updated when a real architectural layer
  shipped/changed in its area (charter/conceptual-design-review executors for audit; document-phase
  dissolution for remediate), while the peer, more mechanism-focused doc in each pair
  (`conceptual-design-review-design.md`, `remediation-workflow-design.md`) stayed current. Propose a
  standing process note: a goals doc gets a "does this still match the executor/phase registry"
  check whenever a new obligation/phase ships in its area, rather than waiting for the next
  doc-review pass to discover it.
- [CX-2] `spec/audit/artifact-contract.md` + `spec/audit/dependency-map.md` +
  `spec/audit/executor-catalog.md` — three separate documents over the same ~26–37-row
  artifact/executor entity set (identity+format+purpose; staleness dependencies;
  producer+obligation+output). Each explicitly disclaims duplicating the others' axis, which is
  working (no literal content drift found). Is the three-document split intentional (one doc per
  orthogonal axis of the same entity — arguably satisfies "split only when carrying two unrelated
  concepts," in reverse, since these are related), or should they condense into one
  registry-reference doc with multiple table sections?
- [CX-3] `docs/backlog.md` — the "Friction-walk" entries, see [DD-5]. Same underlying
  changelog-creep tension, not separately numbered.

Canonical-manifest check: every tracked `docs/**/*.md` (and every tracked `*.md` outside `docs/`)
still appears in exactly one row (or the excluded row) of `doc-review-guidelines.md`'s routing
table — 40/40 non-`docs/` tracked `*.md` files independently re-verified this run (this closes out
the item formerly tracked as backlog's D-45(a), now deleted as resolved). No strays this run.
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-agent gate ran this run: 4 reviewer agents (covering rubric+instruction docs;
backlog.md+HANDOFF.md; package docs/README/meta-tooling; all 19 `spec/**/*.md` files) each examined
every in-scope item against live code, followed by 4 independent adversary agents that re-checked
every item (flagged AND "OK") from scratch. All contested classifications were resolved by this
session acting as judge, defaulting to escalate on any uncertainty (e.g. `glossary-ids.md`'s `FND-`
row and `audit-goals.md`'s "LLM responsibilities" list were reviewer-flagged as
stale-factual-fix but judged to design-decision, since correcting them requires describing
different/new architecture, not a mechanical swap).

- `docs/glossary-ids.md` — fixed three primary-owner/site references: `INV-CC`'s literal token is in
  `src/shared/intake/guidanceBootstrap.ts` (not `nextStepCommand.ts`); `INV-RPS`'s is in
  `src/remediate/phases/triage.ts` (not `crossLensDedup.ts`); `INV-QD-15`/`INV-QD-16`'s site sentence
  over-attributed both tokens to three files — split so each points at its actual site.
- `docs/backlog.md` — deleted three fully-shipped entries with no open remainder (charter-layer
  defects lap, quota-Increment-A friction lap, the D-45(a) doc-manifest-scope item whose own stated
  question is now answered — 40/40 non-docs/ `*.md` files routed). Merged two friction-walk entries
  (lease-TTL lap, untracked-scope lap) that independently reported the identical still-open bug
  (doc-review's clear-on-apply ledger is local-only and re-surfaces resolved items to a stale
  worktree) into one condensed lesson entry.
- `spec/audit/audit-goals.md` — corrected the completion-cleanup claim: the doc said cleanup is
  "decoupled from the completion transition" and the transition "never triggers it," but
  `promoteFinalAuditReport` unconditionally deletes the working artifacts dir on completion (tested,
  `audit-code-completion.test.mjs`) — folded into promotion, not routed through
  `cleanupStaleArtifactsDir` (which instead clears a *stale* dir from a prior run).
- `spec/audit/executor-catalog.md` — `EXECUTOR_REGISTRY` has 26 entries, not 25 (the doc's own
  per-phase tables already summed to 26).
- `spec/dispatch-cost-speed-dial.md` — the bias is read back by a separate sibling function,
  `readConfirmedDispatchBias`, never an extension of `readConfirmedCostPositions` as the doc claimed.
- `spec/multi-ide-concurrent-runs-design.md` — `driveRollingImplementDispatch` is defined in
  `nextStep.ts`, not `dispatch.ts`; `reclaimStale()` has zero call sites anywhere — `claim()` grants
  over a stale existing lease inline, with no separate reclaim step.
- `spec/remediation-workflow-design.md` — the pipeline-order diagram and the multi-agent
  seam-negotiation numbered list both omitted three real, artifact-producing phases from
  `CONTRACT_PIPELINE_PHASE_ORDER` (`critique`, `cyclic_seam_resolution`, `assessment`) — inserted all
  three in their correct position.

Green gate: `npm run build && npm run check && npm test` — 486 test files / 6323 tests, all green.
Each change above landed as one discrete, revertible commit on `main`.
