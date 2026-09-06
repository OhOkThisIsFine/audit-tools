# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.0 is live**, published from the release commit `e6329a44`; the release workflow
  passed and the registry artifact is installed globally. Both `audit-code --version` and
  `remediate-code --version` report `0.51.0`.
- **The commit gate runs at git's own boundary.** The tracked `.githooks/` run
  `.claude/hooks/commit-gate.mjs` for every commit into this repository; the PreToolUse
  `pre-commit-gate.mjs` keeps only what git cannot see (the hook-bypass refusal, the push
  child-session refusal, and routing of gated incoming content for merge, cherry-pick and revert).
- **The commit gate is wired per clone.** `core.hooksPath` is a git setting the SessionStart guard
  points at `.githooks` (writing the worktree scope too where `extensions.worktreeConfig` makes a
  `.git/config.worktree` entry win). A clone that has never opened a session runs no commit gate
  until it does; the registry row states this as the uncovered half.
- **The 2026-09-05 duplication-and-complexity sweep is complete.** Hotspot #7 landed on
  2026-09-06, so `ingestRemediationHostResults` is now a ~40-line orchestrator over
  `validateHostResultBundle`, `executeHostVerificationReruns` and
  `commitRemediationStateUpdates`, all three file-local. The owner chose the deepest of the three
  offered seams — split fully, preserve behaviour — so the couplings that made the plan's own
  seam wrong are neutralised rather than accepted: the per-item pending set and timestamp ride on
  the verdict, and a settled-finding set restores what the pending filter used to observe. The
  accepted-file set stays a verification-phase accumulator, which is where the plan had it wrong.
  `tests/remediate/host-ingest-phase-boundary.test.ts` pins the boundary so it cannot erode back.

## Immediate next

**Implement the remaining settled owner decisions of 2026-09-06.** They are pinned in
[`open-bugs.md`](backlog/open-bugs.md) and appear in the generated list below. The answers
themselves live in the decisions ledger under `.claude/`, which is their one home — read them
there. Two of the ten are now landed: `l1-5` (the HANDOFF trim) and `6aebffe0` (the loader prompt
and the reflection parser, in the lap below).

**Then close instance 4's reporting half.** Its entry states the uncovered half outright. The fix
is a READER of the submission ledger drawn by both draws, never a second writer — see the entry.

- **The loop's silent-drop class is closed, four instances outright and one in half.** Where the
  orchestrator computed something the host needed and then emitted a step that did not carry it, it
  now carries it: a discarded extracted plan emits `extracted_plan_discarded` naming the reason
  rather than the no-input step; the contract-repair prompt names the gate that actually fired
  instead of always claiming the judge; the audit loader prompt names every reflection field its
  own parser requires; systemic findings must carry evidence, and every finding the intake removes
  is written to a record a run produces at
  <!-- doc-citation-exempt: a runtime artifact written into the run's artifacts dir, never a tracked file -->
  `dropped-findings.md`. The fifth, host-ingest reporting across a CALL boundary,
  has its durable half closed and its uncovered half stated in the entry. Evidence, the independent
  refutation and what it overturned:
  [`loop-silent-drop-design-gate-2026-09-06.md`](reviews/loop-silent-drop-design-gate-2026-09-06.md).

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
> `verify:checks` and at commit). 2 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Nine owner decisions of 2026-09-06 are settled and unimplemented (2026-09-06, medium). · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ Audit-tools deep-review acceptance benchmark still needs its external run. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
