# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.7 is published and installed globally.** Release commit `a5ced6e3` passed the publish
  workflow; npm resolves 0.51.7 and both installed command surfaces report 0.51.7. The release
  workflow is [run 34189090341](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/34189090341).
- **The commit gate runs at git's own boundary.** The tracked `.githooks/` run
  `.claude/hooks/commit-gate.mjs` for every commit into this repository; the PreToolUse
  `pre-commit-gate.mjs` keeps only what git cannot see (the hook-bypass refusal, the push
  child-session refusal, and routing of gated incoming content for merge, cherry-pick and revert).
- **The commit gate is wired per clone.** `core.hooksPath` is a git setting the SessionStart guard
  points at `.githooks` (writing the worktree scope too where `extensions.worktreeConfig` makes a
  `.git/config.worktree` entry win). A clone that has never opened a session runs no commit gate
  until it does; the registry row states this as the uncovered half.
- **A relay lane child is recognized as a dispatched child.** `readSessionRegistry` treats a
  positive `LLM_RELAY_DISPATCH_DEPTH` (set by llm-relay `dispatch` in every lane child) exactly like
  `AUDIT_TOOLS_CHILD_SESSION=1`, so the session-scoped Stop gates never recruit a lane's report.
- **The benchmark track is retired (owner decision 2026-09-10).** Its forward-track entries, its
  harness and its contract tests are gone; the shipped `score-audit` command stays.

## Immediate next

**Cleanup-and-implementation lap (opened 2026-09-10).** P00 cleanup is on `main`: the maintenance
routine's commits are fast-forwarded, and stray worktrees, merged branches and the forensics stash
are gone. Seven implementation waves follow — each packet in its own worktree outside the repo root
on a DeepSeek lane through llm-relay, landed by fast-forward, the full suite re-run on `main` after
every wave, and a `/ship` release after the last wave. The plan, the per-packet briefs and the
161-entry coverage check live in the lap's machine-local plan directory,
`C:/Code-worktrees/audit-tools/_lap-plan/` <!-- doc-citation-exempt: machine-local plan directory, outside every repo -->.
The waiting maintenance decisions are settled there by standing convictions and are ticked in
the inbox when their packets land.

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

- **13 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-dependency-map-analyzer-vocabulary` — A constitutional spec still describes the analyzer-capability marker with a vocabulary the code deliberately removed — restate it, or move the code back?
  - `docs-remediation-goals-output-order-omits-two-exclusion-classes` — The remediation goals document states the report's section order, and the render has two categories that order has no bullet for — widen it, or declare it a minimum?
  - `docs-audit-prompt-reflection-destination-unnamed` — The audit loader prompt tells the host to record a reflection but never says which file to write it to — name the destination, and pin it in the contract test?
  - `docs-remediate-prompt-has-no-target-directory-rule` — The remediate loader prompt carries no target-directory rule while its audit twin does — copy the rule across, or single-source it?
  - `docs-audit-pkg-language-convictions-two-homes` — Three language/analyzer convictions are stated twice, in different words, across two audit-pkg docs — pick one home?
  - `docs-risk-tier-semantics-in-three-specs` — The risk-tier collapse rule is stated three times across three specs — reduce two of them to a pointer?
  - `docs-s8-conceptual-review-contract-split-across-specs` — The conceptual design review's contract is split across two specs — fold section S8 into the review's own design-of-record?
  - `docs-five-recorded-condensation-findings-batch` — Five spec condensation findings recorded last run still stand, and one was routed at the wrong file — apply them as a batch, or keep recording them?
  - `docs-repo-start-lap-skill-is-shadowed-by-the-global-one` — The repository's own /start-lap skill never runs — the global skill of the same name shadows it. Re-home its steps, rename it, or delete it?
  - `solutions-nightly-output-placement-on-a-feature-branch` — This run's output was committed to a feature branch rather than the main line — cherry-pick it, wait for the branch, or re-run the whole routine later?
  - `backlog-handoff-immediate-next-is-a-chronology` — docs/HANDOFF.md's Immediate next has become a run chronology — cut it to the next action, or relax the never-a-changelog rule for a benchmark lap?
  - `backlog-open-bugs-entries-carry-narrative-before-the-open-half` — Three open-bugs entries put shipped history, an incident report, or a refuted framing ahead of the open half — condense them to mechanism plus open property?
  - `solutions-agents-region-has-no-freshness-authority` — The AGENTS.md generated block has drifted from CLAUDE.md since 2026-09-07, and it has now blocked two nightly runs from applying anything — add a check here, fix the generator for every repository, or accept the drift?

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
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
