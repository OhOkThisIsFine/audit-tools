# Doc-review findings

Machine-readable block for the SessionStart hook is delimited below. FYI (what was auto-applied) is
outside the block, after it.

<!-- DOC-REVIEW-OPEN:START -->
### Proposed instruction-file edits (approve to apply)
(none this run — CLAUDE.md and AGENTS.md were reviewed line-by-line by two independent agents;
zero stale-factual or policy issues found)

### Design decisions for you
- [DD-1] `docs/project-philosophy.md` — A10's own note says Own-vs-acquire is "not yet promoted into
  `CLAUDE.md`." F5's per-run consent gate is now confirmed live (`acquisitionEngine.ts`). Promote the
  Own-vs-acquire conviction into `CLAUDE.md` now, or leave it backlog-tracked?
- [DD-2] `docs/glossary-ids.md` — N-R21's gloss ("ownership-registry / write-scope dispatch nodes") is
  shared with N-R22 in one table row, but N-R21's only live code usage
  (`contractPipelineGates.ts`/`contractPipeline.ts`) is circular interface-dependency routing, unrelated
  to ownership/write-scope — only N-R22 matches the gloss. Reword N-R21's row, or split the row?
- [DD-3] `docs/backlog-remediation-design.md` — the "Still-gated" section (module table) says "**D7/D8**
  are the only genuinely-open items... tracked as open work in `backlog.md`." **D7 is never defined**
  anywhere in the doc or repo (only D1–D6, D8 are enumerated); its claimed backlog.md tracking doesn't
  exist for D7 specifically (D8's does). Was D7 meant to be defined and never was, or should the
  reference be corrected to "D8" only?
- [DD-4] `docs/backlog.md` — "`llm read` JSON-contract break" entry says "FIXED upstream 2026-07-09;
  publish pending operator WIP" in the external `llm-worker-tools` repo (not vendored here, unverifiable
  from this checkout). Has `llm-worker-tools` been published since (clearing your own WIP blocker)? If
  yes, delete the entry (or trim to just the still-open "very large payloads still fail post-fix" note).
- [DD-5] `docs/backlog.md` — the ~8 "Lap friction walk" retrospective entries (dated 2026-07-08/09) are
  now almost entirely historical narration of fully-shipped laps with no open remainder, and the same
  lesson (`[[spec-degradation-and-doc-staleness]]`) is independently re-narrated at length in 6+ of them
  instead of living once in memory. Proposed condensation rule (a2b_draft, quoting the tension verbatim):
  raw item as currently practiced — **A** (current): every lap's friction walk stays permanently in
  `backlog.md` as a full retrospective narrative, even after its lesson is durably captured in memory and
  its incident fully resolved. **B** (proposed): once a friction-walk entry's underlying work has shipped
  and its lesson maps to an existing memory tag, the entry condenses to a one-line pointer ("lesson:
  `[[tag]]`, see memory for detail") or is deleted outright if the lesson predates that lap; only a
  friction observation that is itself new, or that names still-open tool work, earns a full-paragraph
  entry. Adopt B? (Left un-touched this run pending your call — a ~280-line span, too large a deletion to
  auto-apply without an explicit condensation policy in place.)
- [DD-6] `docs/backlog.md` — Durable trap "sync with remote main before starting a lap": a
  `.claude/skills/start-lap/SKILL.md` now exists that operationalizes this, but it's agent-instruction-
  driven, not a hard mechanical git-level gate. Cross-reference the skill in the trap entry (as a
  mitigation, not a fix), or leave as-is pending a true hard gate?
- [DD-7] `docs/HANDOFF.md` — §T5 items -1/0/2/3 and the D-66/67 slice-1/slice-2 paragraphs narrate
  substantial commit-level shipped detail (specific hashes, defect counts, LOC deletions), contradicting
  the doc's own preamble ("Per-lap shipped detail is not narrated here... changelog creep"). Trim these
  COMPLETE/SHIPPED/VERIFIED-CLOSED items to one-line `backlog.md` pointers (matching how T4/T6 already
  read), or does the sequencing view need the verdict restated inline?
- [DD-8] `spec/cross-provider-quota-matrix.md` — 14 dated research-log entries ("LIVE-CONFIRMED
  2026-06-17" etc.) are woven through what's framed as a timeless design doc. Condense to timeless
  "confirmed against live X" statements (dropping the specific dates), move the research-log framing to a
  `docs/reviews/*` dated artifact (the pattern already used for other diagnosis docs), or is preserving
  research provenance itself the intended durable content here?
- [DD-9] `spec/remediate/remediation-goals.md` — three described mechanisms have no corresponding code:
  (a) the "Dependency Inference" `public_contract`-tag → strips `parallel_safe` mechanism (L129) — no
  code path reads that tag; (b) the "sorted sequential fallback queue" on rebase-failure (L154-155, L338)
  — actual mechanism is quarantine + re-enter triage, no category-sorted queue exists; (c) the "Git
  Co-commit (Jaccard>0.5)" and "Test Graph" block-derivation steps (L106-108) — only File Overlap is
  implemented. Are (a)/(b)/(c) planned-but-unbuilt, superseded by the triage-based reality already
  described accurately in `spec/remediation-workflow-design.md`, or stale text to delete?
- [DD-10] `spec/dispatch-cost-speed-dial.md` — L44 pins "(the owner, 2026-07-08)" on the
  manual-flag-is-bug-signal note. Drop the date (the conviction is durable regardless of when decided),
  or keep it as decision provenance?
- [DD-11] `spec/multi-ide-concurrent-runs-design.md` — three pinned "(the owner, 2026-07-02)" decision
  dates (L3, L104, L186), plus a ~70-line "Implementation slices" section with "✅ SHIPPED" markers, named
  test files, and a literal pass count ("3434/0") — changelog/progress-log content inside a design doc.
  Drop the dates and trim the slices section to timeless architecture (the model, the three gaps, the
  settled decisions already cover the durable content), or is a completion ledger intentional here?
- [DD-12] `spec/contract-authoring-determinism-design.md` — §S7 cites a specific past run ("the
  452-audit") and specific finding IDs (`ARC-1fa005bb`, `COR-3410f5f6`, `DAT-d78de464`) found nowhere
  else in the repo — an unverifiable, non-durable anecdote. Restate as a durable failure class without
  the specific run/ID citation?
- [DD-13] `spec/audit/entrypoint-contract.md` — references "the completion criteria document" with no
  resolvable filename/link. What should this point to (`spec/audit/audit-goals.md`'s Completion
  section)?
- [DD-14] `spec/audit/audit-goals.md` — three normative claims in this "the normative product
  definition... other docs should defer to it" doc are contradicted or overstated by shipped code
  (verified independently by two agents):
  1. **"The audit is not complete if any work remains inside auditable scope... No partial-success
     status should be introduced"** (Completion section) vs. the shipped, tested
     `ActiveDispatchState.partial_completion_terminal` mechanism (`recordPartialCompletionTerminal` in
     `rollingAuditDispatch.ts`, read by `state.ts` to mark `audit_tasks_completed` satisfied despite
     stranded tasks) — the pipeline genuinely reaches `"complete"` status with less-than-full coverage as
     a deliberate livelock-safety-valve. Should the doc carve out an explicit exception for this
     sanctioned partial-coverage terminal, or should the mechanism/naming be reconciled instead? Separately:
     `AuditState.partial_coverage_terminal` (a similarly-named but dead, zero-reference field) should
     probably be deleted as orphaned scaffolding.
  2. **"Root-cause clustering is not part of the product"** — but `synthesisNarrativePrompt.ts` groups
     findings into themes with a `root_cause` field, rendered as a "## Themes" section directly into
     `audit-report.md` when the optional narrative provider runs. Real, wired, tested. Reword to "not
     part of the mandatory deterministic core" (it's optional/additive), or is the blanket claim
     intentional?
  3. **"LLM fallback is allowed only when [deterministic confidence] check fails"** (critical flows) —
     the deterministic side (`fallback_required` in `flows.ts`) is real, but its only consumer
     (`structureExecutors.ts`) merely appends an informational sentence to a progress string; no
     executor/dispatch/worker prompt actually triggers an LLM critical-flow-finding pass on it. Build the
     wiring, or correct the doc to describe this as a spec-only target?

### Doc-set condensation
- [CX-1] `spec/audit/state-machine.md` (§Obligations) + `spec/audit/orchestration-policy.md` (§Priority
  order) — the 8-item abstract priority-category list is verbatim-identical in 7 of 8 items (item 2's
  wording has already drifted). Fold `state-machine.md`'s copy into a one-line pointer at
  `orchestration-policy.md` (the more general home — it also owns Selection/Stale/Requeue/Failure/
  Completion policy). Same underlying issue as [DD-*] not separately numbered above.
- [CX-2] `spec/multi-ide-concurrent-runs-design.md` — see [DD-11]. Trim candidate, not retirement.
- [CX-3] `spec/cross-provider-quota-matrix.md` — see [DD-8]. Trim candidate (dated research-log → git
  history / `docs/reviews/*`), not retirement.
- [CX-4] `docs/backlog.md` — the "Lap friction walk" entries + repeated-lesson duplication. See [DD-5].
- [CX-5] `docs/HANDOFF.md` §T5 — see [DD-7]. Trim to `backlog.md` pointers, matching T4/T6's existing
  style.

Canonical-manifest check: every tracked `docs/**/*.md` still appears in exactly one row (or the
excluded row) of `doc-review-guidelines.md`'s routing table — no strays this run.
<!-- DOC-REVIEW-OPEN:END -->

## FYI — what was auto-applied this run (stale-factual-fix, code-anchored, green-gated)

**Note on scope:** `main`'s git history was force-updated/rewritten upstream between the previous run and
this one — the ledger's prior baseline commit (`8e1abb87...`) is unreachable in this checkout, so
diff-scoped evidence-window reading was unavailable. Every in-scope doc was reviewed fresh against full
current code (reviewer pass + independent adversary re-check of every item, not just reviewer-flagged
ones — the standard three-agent gate, minus a judge pass since every contested item resolved cleanly on
direct re-verification by the orchestrating session). One escalation item from the reviewer pass
(HANDOFF.md's D-66/67 slice-1 commit-hash "unreachable" claim) was independently re-verified and found
FALSE — those hashes ARE reachable from `origin/main`/HEAD — and dropped without needing to reach you.

- `docs/audit-pkg/product.md` — fixed a Markdown link-text/href mismatch (`spec/audit-goals.md` →
  `spec/audit/audit-goals.md`).
- `docs/HANDOFF.md` — version line was 4 releases stale (`~v0.32.49` → actual `v0.32.53`); added brief
  pointers to the intervening quota-self-monitoring collapse, the CP-NODE-2/4/5 remediation fixes, and
  the 3 newly-logged open bugs.
- `docs/backlog.md` — largest cleanup (1053 → 801 lines). Deleted fully-shipped entries with no open
  remainder (External-shared-logic-audit shipped-framing, meta-frictions-v0.32.27 entry, the
  Context-efficiency mega-entry down to its one real follow-up, the heaviest-test durable trap's
  investigation narrative); trimmed shipped-substrate prose out of partial entries while preserving every
  open residual (Dispatch-admission-control, Shared-logic-dedup-bundle, Cost↔speed-dial, D-66/67
  slice-1/lifecycle-shell/D-68/D-69) — including re-homing a real, still-open correctness gap (remediate's
  `phase:main` mutex lacks the OD3 layer-2 re-check audit has) that a first-pass edit would have silently
  dropped; caught and fixed on adversary review.
- `spec/cost-first-routing.md` — "Parity" bullet named a nonexistent function (`admissionPoolsFromSchedule`);
  corrected to the real shared call path (`admissionPoolsFromSummaries` → `deriveCostRank`).
- `spec/remediate/remediation-goals.md` — corrected a claim that `item_spec.json`/`closing_plan.json` are
  versioned standalone files; they're inline fields on `RemediationState`, schema-validated, no version field.
- `spec/audit-workflow-design.md` — pipeline diagram was missing the `charter_clarification`/
  `systemic_challenge` obligations (Phase D/E); inserted them in their correct position.
- `spec/audit/artifact-contract.md` — `ARTIFACT_DEFINITIONS` entry count was stated as 36; it's 37 (the
  doc's own by-phase tables already summed to 37).
- `spec/self-scaling-pipeline-design.md` — phase list was missing `obligation_ledger`/
  `cyclic_seam_resolution`; also its own "Problem" section still described the `leanFastPath` → Dial A/B
  fold as open work tracked in `backlog.md`, contradicting the doc's own later "Mechanisms" section — the
  fold shipped 2026-07-09 (`docs/backlog.md` D-68); reworded to past tense.
- `spec/multi-ide-concurrent-runs-design.md` — the OD3 section claimed `mergeAndIngestCommand.ts` "carries
  no ownership gate," but the merge-time gate (layer 2) shipped 2026-07-09 (`partitionByOwnership`); only
  the continuous heartbeat (layer 1) for long-lived claims remains open. Corrected to distinguish the two.
- `.claude/skills/ship/SKILL.md` — "gate (`verify:checks`: check + deadcode + ...)" read as though `check`
  (tsc --noEmit) were a separate CI step; the actual chain has no standalone `check` step (`build` subsumes
  typechecking). Reworded.

Green gate: `npm run build && npm run check && npm test` — all green. Each change above landed as one
discrete, revertible commit on `main`.
