# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [CLAUDE-5] `CLAUDE.md` ~line 108 — the `claude-worker` description still says it spawns `claude -p`
  "through a repair-proxy overlay onto a free backend" and cites `spec/unified-dispatch-worker-model.md`
  for "requiring repair-proxy when a node needs file access." Re-verified tonight (2 independent
  adversary passes, both against `src/shared/providers/auditorSources.ts`): "repair-proxy" remains
  genuinely RETIRED, not renamed — `auditorSources.ts` explicitly rejects a declared `repair_proxy` key
  ("repair_proxy is retired — declare a proxy block instead"). The replacement is a generic
  LiteLLM-backed `proxy` block with no tool-call-repair semantics and different discovery
  (`GET /v1/models` + `GET /model/info`, not the old `/registry`). Proposed: replace "spawns `claude -p`
  through a repair-proxy overlay onto a free backend" → "spawns `claude -p` through a generic
  (LiteLLM-backed) `proxy` overlay onto a free backend", and "requiring repair-proxy when a node needs
  file access" → "requiring a proxy transport when a node needs file access."

### Design decisions for you
- [DD-2] `spec/unified-dispatch-worker-model.md` — same repair-proxy retirement as CLAUDE-5 above, but
  this file has ~15 live references including a whole section header ("## repair-proxy — the kind-1
  launch transport"), the worker-taxonomy table, and a discovery-feeder claim tied to the old `/registry`
  endpoint that has no equivalent post-swap. Confirmed still unaddressed tonight (this doc's own
  `git diff 612d588..HEAD` is empty — untouched since last night). This is a functional redescription
  (what replaces the deleted discovery/repair behavior, if anything), not a narrow substitution, so it
  needs your judgment on replacement prose rather than a blind auto-apply. Should this section be
  rewritten around the actual current mechanism (declaration shape `{endpoint, top_k?, cost_per_mtok?,
  api_key_env?}`, discovery via `/v1/models`+`/model/info`, no repair function at all — graceful
  degradation and never-a-hard-dependency can carry over largely unchanged), and should the file's
  organizing concept move away from "repair-proxy" entirely?
- [DD-6] `spec/audit-workflow-design.md` ~line 278 — "...both frozen after one always-on LLM estimate
  review." Re-verified tonight: `computeRiskEstimate` is still purely deterministic arithmetic (no
  LLM/provider call anywhere in its path); a full-codebase grep (including `git log -S`) for "estimate
  review"/"estimateReview" as an identifier still returns zero hits outside this doc's own prose. Was
  this always-on LLM review step ever built, or is it vestigial/aspirational design text that should drop
  the "after one always-on LLM estimate review" clause? (Note: this run's own stale-factual-fix to the
  adjacent edge-kind-ordering sentence in the same paragraph deliberately left this clause untouched,
  since it's a judgment call, not a narrow substitution.)
- [DD-7] `spec/remediate/remediation-goals.md` — this normative goals doc's Phases/Resume-semantics/
  Completion sections still never mention the `quota_paused` retryable-pause mechanism, even though it's
  real and wired (`step_kind: "quota_paused"`, `buildQuotaPausedStep` in `src/remediate/steps/nextStep.ts`)
  and `spec/remediation-workflow-design.md` already documents it. Re-verified tonight: doc unchanged since
  last night, gap confirmed still real. Should `remediation-goals.md` gain a mention (inline or a pointer
  to `remediation-workflow-design.md`'s existing section), or is this intentionally left out of the
  normative product doc as an implementation-level pause distinct from the phase/completion contract?
- [DD-8] `docs/backlog.md` — "Unify the full rolling-dispatch lifecycle shell across audit + remediate
  (doc-review D-66/D-67/C-7)..." (currently ~46 lines). Re-verified tonight: entry is byte-identical since
  last night, still opens with shipped-status narrative ("Slice-1 SHIPPED... slice-2 VERIFIED not worth
  building...") before reaching the genuinely open slice-3 heartbeat work. Should this be trimmed to just
  the slice-3 open work (relocating the architecture recap to a spec doc, e.g.
  `spec/multi-ide-concurrent-runs-design.md`, which already owns OD3), or is the recap load-bearing enough
  to keep as-is (it explains why full unification was rejected, preventing re-litigation)?
- [DD-9] `docs/backlog-remediation-design.md` — "**semantic-equivalence gate (O2↔F1↔D8):** O2 exports ONE
  reusable gate; F1/D8 consume." Re-verified tonight: `grep -rln 'intentCheckpointGate' src tests` still
  finds only its own file + its own test — zero production importers. F1's actual mechanism
  (`src/audit/orchestrator/resultBaseline.ts`) uses a plain deterministic content-key comparison instead.
  Is the LLM-judge gate dead/unwired code F1 was meant to wire in and never did, or does the doc overstate
  current wiring and should read "F1/D8 will consume" (or scope to D8 only, once landed)?
- [DD-10] `docs/end-of-sprint-report-template.md` — the "Friction this sprint" section still uses four
  named dimensions (Gate/tool re-loops; Integration-guard/cross-cutting failures; Re-scopes/surprises;
  Open-ended) that don't map onto the single-sourced `FRICTION_CATEGORIES` vocabulary
  (`ambiguous_direction`/`tool_should_decide`/`inefficient_feeding`, `src/shared/friction/frictionRecord.ts`)
  that `docs/project-philosophy.md` B6 ties dev-workflow friction logging to. Re-verified tonight: section
  unchanged, mismatch still real. Is the sprint-closeout template's taxonomy deliberately a separate axis
  (dev-sprint retro vs. product mechanical-capture are different domains), or should it be recast in the
  single-sourced vocabulary for consistency?
- [DD-12] `spec/audit/dispatch-admission-control.md` ("Deriving the per-pool token budget" section,
  ~lines 299-364) — this section describes a single MIN-collapsed-scalar budget derived via a function
  `resolvePoolBudget()` that no longer exists anywhere in the codebase (`grep -rn "resolvePoolBudget"
  src/` → zero hits). The shipped replacement (new file `src/shared/quota/windowConstraints.ts`) builds
  one `AdmitConstraint` per active quota window, all-or-nothing — a genuinely different admission model,
  not a renamed function. The section's `windows[]` snapshot description is also missing a new required
  `scope` field (`QuotaWindowSchema` in `src/shared/quota/quotaSource.ts`; `scope: 'account'|'model'`, no
  default). This is a substantial rewrite (whole section, ~65 lines), too broad for a narrow auto-apply.
  Should this section be rewritten around the multi-constraint / window-scoped model (`WindowBudget.scope`,
  the `acct:`/`pool:` `windowResourceKey` split, all-or-nothing admit semantics), and if so do you want it
  drafted for review or would you rather write the replacement yourself given how central this doc is?
- [DD-13] `spec/audit/dispatch-admission-control.md` ("Legibility" section, ~lines 235-239) — the doc
  presents `resource_key` in the admission-explain record as a plain pool identifier explaining "why the
  fan-out was the width it was." But `AdmissionGrant.resource_key`'s own doc comment
  (`src/shared/dispatch/admissionLoop.ts:200-209`) now reads "⚠ DIAGNOSTIC PROVENANCE ONLY... Once steps
  3-4 supply multiple constraints this field records only ONE of N and will look authoritative while being
  partial" — and multi-constraint admission is now actually wired (confirmed: `windowConstraintsFor` is
  called and can return several constraints, while `resource_key` still records only one). Should the
  doc's description of the explain record be updated now to state this partiality, or is that deferred
  until the tracked backlog follow-up (making it a key array) actually lands, so the doc is just
  describing a known interim gap?
- [DD-14] `spec/backend-identity-axes.md` ("The exclusion grammar: axis-explicit" section, ~lines 166-220)
  — presents `transport:`/`service:`/`host:` prefixed exclusion rules as shipped, present-tense behavior.
  Verified: the live parser (`parseExclusionRule`/`ruleMatches` in
  `src/shared/providers/sharedProviderConfirmation.ts`) implements only the old
  `{provider, provider_model, endpoint}` grammar — no axis-prefix parsing exists at all; an unrecognized
  head token silently falls through to the `endpoint` kind. The doc's own later subsection ("Three
  conditions this change must satisfy... Ship a one-shot migration") reveals in its own words that this is
  an unshipped proposal, contradicting the present-tense framing above it. Do you want this section
  explicitly re-framed as "PROPOSED — NOT YET IMPLEMENTED" (a `> Status:` preamble is permitted for
  `spec/` docs) so a reader doesn't write an inert `service:` rule that silently matches nothing? Or is
  implementation imminent enough that the doc should stay as-is?
- [DD-15] `spec/backend-identity-axes.md` ~lines 23,35 — two version-pinned references ("fixed in
  v0.33.11", "Service-qualifying the gate key (v0.33.11) turned that same collision into a LIVELOCK") are
  factually accurate but match the guidelines' status-noise smell (a pinned version string in a prose doc
  is not a factual claim to bump). De-status these (drop the version number / restate as "an earlier fix"),
  or is the pin intentionally kept as a durable historical anchor tied to a specific defect narrative
  (bypass → livelock) rather than "current state"?

### Doc-set condensation
- [CX-3] `README.md`'s "## Philosophy" section (~lines 22-33) restates `docs/project-philosophy.md`'s A2
  ("right tool, not deterministic dogma"), A4 ("everything-agnostic by default"), and A7 ("delegate
  adversarial phases to a separate agent") in different prose — a fact living in two homes, drift risk if
  one is updated without the other. Still open (re-verified independently by two separate reviewer/
  adversary passes tonight, both confirming the same three sections). Keep as a distinct user-facing
  summary (different register: terse, no jargon like "A2"/canonical-home citations), or replace with a
  one-line pointer to `project-philosophy.md`? If kept, should `project-philosophy.md` note that README
  carries a condensed public-facing version, so a future edit to the convictions knows to check both?
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Full three-tier gate ran this run (checkpoint `612d588` → `fe77ef0`, 43 files changed since the last
checkpoint — the account-scoped/window-scoped quota-metering rework: new `src/shared/quota/windowConstraints.ts`,
heavy changes to `accountId.ts`/`apiPool.ts`/`capacity.ts`/`reservationLedger.ts`/`scheduler.ts`, and the
admission/dispatch loop). 7 reviewer agents each examined every in-scope item in their doc cluster against
live code (backlog.md+HANDOFF.md; the quota/dispatch spec cluster; the `spec/audit/*` cluster; the
remaining `spec/*` cluster; `docs/audit-pkg/*`+README.md; the 6 design/concept docs; instruction files +
meta-tooling + package READMEs + generated host assets), then 3 independent adversary agents re-verified
every candidate finding from scratch (not trusting the reviewer's stated evidence) plus the 6 still-open
items carried from last night's escalation. Result: 24/24 candidate findings confirmed, 0 refuted, 0
contested — so no judge pass was needed this run. One carried-forward item (DD-1, capability-evidence
round status) turned out to already be resolved on `main` since last night (both `backlog.md` and
`HANDOFF.md` were independently rewritten to the current round count with an explicit unmerged-branch
caveat) and was dropped from tonight's escalation.

Applied:
- `docs/backlog.md`: deleted 2 shipped/duplicate `INV-shared-core-14` bullets (the fix — stubbing
  `createCodexProvider`/`createAgyProvider` — shipped in commit `71f81f4`, test now passes) and a shipped
  "backend identity is ONE function" SPEC bullet (shipped in `f3c9e66`+`b194c10`; its narrower surviving
  residual is already tracked separately at the "RESIDUE ONLY" bullet); fixed 2 stale line-number
  citations (`admissionLoop.ts:307-319`→`535-549`, `dispatch.ts:679`→`754`, both moved by the quota
  rework's diff); corrected a test-baseline count/parenthetical that cited the now-fixed
  `INV-shared-core-14` as a persistent main failure.
- `spec/audit/dispatch-admission-control.md`: the admission-explain `reason` enum was missing 2 of the 6
  real values (`packet_oversized`, `window_uncalibrated`) added by the quota rework.
- `spec/audit-workflow-design.md`: task-affinity edge-kind ordering didn't match the live `KIND_WEIGHT`
  priority in `taskAffinityGraph.ts` (also conflated two distinct weighted kinds into one phrase).
- `spec/unified-dispatch-worker-model.md`: `opencode` was misclassified as a single-shot API backend
  (kind-3, no tool loop); it's actually a spawned CLI agentic harness (kind-2) per `opencodeProvider.ts`'s
  own docblock.
- `docs/doc-review-routine-prompt.md`: the green gate step omitted the non-negotiable `npm test` step
  (conflicted with `doc-review-guidelines.md`, which wins per this file's own conflict-resolution rule);
  named two `AGENTS.audit.md`/`AGENTS.remediate.md` files that never existed in this repo's git history.
- `docs/backlog-remediation-design.md`: named a nonexistent `frictionCapture.ts`; the real file is
  `src/shared/friction/captureFrictionEvent.ts`.

Full green gate (`npm run build && npm run check && npm test`) passed before push — 511 passed | 5 skipped
test files, 6858 passed | 13 skipped tests, exit 0, no failures. One discrete commit (`doc-review: nightly
pass — 11 stale-factual-fixes applied, 12 items escalated`), pushed to `main`.
