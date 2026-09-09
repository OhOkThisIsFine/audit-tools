# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.7 is published and installed globally.** Release commit `a5ced6e3`
  passed the publish workflow; npm resolves 0.51.7 and
  both installed command surfaces report 0.51.7. The release workflow is
  [run 34189090341](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/34189090341).
  Conceptual retries preserve the review round and valid perspective outputs, reopen
  malformed perspectives with their rejection evidence, and validate lane paths before quarantine.
- **Pipeline verification defaults and rejection history are implemented** in `4b977383`.
  Omitted test/e2e commands come from persisted project facts and pass current-manifest
  admission at close. Both ingestion flows retain rejection explanations across calls;
  recovery acceptance stays distinct from clean acceptance. The combined implementation
  passed 6,460 local tests and every non-test release gate.
- **The commit gate runs at git's own boundary.** The tracked `.githooks/` run
  `.claude/hooks/commit-gate.mjs` for every commit into this repository; the PreToolUse
  `pre-commit-gate.mjs` keeps only what git cannot see (the hook-bypass refusal, the push
  child-session refusal, and routing of gated incoming content for merge, cherry-pick and revert).
- **The commit gate is wired per clone.** `core.hooksPath` is a git setting the SessionStart guard
  points at `.githooks` (writing the worktree scope too where `extensions.worktreeConfig` makes a
  `.git/config.worktree` entry win). A clone that has never opened a session runs no commit gate
  until it does; the registry row states this as the uncovered half.
- **The 2026-09-06 maintenance decision queue is closed.** The tracked inbox is empty and every
  answer carries completion evidence in the decision ledger. Generator freshness and
  invariant-glossary completeness are reconciled gates; eligible document gates report at write
  time without blocking; shell-guard remedies round-trip through their guards; source installs
  build shared output before host deployment; and a full-suite failure now owns its isolated
  diagnostic, load-only record, recurrence warning and repair-investigation dispatch.

## Immediate next

**Finish the active pipeline-quality lap.** The shared JSON byte-marker fix and bare
full-audit depth correction are released; benchmark objective forwarding is fixed on main.
The recovery and fixture corrections through `f3327f34` passed 6,508 local tests,
the complete CI suite, and non-test CI checks. The free Muse host
now has verified graph search, trace, snippet, and coverage through a fixture-bound helper.
The held-out calibration reached final design review but exceeded its wall deadline
during a host quota pause. Completed native outputs are preserved for an explicitly
unscored continuation. Benchmark crash recovery is integrated in `86f512d1`, with
39 focused tests passing, original-source verification, and SQLite run ownership.
The isolated graph-disabled trial exposed a late capability notice after semantic
review. The early loader stop rule passed a fresh isolated live trial and is
released in 0.51.4. The unscored continuation accepted the repaired conceptual judge,
and a fresh invocation passed the previous no-progress stop. That invocation used
the frozen v0.51.3 checkout and did not prove the published metadata fix ran.
The first systemic challenge round was accepted, then the runner rejected the next
round's reused identity. Round identity and quiet-result replay fixes are published
in v0.51.7 after 58 targeted tests, independent review, and complete release CI.
The continuation now explicitly uses the isolated published backend, with immutable
unscored upgrade lineage preserving its first 553 calls (23,529,315 input and
274,263 output tokens). Its fresh round-2 identity passed the repeated-step guard,
but three Muse attempts then returned retryable HTTP 429 responses with no result.
They add three error-only calls and zero tokens, retained separately from accepted
task receipts. The next eligible retry is after the existing continuation deadline.
Owner decision: authorize a separate unscored recovery window of at most four
hours after Muse capacity returns, retaining cumulative call/token caps and every
earlier failure, or leave the benchmark paused. No existing deadline may change.
After a genuine terminal, complete the ten paired quality comparisons.
Evidence and limits are in
[pipeline-quality-2026-09-07.md](reviews/pipeline-quality-2026-09-07.md).
No quality score exists; successful preflight and contract tests are not acceptance.

## Deliberate state, not bugs

- **Line anchors under the runtime state dirs are left alone on purpose.** 2,781 of them sit in
  generated tool output, which the next run rewrites, so a refusal there would be unfixable by
  editing. The line-anchor rule therefore covers every tracked doc EXCEPT those dirs — including
  dated review records, which were cleaned of all 935 of theirs. `check-doc-code-citations.mjs`
  states this beside the scope itself.

- The judge-side naming refusal is unreachable on the production path by design of the parse
  order: the property it guards holds twice over, and only its claimed reach does not. Tracked
  in [`minor-bugs.md`](backlog/minor-bugs.md).
- The charter packet builder no longer caps packet size; its coverage manifest records only
  unreadable or empty omissions.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **12 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-dependency-map-analyzer-vocabulary` — A constitutional spec still describes the analyzer-capability marker with a vocabulary the code deliberately removed — restate it, or move the code back?
  - `docs-remediation-goals-output-order-omits-two-exclusion-classes` — The remediation goals document states the report's section order, and the render has two categories that order has no bullet for — widen it, or declare it a minimum?
  - `docs-audit-prompt-reflection-destination-unnamed` — The audit loader prompt tells the host to record a reflection but never says which file to write it to — name the destination, and pin it in the contract test?
  - `docs-remediate-prompt-has-no-target-directory-rule` — The remediate loader prompt carries no target-directory rule while its audit twin does — copy the rule across, or single-source it?
  - `docs-benchmark-readme-omits-run-contract` — The benchmark README omits `run`'s checkpoint and recovery behaviour, and one acceptance threshold — document them, or point at the runner as authoritative?
  - `docs-audit-pkg-language-convictions-two-homes` — Three language/analyzer convictions are stated twice, in different words, across two audit-pkg docs — pick one home?
  - `docs-risk-tier-semantics-in-three-specs` — The risk-tier collapse rule is stated three times across three specs — reduce two of them to a pointer?
  - `docs-s8-conceptual-review-contract-split-across-specs` — The conceptual design review's contract is split across two specs — fold section S8 into the review's own design-of-record?
  - `docs-five-recorded-condensation-findings-batch` — Five spec condensation findings recorded last run still stand, and one was routed at the wrong file — apply them as a batch, or keep recording them?
  - `docs-repo-start-lap-skill-is-shadowed-by-the-global-one` — The repository's own /start-lap skill never runs — the global skill of the same name shadows it. Re-home its steps, rename it, or delete it?
  - `backlog-handoff-immediate-next-is-a-chronology` — docs/HANDOFF.md's Immediate next has become a run chronology — cut it to the next action, or relax the never-a-changelog rule for a benchmark lap?
  - `backlog-open-bugs-entries-carry-narrative-before-the-open-half` — Three open-bugs entries put shipped history, an incident report, or a refuted framing ahead of the open half — condense them to mechanism plus open property?

<!-- END GENERATED LIVE STATUS -->

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Audit-tools deep-review acceptance benchmark still needs its external run. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
