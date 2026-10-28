# Insights triage — 2026-10-28

<!-- review-routing: no-forward-work -->
<!-- The two debatable findings were already routed into docs/nightly-inbox.md as
     leg-3 inbox items (leg3-insights-commit-cadence-policy-2026-10-28 and
     leg3-insights-dispatch-idle-timeout-2026-10-28) by the nightly run that produced
     this record; the already-shipped findings named no further work. -->

Weekly `/insights` pass (due at 7.0 days since the 2026-10-21 run). Report:
`C:\Users\ethan\.claude\usage-data\report-2026-10-28-021305.html` (406 sessions,
2,230 commits). Ten concrete, actionable suggestions triaged below — the "Existing CC
Features to Try" (hooks/skills/headless-mode pointers) and "On the Horizon" (three
speculative multi-day builds: a resumable lap runner, a self-verifying review fleet,
a chaos-test harness) sections are discovery nudges and aspirational project ideas
respectively, not recurrence-evidenced recurring-problem proposals, and are not
counted as suggestions here.

Per `docs/nightly-routine.md` leg 3: every suggestion verified against HEAD/current
policy before classification. **already shipped** (5), **debatable** (5), **open** (0).

## Already shipped

1. **"Pre-Commit Gate Checklist" (regenerate derived artifacts + declarations before
   the gate).** audit-tools already enforces this mechanically rather than as a
   remembered habit: the generated-artifact freshness registry, `check:guard-reach`,
   and `attest-loop-core-review` block a commit on staleness — matching the project's
   own *auditor-agnostic robustness* conviction (a reminder is not the fix; enforce in
   tooling).
2. **"Closeout Rules" (re-render after the final commit; no inline confirmation
   questions in a closeout message).** `~/.claude/portable-engineering-principles.md`
   step 7 already routes every live owner decision through `AskUserQuestion` rather
   than inline prose, and steps 5-6 already require re-rendering from the landed
   tree before pasting.
3. **"Numbers and Claims" (recompute every figure from source the same turn).**
   Already a standing memory convention
   ([[verify-a-cost-number-before-quoting-it]]) with cited incidents; the suggestion
   restates an existing rule rather than finding a new recurrence.
4. **"Verify before claiming, numbers/upstream state"** ("New Ways" #2) — duplicate of
   #3 above under different wording.
5. **"Make the git-sync contract explicit per lap"** ("New Ways" #4) — the specific
   incident cited (nightly agent fast-forwarded local HEAD against the instruction to
   review it as-is) is already closed: `docs/nightly-routine.md:14-16` states "Review
   against local HEAD... never replace local HEAD with a remote ref" in exactly the
   terms the suggestion asks for, for this routine. The broader per-lap pre-flight
   habit for *other* laps is a narrower restatement of the same fixed principle, not a
   new recurrence.

## Debatable — escalate, do not auto-adopt

1. **"Commit Policy" (always commit completed green work before ending a turn).**
   Conflicts directly with this harness's own Git Safety Protocol: "NEVER commit
   changes unless the user explicitly asks you to... only commit when explicitly
   asked." Adopting the suggestion as literally proposed would create a standing
   contradiction between two policy layers. Owner call: which policy wins, and in
   which contexts (e.g. an explicitly autonomous lap vs. an ordinary session)?
2. **"Sub-agent / Dispatch Rules" — cancel any lane idle >10 minutes.** The specific
   numeric threshold violates a stated conviction: "Never set a cap, timeout, retry
   count or threshold from feel... Default to no limit" (`~/.claude/CLAUDE.md`). The
   scoping half (reject `~/.agent-config` access) is already enforced mechanically by
   `dispatch-cwd-guard.mjs` (confirmed tonight — it refused an AGY execution-mode
   write into the main checkout). Only the un-measured idle threshold is new, and it
   is new in a form the project already rejects.
3. **"Harden the dispatch lanes you depend on"** ("New Ways" #3) — same idle-timeout
   objection as above (also proposes a bare ">10 minutes"); the artifact-verification
   half ("verify the artifacts it claims to have written actually exist... discard
   fabricated output") restates the dispatch skill's existing "verify each output
   against source; never dismiss it from recall," so only the unmeasured threshold is
   actually new.
4. **"Long-Running Laps" (checkpoint-commit after each completed backlog item).**
   Same Commit-Policy conflict as #1 — ending a turn with uncommitted green work is
   current harness-level policy, not an oversight; checkpointing more often is a
   defensible direction but needs an owner call on how it interacts with "only commit
   when asked."
5. **"Checkpoint-commit instead of batching to closeout"** ("New Ways" #1) — duplicate
   of #4 above under different wording.

## Outcome

No leg-3 proposal authored from this pass — every suggestion is either already
addressed by an existing mechanism/memory, or directly conflicts with a stated policy
and needs an owner call rather than a silent adopt. No change made to this run's
`skipped` reasoning.
