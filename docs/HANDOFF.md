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

**Hotspot #7** is the one unlanded item of the 2026-09-05 duplication-and-complexity sweep;
the other twelve shipped on 2026-09-05. Its spec and its blockers are in
[`forward-tracks.md`](backlog/forward-tracks.md), pinned. Do the characterization lock
before the split: it is a fail-closed ingestion boundary whose own plan names fail-open
regression as the highest risk.

Every plan in that sweep was re-checked against HEAD before implementation, and the record of
what did not hold is [`refactor-plan-verification-2026-09-05.md`](reviews/refactor-plan-verification-2026-09-05.md).
Read the brief for an item before implementing it — three plans would have caused a regression
if followed as written, and the Hotspot #7 brief is one of the nine.

**P53 has its acceptance evidence.** The commit gate fired at git's own boundary during ordinary
work and REFUSED two commits: a stray doc absent from the manifest, and a constitutional-doc
rewrite with no owner override. Both refusals were correct and both named their fix.

## Deliberate state, not bugs

- The judge-side naming refusal is unreachable on the production path by design of the parse
  order: the property it guards holds twice over, and only its claimed reach does not. Tracked
  in [`minor-bugs.md`](backlog/minor-bugs.md).
- The charter packet builder no longer caps packet size; its coverage manifest records only
  unreadable or empty omissions.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **10 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `l1-1` — Nightly lane: the routine tells itself to run `llm-relay dispatch -t` and use the first ready lane's printed command, but that command never prints one — which lane form should the doc name?
  - `l1-2` — Instruction-file edit: four CLAUDE.md claims went stale when the commit gate moved to git’s boundary (P53) — apply the four corrections?
  - `l1-3` — Loader prompt asks the host for a reflection the parser silently DROPS — add the missing required field, or change the parser?
  - `l1-4` — Two invariant namespaces used in src/ (INV-COVERAGE, INV-SSF) have no glossary row, and no gate checks completeness — add rows, or narrow the claim?
  - `l1-5` — HANDOFF narrates three already-settled decision batches — trim them as changelog, or is the narration load-bearing?
  - `bl-1` — Backlog: the "paraphrase inverted the mechanism" entry describes an incident whose offending text is GONE — keep it, or reduce it to its durable rule?
  - `sol-1` — P54: guards print hand-written remedies that the guard itself would refuse — make the refusal text declared data and round-trip it, and in which scope?
  - `sol-2` — P55: file-scoped gate legs fire only at commit, often in another session — run them advisory at WRITE time, or not at all?
  - `sol-3` — P56: five generated artifacts have gone stale unnoticed — reconcile every generator against a declared freshness authority (patch and red-green test attached)?
  - `sol-4` — P57: a test that fails only under full-suite load reports as a bare red — classify it at the gate, or decline as under-evidenced?

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

- ▶ Hotspot #7 — `ingestRemediationHostResults` still interleaves validation, verification and mutation (2026-09-05). · [`forward-tracks.md`](backlog/forward-tracks.md)
- ▶ Audit-tools deep-review acceptance benchmark still needs its external run. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
