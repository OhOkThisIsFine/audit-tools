# Design-doc drift check — 2026-06-13

Grounded comparison of `docs/audit-workflow-design.md` and
`docs/remediation-workflow-design.md` against current `src`. Point-in-time
report (delete once acted on). Unbuilt commitments are also tracked in
`backlog.md` → *Design commitments not yet built*.

Three buckets: **(A)** doc statements now stale (the doc should be fixed),
**(B)** design commitments not yet built (code behind doc), **(C)** clean.

---

## A. Stale design-doc statements — the docs need fixing

These describe a past state; the code has moved on. They make the design docs
read as inaccurate and should be edited out / updated.

- **Both docs carry "verified defect tables"** — point-in-time snapshots of bugs
  found at design time. The remediation doc's table (≈ll.410-431) and the audit
  doc's equivalents are now **almost entirely fixed in code** (extracted-plan fast
  path gating, zero-documentable-findings handling, silent resume vs
  resume/restart/merge gate, preview ack ↔ plan-identity binding, `obligation_ledger`
  first-class phase, judge-repair target inference, DAG-promotion lens/severity
  derivation, `rationaleAsksForRetry` precedence, `halt`→close routing,
  combined-suite selective re-block, E2E transition-not-throw, ignored-items
  `overall_status`, derived commit message + preview, artifacts-dir preserved on
  failure). A "verified defect table" is inherently non-timeless; these belong in
  git history, not the durable design contract. **Recommend: delete the defect
  tables from both design docs.**
- **audit doc says `resolveEffectiveLenses` is "currently unwired."** It is now
  wired — `planningExecutors.ts:115-133` calls it against
  `intent_checkpoint.lens_selection`. **Update the annotation.**
- **audit doc "Batch deterministic block"** — it specifies that steps 2–6
  (`auto_fix → … → design_assessment`) advance in a *single* `next-step` call
  (a multi-obligation batch loop). The code is strict **one-obligation-per-call**
  (`nextStep.ts` `PRIORITY`/`findObligation`; `advanceAudit` runs one executor per
  call), which matches the product's "one bounded step per invocation" principle in
  `CLAUDE.md`. The doc contradicts the shipped principle. **Recommend: reconcile —
  almost certainly the doc should drop the batch-loop language, not the code.**

## B. Design commitments not yet built (code behind doc)

Now tracked in `backlog.md`. Summary with citations:

- **`free_form_intent` threaded verbatim, not interpreted** (both tools). Docs:
  interpret to shape lens/priority, never paste into worker prompts. Code:
  verbatim into packet prompts (`packetPrompt.ts:207-208`, `dispatch.ts:316`;
  remediate checkpoint prompt), and the built `intentInterpreter.ts`
  (`checkpoint_questions`/`has_unencodable`) is **unwired** → unencodable clauses
  silently dropped, no blocking-checkpoint escalation. *This is the one item that's
  a behavioral contradiction, not just unbuilt — worth resolving deliberately.*
- **Rolling per-node dispatch (dispatch-when-verified-complete)** — remediate-code
  builds one wave per `next-step` (`prepareImplementDispatch` gates on item status),
  then batch-merges. Design wants per-result verify→merge→re-check→dispatch.
- **Provider confirmation Gate-0** (shared, session-level spanning audit→remediate)
  — no `provider_confirmation` state in remediate-code.
- **Parallel module-contract phases** — `buildParallelModuleWaveStep`
  (`contractPipeline.ts:619`, comment ll.628-629) runs a single sequential agent,
  not N parallel.
- **audit-code:** `waiting_for_provider`/`advancePausedState` built in
  `shared/src/rolling/pausedState.ts` but `rollingDispatch.ts` doesn't use the
  mid-run pause; design-review prompts don't annotate units `[in scope]`/`[excluded]`
  (`designReviewPrompt.ts` `summarizeUnits`); ingestion is still a separate
  `audit_results_ingested` obligation, not folded into the dispatch turn.
- **Smaller doc-ahead items:** intake summary doesn't enforce non-empty
  `goals`/`affected_files`; risk reviewer stays metadata-only even for
  `context_dependent` findings (design wanted source granted for those);
  intent-checkpoint → `closing_plan.pre_authorized` plumbing absent; resume
  `merge` choice is UI-only (merge logic not implemented); verification-report
  evidence is test-run granularity, not per-obligation assertion text.

## C. Clean matches (no drift)

Document-phase dissolution (shipped — no `prepareDocumentDispatch`/`mergeDocumentResults`,
`handlePlanning`→`implementing` directly); worktree isolation + ownership-gated
`affected_files` amendment (`OwnershipRegistry`/`routeAmendmentRequest`);
post-merge bisect re-verification (`attributePostMergeFailure`); triage failure-class
split + retry-with-failure-context; cyclic-seam resolution gate; synthesis-narrative
`host_delegation` + headless `omitted`; disposition overrides at planning;
`resolveEffectiveLenses` wired; rolling quota-aware JIT packetization
(`max_concurrent_agents`, proximity batching) — all match or exceed the design.
