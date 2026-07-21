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
- [DD-15] `spec/backend-identity-axes.md` ~lines 23,35 — two version-pinned references ("fixed in
  v0.33.11", "Service-qualifying the gate key (v0.33.11) turned that same collision into a LIVELOCK") are
  factually accurate but match the guidelines' status-noise smell (a pinned version string in a prose doc
  is not a factual claim to bump). De-status these (drop the version number / restate as "an earlier fix"),
  or is the pin intentionally kept as a durable historical anchor tied to a specific defect narrative
  (bypass → livelock) rather than "current state"?
- [DD-16] `docs/HANDOFF.md` (IMMEDIATE NEXT item 1, "Record:" link) and `docs/backlog.md` (the
  "Capability-evidence obligation" entry, "Salvage record:" link) both link to
  `reviews/capability-evidence-salvage-2026-07-20.md`, relative to `docs/`. Verified: this file does not
  exist on `main` (`git ls-tree -r origin/main --name-only | grep capability-evidence-salvage` → zero
  hits) — it exists only on the unmerged `salvage/capability-evidence` branch (confirmed real content
  there via `git show origin/salvage/capability-evidence:docs/reviews/capability-evidence-salvage-2026-07-20.md`).
  Both links 404 when followed from `main` (e.g. on GitHub), though the surrounding prose at both sites
  already discloses the record lives "off current main" / on that branch, so a reader isn't misled about
  *where* it is, only the hyperlink doesn't resolve. Several fixes are defensible (branch-qualified
  absolute URL; de-hyperlink to a plain filename citation; leave as-is since the prose already discloses
  the branch, and land the real fix by merging the file when the branch lands) — which one you want isn't
  mechanical, so this is a design-decision rather than an auto-apply.

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

Checkpoint `fe77ef0` → `4c18315`: 24 commits landed since last night, shipping Stage 4 of the
backend-identity migration (axis-explicit exclusion grammar) and the capacity-guard prerequisite.
Of the doc-review-in-scope files, only 4 changed in that window: `docs/HANDOFF.md`, `docs/backlog.md`,
`docs/quota-dispatch-design.md`, `spec/backend-identity-axes.md` (plus 3 excluded `docs/reviews/*.md`
dated artifacts and `docs/doc-review-guidelines.md`, which is excluded from its own review). Every other
in-scope doc's evidence window (`git diff fe77ef0..HEAD`) was empty, so no new invalidation was possible
there this run; their existing dispositions stand unchanged (ledger re-stamped at the new commit).
Reviewer examined the 4 changed docs and produced 6 candidate dispositions; an independent adversary
agent re-verified all 6 from scratch (re-reading the actual code, not trusting reviewer evidence) plus
independently re-scanned the same 4 docs for anything missed, surfacing 2 further findings. All 8 were
confirmed, 0 refuted, 0 contested — no judge pass needed. One previously-open item, DD-14 (the
exclusion-grammar section's parser/matcher claims), turned out to already be resolved: Stage 4 shipped
exactly what it was waiting on. The one remaining inaccurate sentence in that section (about the
autonomous-write side, which is Stage 5 and still unshipped) is fixed below and is a narrower, different
claim than what DD-14 originally flagged.

Applied:
- `docs/backlog.md`: deleted the "green gate referenced a dead workspace" entry outright — fully shipped
  (the fix commit predates `fe77ef0` by ~2.5h, and `fe77ef0` itself is proof the gate now applies fixes
  correctly) with its residue-check concern self-verified by that same fact.
- `docs/backlog.md`: marked the "Axis-explicit exclusion grammar" migration stage (item 4 of the
  backend-identity staged plan) ✅ SHIPPED `a6adc9b` — it still described pre-shipment parser/matcher
  state ("must change", "no `service` field") that the commit already landed.
- `docs/backlog.md` + `spec/backend-identity-axes.md`: fixed two references to `transportRoute`, which
  Stage 4 renamed to `exclusionPattern`.
- `spec/backend-identity-axes.md`: reworded the present-tense claim that the autonomous write "emits the
  service axis" — that's Stage 5, not yet shipped; the current writer still emits `transport:`.
- `spec/backend-identity-axes.md`: reworded a pricing-defect reference from "a live defect" to match
  `docs/backlog.md`'s own record — fixed 2026-07-19, and per the vendored price snapshot actually inert
  at HEAD the whole time.

Full green gate (`npm run build && npm run check && npm test`) passed before push — 511 passed | 5 skipped
test files, 6870 passed | 12 skipped tests, exit 0, no failures. One discrete commit (`doc-review: nightly
pass — 6 stale-factual-fixes applied, 1 item escalated`), pushed to `main`.
