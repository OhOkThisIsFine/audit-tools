# Lens steward redesign — 2026-09-17

<!-- review-routing: memory -->

The design landed in the commit that carries this record, so it leaves no backlog work. What it
leaves is a durable fact about how the tool works — the coverage-policy axis, and the three
completeness gates that read it — which is routed to project memory.

Owner directive, 2026-09-17, during the prompt-15 review:

> A number of files is not a good way to measure ... anything. If you have 130 files that each
> contain 10 lines, limiting to 12 files is nonsensical. If each file contains 100000 lines, then
> limiting to 12 files is useless. I think we should fundamentally change the lens steward process.
> The lens steward should have access to every file the lens was applied to, and whatever useful
> metrics we can generate specific to that lens. It should then be allowed to review whatever it
> thinks it should.

This document is the design of record for that change. It supersedes the narrow
"prompt 15 wording" scope the review started from.

## What runs today

A LENS STEWARD is one task per important lens, created after that lens's per-file reviews finish.
It re-checks how well the lens was covered, writes no findings of its own, and may queue bounded
follow-up work.

`buildLensVerificationTask` (`src/audit/orchestrator/selectiveDeepening/lensVerification.ts`) does
four things in order:

1. It computes `allPaths` — every file the lens reviewed anywhere in the run.
2. It scores each of those files: the source task's priority rank, plus bonuses for
   `critical_flow`, `external_analyzer_signal` and `large_file` tags, plus a high-risk-clean bonus,
   plus the severity rank of every finding that names the file.
3. It sorts by that score and keeps the top `MAX_LENS_VERIFICATION_FILES = 12`.
4. It discards the rest, keeping only the COUNT, which reaches the steward as prose:
   `across 137 file(s) ... omitted 125 lower-priority file(s)`.

A second cap, `MAX_LENS_VERIFICATION_RESULT_SUMMARIES = 12`, truncates the prior-result summaries
the same way. Both truncations write a warning to standard error. Nothing automated reads either
warning.

### Why the cap is the wrong instrument

One number of 12 does two unrelated jobs.

| Job | What the cap buys | Correct? |
|---|---|---|
| Bound how much the steward READS | a bounded review | the intent is right, the unit is wrong |
| Bound what the steward may NAME | nothing | no — naming a path costs a path |

The unit is wrong because a file count measures no cost the tool cares about. Twelve files of ten
lines is not a bounded review; it is a wasted one. Twelve files of one hundred thousand lines is not
a bounded review either.

The second job is the more serious defect. The steward is told that 125 files were omitted and is
never told which. Its follow-up list may name only the twelve it holds, so the one case the
follow-up field exists for — the cut dropped something that matters — cannot be expressed.

### Provenance

`MAX_LENS_VERIFICATION_FILES` has no design commit. `git log -S` finds it only in `84ab9248`, the
commit that collapsed the monorepo into one package. No backlog entry, no durable trap and no prior
removal of selective coverage stands against this change.

## The blocking contract

Two rules in `src/audit/validation/auditResults.ts` make a result's `file_coverage` exactly equal to
its assigned file set:

- line 830 — a coverage path that is not in `task.file_paths` is refused;
- line 917 — `file_coverage must include every assigned file. Missing '<path>'.`

The dispatch prompt states the same rule in one sentence, in `buildPrompt`
(`src/audit/cli/dispatch/hostHandoff.ts`): *"Review every listed file and return one JSON object
at the bound result path."*

So "grant the whole surface, let the steward choose" is not reachable by widening the cap. The
assigned set and the reviewed set must first become two different things.

## The design

### A. The lens surface replaces the sample

Delete `MAX_LENS_VERIFICATION_FILES`. A steward task's `file_paths` becomes `allPaths`: every file
the lens was applied to in this run. `file_line_counts` covers all of them.

### B. Per-file lens metrics, persisted instead of discarded

The scoring walk in `selectLensVerificationFiles` stops being a sort key that truncates, and becomes
a metrics emitter. Per file, on the lens surface:

- `total_lines`
- `findings` — the count per severity that the lens already recorded against the file
- `reviewed_clean` — the lens reviewed it and recorded nothing
- `high_risk_clean` — reviewed clean while the source task was high priority
- `critical_flow`, `external_analyzer_signal`, `large_file` — the source task's tags
- `source_task_id` and the source result's own summary
- `score` — the composite the tool already computes, kept as a RANKING HINT, never as a gate

These are the "useful metrics specific to that lens" the directive asks for. They are what lets a
steward choose well without opening four hundred files first.

The surface is written as an artifact and GRANTED to the steward's step, never inlined into the
prompt. A prompt that inlines four hundred rows is mostly a path list, and the list crowds out the
instructions it exists to support. This is the same choice the owner made for the synthesis
narrative prompt in commit `2fa37003`: grant the findings file, do not inline it.

`MAX_LENS_VERIFICATION_RESULT_SUMMARIES` is deleted for the same reason. The summaries move onto the
surface, one row per source result.

### C. A coverage policy on the task

The assigned set and the reviewed set separate through ONE policy axis, read by both doors and both
draws — not through a fork:

- `coverage_policy: "complete"` — every assigned file must appear in `file_coverage`. This is
  today's rule, unchanged, and it is the default for every base review task.
- `coverage_policy: "selective"` — `file_coverage` must be a non-empty SUBSET of the assigned files.
  A coverage path outside the assigned set is refused exactly as it is today.

Only the steward lane is `selective`. This is a policy axis of the shared core, which is what
`CLAUDE.md` prescribes over two forks kept in parity.

### D. The steward accounts for its selection

Free selection without an account is indistinguishable from a steward that opened two files and
stopped. The `verification` object gains a seventh required key:

- `selection_rationale` — a non-empty string stating why these files, out of the surface.

This is the same rule as the zero-finding affirmation: a success-shaped result that was never
affirmed is not evidence. The steward already carries `coverage_concerns`, but a concern is not an
account of a choice, so the two stay separate keys.

### E. The follow-up boundary dissolves

Once the steward's assigned set IS the lens surface, the question that opened this review answers
itself. A follow-up may name any file within this work item's assigned files, and that set is
already the whole lens surface.

- The prompt clause "or packet boundary" is deleted.
- `boundaryPaths` is deleted from `ValidateAuditResultOptions` and `verificationAllowedPaths`. It
  has no production caller; the doc comment on that field of `ValidateAuditResultOptions` records
  that the two doors agree only because nothing has ever passed it.
- The silent path filter in `buildVerificationFollowupTasks`
  (`src/audit/orchestrator/selectiveDeepening/stewardFollowup.ts`) is deleted. It drops a path
  outside the result's coverage without a word, and drops the whole suggestion when every path goes.
  The door refuses an out-of-set path before the consumer ever sees one.

### F. Prompt 15 corrections carried in the same change

These are the defects the prompt-15 review measured. Each is a case where a reader who obeys the
prompt exactly produces a submission the tool refuses, or ships evidence the tool cannot check.

1. **`reviewed_clean`** — the prompt renders the rule *a result with zero findings must set
   `reviewed_clean: true`*, and the parser refuses any key outside its seven-key envelope, so a
   clean review that obeys is refused. Owner decision: the envelope ACCEPTS `reviewed_clean` and
   checks it. A result with an empty `findings` array must carry `reviewed_clean: true`. A clean
   review becomes an attested claim rather than an inference drawn from silence.
2. **`quoted_text`** — the prompt names the field once, only as text the tool re-reads, and never
   asks for one. A reader who obeys ships no quote, every finding grounds `ungrounded`, and the
   report files them under "Ungrounded Findings (not confirmed)". Owner decision: the prompt asks
   for a verbatim quote per affected file, and the door REFUSES a finding that carries neither a
   quote nor an explicit declaration that no quotable span exists. The declaration carries the
   reviewer's reason, so a later adversarial pass can check it: if a quotable span did exist and was
   not used, that casts doubt on the finding's groundedness.
3. **The `verification` self-contradiction** — the steward prompt says the result must contain
   "exactly ... and verification", then says `verification` is optional. The parser makes it
   optional. The prompt states one rule.
4. **The buried destination** — the assignment is one long JSON line with the result path inside it.
   The destination path is stated first, on its own, and the assignment is rendered as a fenced
   block.
5. **"Review every listed file"** — true for a base task, false for a steward under `selective`
   coverage. The sentence becomes lane-aware.

## What is NOT changed

- The steward still writes no findings of its own. `findings: []` plus verification metadata.
- A base review task's contract is untouched in every respect: `coverage_policy` defaults to
  `complete`, which is the rule it already obeys.
- Grounding still never rejects a submission over a quote that FAILS to re-verify. Only the ABSENCE
  of both a quote and a declaration is refused, and only for the finding that carries neither.

## Gate status

- **Retirement check: CLEAN.** No standing decision, backlog entry, durable trap or prior removal
  opposes this design. Evidence: `git log -S'MAX_LENS_VERIFICATION_FILES'`, `docs/backlog/*.md`, and
  the *Preferences & standing decisions* section of `CLAUDE.md`.
- **Independent refutation: RAN.** Lane `agy-gemini`, 185s, against an isolated copy of the design
  and its source evidence. Three real defects found; see the next section.
- **Loop-core: YES.** `src/audit/cli/dispatch/hostHandoff.ts` is loop-core, so the commit needs a
  staged-tree review attestation.
- **Failing test: PINNED RED.** `tests/audit/lens-steward-surface.test.ts` — a lens that reviewed 40
  files produces a steward holding 12, and no line count from the thirteenth file onward.

## What the independent refutation pass changed

Lane `agy-gemini`, 2026-09-17, 185s, run against an isolated copy of the design and its source
evidence. It returned eight verdicts. Question 1 came back CLEAN and cited the "one shared core plus
per-mode policy" decision in `CLAUDE.md` as support for the coverage-policy axis. Three of its
question-2 verdicts found real defects in the design above. Each was verified against source before
it was accepted; the design is corrected here rather than in place, so the correction stays visible.

### 1. There is a THIRD coverage gate, and it fires FIRST

The design named two coverage rules, both in `src/audit/validation/auditResults.ts`. There is a third
in `parseHostResult` (`src/audit/cli/dispatch/hostHandoff.ts`):

```
const uncovered = item.scope.files.filter((path) => !coveragePaths.has(path));
if (uncovered.length > 0 || coveragePaths.size !== item.scope.files.length) {
```

This is the HOST door. It refuses before the batch validator ever runs, and it judges from the
persisted TASK BINDING, not from the task. So `coverage_policy` must ride the binding
(`AuditHostTaskBindings.entries[]`), not only the task. Verified at source.

### 2. The follow-up allowed-path set is built from COVERAGE, not from the assigned files

`validateVerification` (`src/audit/validation/auditResults.ts`) builds its allowed set from `coveragePaths` plus
`boundaryPaths`, and passes no `assignedPaths`. Under complete coverage those are the same set, so
nothing noticed. Under SELECTIVE coverage they are not: the allowed set would shrink to the files the
steward chose to read, and a follow-up naming any other surface file would be refused.

Correction: that call passes `assignedPaths` from the task. The host door already does
(`verificationAllowedPathsForEnvelope`), which is why the two doors would otherwise have disagreed
again — the exact failure the shared containment rule was written to end. Verified at source.

### 3. A follow-up over an unreviewed surface file would carry `total_lines: 0`

`lineCountForPath` (`src/audit/orchestrator/lineCounts.ts`) resolves `task`, then `result`, then
`lineIndex`, then **0**. `buildVerificationFollowupTasks` deliberately passes no `task`, because for
a reviewed file the result's MEASURED count is fresher than the assigned one. That reasoning still
holds. But a surface file the steward did not review appears in no source, so it falls through to
zero.

Correction: the follow-up builder keeps the result as its first source, and supplies the steward
task's surface counts as the fallback index. The measured number still wins wherever one exists.
Verified at source.

### 4. Rejected: the demand-inflation verdict

The lane claimed the emitted `token_estimate` and `demand` would "massively inflate based on total
surface line counts". Half of that is wrong at source: `buildLensVerificationTask` sets no
`token_estimate` at all, so `toHostTask` reads `task.token_estimate ?? 0` and the estimate stays
zero. The `fileCount` input to `deriveLaneDemand` does grow from 12 to the surface size, and that is
CORRECT rather than inflated. `demand` states what a lane asks for, and stewarding a 400-file lens
surface genuinely asks more than stewarding twelve files. The previous number was capped, not
accurate.

## The surface reaches the steward through the workload, not a new artifact

`buildPrompt` stringifies `files` and `file_line_counts` straight into the prompt's assignment line
(`src/audit/cli/dispatch/hostHandoff.ts`), so a 400-file surface would produce a prompt that is
mostly a path list.

The workload the tool already writes carries the whole scope per work item (`buildWorkItem`, in the
same module). So the surface needs no new artifact and no new grant:

- `AuditHostWorkItem.scope` gains `file_metrics` beside `files`.
- A SELECTIVE lane's prompt does NOT inline the file list. It states the surface size, names the
  workload file and this work item's id, and states the selection rule.
- A COMPLETE lane's prompt is unchanged, because its scope is small and inlining it is what makes
  the work item self-contained.
