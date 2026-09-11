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
  child-session refusal, routing of gated incoming content for merge, cherry-pick and revert, and
  healing a crashed staged-snapshot round-trip left by the git-boundary gate).
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

**Land the seven implementation waves of the cleanup-and-implementation lap, then `/ship`.** Each
packet lands by fast-forward from its own worktree and the full suite is re-run on `main` after
every wave; the per-packet briefs and the entry-coverage check live in the lap's machine-local plan
directory `C:/Code-worktrees/audit-tools/_lap-plan/` <!-- doc-citation-exempt: machine-local plan directory, outside every repo -->.

**Live owner decision:** none. The waiting maintenance decisions are settled by standing
convictions and are ticked in the inbox as their packets land.

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
  - `docs-remediation-goals-output-order-omits-two-exclusion-classes` — The remediation goals document states the report's section order, and the render has two categories that order has no bullet for — widen it, or declare it a minimum?
  - `docs-audit-prompt-reflection-destination-unnamed` — The audit loader prompt tells the host to record a reflection but never says which file to write it to — name the destination, and pin it in the contract test?
  - `docs-audit-pkg-language-convictions-two-homes` — Three language/analyzer convictions are stated twice, in different words, across two audit-pkg docs — pick one home?
  - `docs-risk-tier-semantics-in-three-specs` — The risk-tier collapse rule is stated three times across three specs — reduce two of them to a pointer?
  - `docs-five-recorded-condensation-findings-batch` — Five spec condensation findings recorded last run still stand, and one was routed at the wrong file — apply them as a batch, or keep recording them?
  - `docs-repo-start-lap-skill-is-shadowed-by-the-global-one` — The repository's own /start-lap skill never runs — the global skill of the same name shadows it. Re-home its steps, rename it, or delete it?
  - `solutions-nightly-output-placement-on-a-feature-branch` — This run's output was committed to a feature branch rather than the main line — cherry-pick it, wait for the branch, or re-run the whole routine later?
  - `backlog-open-bugs-entries-carry-narrative-before-the-open-half` — Three open-bugs entries put shipped history, an incident report, or a refuted framing ahead of the open half — condense them to mechanism plus open property?
  - `docs-glossary-omits-a-live-n-idempotency-identifier` — The identifier glossary declares itself the lookup for opaque ids in src/**/*.ts, and N-IDEMPOTENCY is live in two modules with no row — add a row, fold it under INV-CK, or narrow the glossary's claim?
  - `backlog-a2-oracle-parenthetical-cites-a-retired-track` — The live-validation guide still qualifies the A2 oracle corpus and points at "Deferred / waiting", but the A2 track was retired and no such entry exists — delete the parenthetical, or keep the statement without the pointer?
  - `backlog-live-run-watch-matrix-names-items-that-resolve-nowhere` — The live-validation matrix tells a live run which items to watch, and most of the names it lists match no entry in docs/backlog/ — derive the matrix from the entries, or cut it to the rows that resolve?
  - `solutions-unearned-shipped-verdict-authorizes-deletion` — The backlog sweep may claim an entry SHIPPED while checking nothing, and five nightly runs have re-refuted the same lead by hand — enforce the pairing the module header already states (proposal P65)?

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
