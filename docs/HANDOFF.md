# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.2 is published and installed globally.** Release commit `8d60c2a9`
  passed the six-job publish workflow, including all four test shards; npm resolves 0.51.2 and
  both installed command surfaces report 0.51.2. The release workflow is
  [run 34155063393](https://github.com/OhOkThisIsFine/audit-tools/actions/runs/34155063393).
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

**Finish the active pipeline-quality lap.** The shared JSON byte-marker fix is committed
on `codex/pipeline-quality` but is not released. Regression fixes for bare full-audit
depth and benchmark objective forwarding are being verified. The AGY calibration ended
shallow and over budget; a lean external host is being calibrated before the complete
paired comparison. Evidence and limits are in
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
