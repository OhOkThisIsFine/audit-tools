# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.0 is live**, published from the release commit `e6329a44`; the release workflow
  passed and the registry artifact is installed globally. Both `audit-code --version` and
  `remediate-code --version` report `0.51.0`.
- **Every owner-answered decision that is actionable here has a landed commit** recorded in
  the decisions ledger under `.claude/`. The six owner decisions of 2026-09-05 all landed the same
  day; the largest, P53, moved the commit gate to git's own boundary: the tracked `.githooks/`
  run `.claude/hooks/commit-gate.mjs` for every commit into this repository, and the PreToolUse
  `pre-commit-gate.mjs` keeps only what git cannot see (the hook-bypass refusal, the push
  child-session refusal, and routing of gated incoming content for merge, cherry-pick and revert).
- **The commit gate is wired per clone.** `core.hooksPath` is a git setting the SessionStart guard
  points at `.githooks` (writing the worktree scope too where `extensions.worktreeConfig` makes a
  `.git/config.worktree` entry win). A clone that has never opened a session runs no commit gate
  until it does; the registry row states this as the uncovered half.
- **The four closeout decisions of 2026-09-04 are answered**: the one cleanup rule stays as
  landed; a `custom` closing action keeps its command on the checkpoint with no close-phase
  preview; the Node matrix stays on floating majors; test-command detection is a filed
  forward track, not wired.
- **The nine live-run design assumptions are decided**: the owner confirmed eight and reversed
  one on 2026-09-04, as the design-gate record states beside each in
  [`live-run-defect-set-design-gate-2026-09-03.md`](reviews/live-run-defect-set-design-gate-2026-09-03.md).

## Immediate next

The external 5-primary + 5-held-out paired benchmark run described in
[`forward-tracks.md`](backlog/forward-tracks.md) is the pinned forward track.

The dispatch-routed leg-2 sweep has now run unattended and is proven: 98 of 98 entries
classified, all on `free-pool`, zero errored after one retry of a single empty-output lane.

The next lap that commits from this checkout is the first to do so through git's own hook
in ordinary work; read the gate's stderr on that commit as the acceptance evidence for P53.
Read a run's own `<out>-coverage.json` stamp before trusting its leg-2 report.

## Deliberate state, not bugs

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
