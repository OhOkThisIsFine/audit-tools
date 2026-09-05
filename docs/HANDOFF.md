# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.0 is live**, published from the release commit `e6329a44`; the release workflow
  passed and the registry artifact is installed globally. Both `audit-code --version` and
  `remediate-code --version` report `0.51.0`.
- **Every owner-answered decision that is actionable here has a landed commit** recorded in
  the decisions ledger under `.claude/`. The last one, routing the leg-2 triage sweep through
  llm-relay dispatch, landed 2026-09-04: the sweep speaks MCP stdio to `llm-relay mcp` through
  `scripts/shared/mcp-dispatch-lane.mjs`, names no model, and records the lane that answered
  each entry (owner choice: the dispatch tool per entry, not the `auto` alias over HTTP).
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
Read a run's own `<out>-coverage.json` stamp before trusting its leg-2 report.

## Deliberate state, not bugs

- The judge-side naming refusal is unreachable on the production path by design of the parse
  order: the property it guards holds twice over, and only its claimed reach does not. Tracked
  in [`minor-bugs.md`](backlog/minor-bugs.md).
- The charter packet builder no longer caps packet size; its coverage manifest records only
  unreadable or empty omissions.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **6 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `l1-1` — Instruction-file edit: four factual corrections in CLAUDE.md — apply them, or drop the two hand-copied lists instead?
  - `l1-2` — Normative spec: remediation-goals.md still puts project-fact detection in Phase 1, but c899265a moved it to the confirm step — correct the spec, or is the spec the target the code should meet?
  - `l1-3` — Normative spec: remediation-goals.md promises e2e_command DETECTION that is not wired anywhere — say so, or build it?
  - `l1-4` — Doc-set condensation: the ingestion check set lives in three docs and each names a different check — pick one home, and which?
  - `bl-1` — Backlog: three friction walks each list guards that behaved CORRECTLY — delete those sub-items, or is that list load-bearing?
  - `sol-1` — P53: the commit gate guesses at a boundary git owns, and a memory note calls that defect closed while it is live — move the gate to core.hooksPath?

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
