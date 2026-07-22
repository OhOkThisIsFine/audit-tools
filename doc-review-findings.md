# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
- [CLAUDE-5] `CLAUDE.md` ~line 108 — the `claude-worker` description still says it spawns `claude -p`
  "through a repair-proxy overlay onto a free backend" and cites `spec/unified-dispatch-worker-model.md`
  for "requiring repair-proxy when a node needs file access." Re-verified tonight (against HEAD
  `eba802c8`): "repair-proxy" remains genuinely RETIRED, not renamed — `auditorSources.ts` explicitly
  rejects a declared `repair_proxy` key ("repair_proxy is retired — declare a proxy block instead").
  The replacement is a generic LiteLLM-backed `proxy` block with no tool-call-repair semantics and
  different discovery (`GET /v1/models` + `GET /model/info`, not the old `/registry`). Proposed: replace
  "spawns `claude -p` through a repair-proxy overlay onto a free backend" → "spawns `claude -p` through a
  generic (LiteLLM-backed) `proxy` overlay onto a free backend", and "requiring repair-proxy when a node
  needs file access" → "requiring a proxy transport when a node needs file access." Unaffected by
  tonight's diff (CLAUDE.md changed this window, but a different bullet — "Green-at-every-commit" gained
  the `--attester-class` flag text; this bullet is untouched).

### Design decisions for you
- [DD-2] `spec/unified-dispatch-worker-model.md` — same repair-proxy retirement as CLAUDE-5 above, but
  this file has ~15 live references including a whole section header ("## repair-proxy — the kind-1
  launch transport"), the worker-taxonomy table, and a discovery-feeder claim tied to the old `/registry`
  endpoint that has no equivalent post-swap. Confirmed still unaddressed tonight — untouched since last
  night. This is a functional redescription (what replaces the deleted discovery/repair behavior, if
  anything), not a narrow substitution, so it needs your judgment on replacement prose rather than a
  blind auto-apply. Should this section be rewritten around the actual current mechanism (declaration
  shape `{endpoint, top_k?, cost_per_mtok?, api_key_env?}`, discovery via `/v1/models`+`/model/info`, no
  repair function at all — graceful degradation and never-a-hard-dependency can carry over largely
  unchanged), and should the file's organizing concept move away from "repair-proxy" entirely?
- [DD-6] `spec/audit-workflow-design.md` ~line 278 — "...both frozen after one always-on LLM estimate
  review." Re-verified tonight: `computeRiskEstimate` is still purely deterministic arithmetic (no
  LLM/provider call anywhere in its path); a full-codebase grep (including `git log -S`) for "estimate
  review"/"estimateReview" as an identifier still returns zero hits outside this doc's own prose. Was
  this always-on LLM review step ever built, or is it vestigial/aspirational design text that should drop
  the "after one always-on LLM estimate review" clause?
- [DD-7] `spec/remediate/remediation-goals.md` — this normative goals doc's Phases/Resume-semantics/
  Completion sections still never mention the `quota_paused` retryable-pause mechanism, even though it's
  real and wired (`step_kind: "quota_paused"`, `buildQuotaPausedStep` in `src/remediate/steps/nextStep.ts`)
  and `spec/remediation-workflow-design.md` already documents it. Re-verified tonight (the touched region
  of `nextStep.ts` this window only threads a new `capabilityRanks` param through dispatch calls,
  unrelated): doc unchanged, gap confirmed still real. Should `remediation-goals.md` gain a mention
  (inline or a pointer to `remediation-workflow-design.md`'s existing section), or is this intentionally
  left out of the normative product doc as an implementation-level pause distinct from the
  phase/completion contract?
- [DD-8] `docs/backlog.md` — "Unify the full rolling-dispatch lifecycle shell across audit + remediate
  (doc-review D-66/D-67/C-7)..." (currently ~46 lines). Re-verified tonight: entry is byte-identical since
  last night (outside the two regions this window's backlog diff touched), still opens with shipped-status
  narrative ("Slice-1 SHIPPED... slice-2 VERIFIED not worth building...") before reaching the genuinely
  open slice-3 heartbeat work. Should this be trimmed to just the slice-3 open work (relocating the
  architecture recap to a spec doc, e.g. `spec/multi-ide-concurrent-runs-design.md`, which already owns
  OD3), or is the recap load-bearing enough to keep as-is (it explains why full unification was rejected,
  preventing re-litigation)?
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
  that `docs/project-philosophy.md` B6 ties dev-workflow friction logging to. Re-verified tonight
  (`FRICTION_CATEGORIES` unchanged; the new `stepBoundaryCapture.ts` adds backend `event_type` kinds but
  doesn't touch this vocabulary or this template): section unchanged, mismatch still real. Is the
  sprint-closeout template's taxonomy deliberately a separate axis (dev-sprint retro vs. product
  mechanical-capture are different domains), or should it be recast in the single-sourced vocabulary for
  consistency?
- [DD-12] `spec/audit/dispatch-admission-control.md` ("Deriving the per-pool token budget" section,
  ~lines 299-364) — this section describes a single MIN-collapsed-scalar budget derived via a function
  `resolvePoolBudget()` that no longer exists anywhere in the codebase (`grep -rn "resolvePoolBudget"
  src/` → zero hits, re-checked tonight). The shipped replacement (`src/shared/quota/windowConstraints.ts`,
  untouched tonight) builds one `AdmitConstraint` per active quota window, all-or-nothing — a genuinely
  different admission model, not a renamed function. The section's `windows[]` snapshot description is
  also missing a new required `scope` field (`QuotaWindowSchema` in `src/shared/quota/quotaSource.ts`,
  untouched tonight; `scope: 'account'|'model'`, no default). This is a substantial rewrite (whole
  section, ~65 lines), too broad for a narrow auto-apply. Should this section be rewritten around the
  multi-constraint / window-scoped model (`WindowBudget.scope`, the `acct:`/`pool:` `windowResourceKey`
  split, all-or-nothing admit semantics), and if so do you want it drafted for review or would you rather
  write the replacement yourself given how central this doc is?
- [DD-13] `spec/audit/dispatch-admission-control.md` ("Legibility" section, ~lines 235-239) — the doc
  presents `resource_key` in the admission-explain record as a plain pool identifier explaining "why the
  fan-out was the width it was." But `AdmissionGrant.resource_key`'s own doc comment
  (`src/shared/dispatch/admissionLoop.ts`) still reads "⚠ DIAGNOSTIC PROVENANCE ONLY... Once steps 3-4
  supply multiple constraints this field records only ONE of N and will look authoritative while being
  partial" — and multi-constraint admission is now actually wired (confirmed tonight: `windowConstraintsFor`
  is still called and can return several constraints; `admissionLoop.ts` changed 35 lines this window but
  in an unrelated region — a new capability-fail-open dedup helper — the `resource_key` doc comment itself
  is untouched). Should the doc's description of the explain record be updated now to state this
  partiality, or is that deferred until the tracked backlog follow-up (making it a key array) actually
  lands, so the doc is just describing a known interim gap?
- [DD-15] `spec/backend-identity-axes.md` ~lines 23,35 — two version-pinned references ("fixed in
  v0.33.11", "Service-qualifying the gate key (v0.33.11) turned that same collision into a LIVELOCK") are
  factually accurate but match the guidelines' status-noise smell (a pinned version string in a prose doc
  is not a factual claim to bump). Re-verified tonight: this doc changed 8 lines this window, but in a
  different paragraph (the "planned, stage 5 not shipped" service-axis claim was corrected to "emits the
  service axis," itself now correctly reflecting that stage 5 shipped) — the two `v0.33.11` pins at lines
  ~23/35 are untouched, still present verbatim. De-status these (drop the version number / restate as "an
  earlier fix"), or is the pin intentionally kept as a durable historical anchor tied to a specific defect
  narrative (bypass → livelock) rather than "current state"?

### Doc-set condensation
- [CX-3] `README.md`'s "## Philosophy" section (~lines 22-33) restates `docs/project-philosophy.md`'s A2
  ("right tool, not deterministic dogma"), A4 ("everything-agnostic by default"), and A7 ("delegate
  adversarial phases to a separate agent") in different prose — a fact living in two homes, drift risk if
  one is updated without the other. Still open (re-verified tonight; both files untouched this window).
  Keep as a distinct user-facing summary (different register: terse, no jargon like "A2"/canonical-home
  citations), or replace with a one-line pointer to `project-philosophy.md`? If kept, should
  `project-philosophy.md` note that README carries a condensed public-facing version, so a future edit to
  the convictions knows to check both?
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

Checkpoint `4c18315` → `eba802c8`: 17 commits landed since last night (this run's own reviewer pass
initially mis-scoped the diff as 15 commits / zero doc changes, due to a stale local checkout — an
independent adversary pass caught and corrected this before anything was applied; flagging the
methodology slip here for the record). Correct scope: 8 in-scope-adjacent files changed —
`CLAUDE.md`, `docs/HANDOFF.md`, `docs/backlog.md`, `docs/doc-review-guidelines.md` (excluded from its
own review), `docs/doc-review-routine-prompt.md`, `spec/backend-identity-axes.md`, plus 2 new
`docs/reviews/*.md` files (excluded, dated artifacts). This window shipped R3-3 (headless
capability-evidence LLM ranker) via a revert-then-reship (`1b601b4` reverted it, `c0cf7e9` re-shipped
it), landed the loop-core attestation/pre-commit hardening (`fd7ccab2`), and de-identified two maintainer
references (`CLAUDE.md`'s and `docs/doc-review-routine-prompt.md`'s changes were both this — no action
needed, already self-consistent).

Reviewed the 6 non-excluded changed files plus every doc referencing the 15+ changed src symbols
(`intakeExecutors`, `waveScheduling`, `admissionLoop`, `stepBoundaryCapture`, `apiPool`, `hostPool`,
`sharedProviderConfirmation`, `providerConfirmation`, `identity.ts`, `contractPipeline`, `marshal.ts`,
`advanceTypes`, `R3-3`, `capability_order`) — all in-scope hits resolved clean, no new drift. An
independent adversary agent re-derived the diff scope from scratch (catching the mis-scoping above),
independently re-verified all 11 pre-existing open items against tonight's HEAD (11/11 agree, still
open/valid, unaffected), and independently re-scanned for new stale-factual issues (none found beyond
what's below). No contested items — no judge pass needed.

Applied:
- `docs/HANDOFF.md`: IMMEDIATE NEXT item 1 ("Ship the R3-3 + gate-hardening release if the current lap
  has not already published it") was stale — `package.json` is already `0.34.6` and tag `v0.34.6` already
  points at HEAD, so `git log v0.34.6..HEAD` is empty: the release described as conditional/pending has
  already shipped. Deleted the item, renumbered the remainder (2/3/4 → 1/2/3).

Also resolved as a side effect of tonight's code shipping (nothing to apply — dropped from findings,
not re-escalated): DD-16 (dangling relative links from `docs/HANDOFF.md` and `docs/backlog.md` to
`docs/reviews/capability-evidence-salvage-2026-07-20.md`, previously only present on an unmerged branch)
— that file landed on `main` in commit `f3962e8` (within this window), both links now resolve. Verified
via `git ls-tree -r origin/main --name-only | grep capability-evidence-salvage` (present) and reading
both link targets in the current file content.

Full green gate (`npm run build && npm run check && npm test`) passed before push — 513 passed | 5
skipped test files, 7032 passed | 12 skipped tests, exit 0, no failures. One discrete commit
(`doc-review: clear the shipped R3-3 release from IMMEDIATE NEXT`), pushed to `main`.
