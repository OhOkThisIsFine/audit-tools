# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.39.1 SHIPPED 2026-08-07 (niggle-fix lap).** Five commits (`5b721f34`…`12d5e7ca`): Stop
  gates skip stops that are waits on live background work (the payload's `background_tasks` /
  `session_crons` — memory `stop-payload-background-tasks-signal`); guard-reach registry
  registered two live-but-unclaimed hook contract tests; free-form clause splitter no longer
  breaks inside path tokens; `--guidance-file` + `--input` now produce an input-bound `mixed`
  manifest (attested loop-core review, verdict CLEAN). The vitest "false-RED" backlog entry was
  recharacterized to HEAD truth: the exit-code half was ALREADY closed by `run-vitest-gate`
  (2026-07-24); the candidate sweep LANDED (verified) as
  [`reviews/rpc-starvation-candidates-2026-08-07.md`](reviews/rpc-starvation-candidates-2026-08-07.md),
  and the one confirmed defect-class instance was fixed in `a12ce9a0` (sync full-CLI spawns →
  async). The entry stays open only for the next leads if the error recurs.
- **Concurrent-session WIP in this checkout (deliberate, 2026-08-07):** the CI wall-clock track
  (vitest sequencer + workflow/release-script edits) is live and uncommitted in the shared
  checkout — its mid-edit `vitest.config.ts` breaks direct `vitest` config load until it lands.
  Not this lap's work; do not commit, revert, or stash it.
- **Offload topology (2026-08-07, this session):** the Desktop→relay CLI dispatch lane
  (`llm-relay dispatch` rung `claude-deepseek-credits`) starts correctly, but the first run
  failed `ConnectionRefused` — **llm-relay was DOWN mid-session** (CLI child startup notices are
  NOT traffic evidence; only a completed relay-routed response is). Relay restarted via its
  Startup `.vbs` and re-probed listening; the sweep was re-dispatched. The Desktop session's own
  `/v1/messages` remain pinned to api.anthropic.com (CC 2.1.222 launcher env) — harness
  subagents spend primary quota; use dispatch rungs for offload, and verify the relay is
  LISTENING before trusting a lane.

## Verification state

- Full suite 7,674/0 (574 files) on the pre-commit tree 2026-08-07; release CI green for
  v0.39.1 (run 31205859432); npm live at 0.39.1; global bins reinstalled + postinstall run,
  both report 0.39.1. Loop-core commit `645973f4` attested (staged-tree-bound, agent class).

## Immediate next

1. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — the one remaining pinned
   item: live-run-watch properties.
2. Nightly queue: **docs-1 awaits the owner** (version-pinned status sentence in
   `spec/mechanical-analyzer-layer-design.md` — de-status vs. retire; answer via
   `node scripts/nightly/answer.mjs docs-1 "<answer>"`).
3. Host-memory chore (not repo work): `/consolidate-memory` — the memory index needs a real
   consolidation pass (pointer note at the top of `MEMORY.md`).

   ⚠ Standing hazard: `session-config.json` at repo root (untracked,
   `block_quota: {context_tokens: 200000, reserved_output_tokens: 32000, host_model: claude-opus-5}`)
   is load-bearing — recreate if absent.

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

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
