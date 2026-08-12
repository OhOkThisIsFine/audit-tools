# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- The zero-adapter retirement is LANDED on `main` and published: audit-tools emits complete
  provider-neutral host workloads and ingests bound results; provider adapters, routing, quota
  accounting, backend sizing, and internal worker execution are retired.
- Old audit/remediation run artifacts are cleared; the artifact dir holds only the tracked
  deliverable pairs and the open decision queue. The tree is ready for a fresh dogfood run.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **19 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `backlog-1` — Close the doc-lint-rewrite entry, or name the process that rewrote the bytes — the entry states its own close condition and nobody has met it
  - `backlog-2` — The 2026-07-28 friction walk states a property nothing enforces — enforce it, accept it as advice, or close the entry
  - `sol-1` — Make the attest scripts refuse to bind to a tree the pre-commit gate would reject — and correct the durable-traps entry whose stated remedy is falsified
  - `sol-2` — The backlog sweep counts any record that parses as JSON as CLASSIFIED — five of tonight's 120 carry no verdict at all
  - `sol-3` — Leg 1 has no coverage accounting — build the stamp that leg 2 already has, build the full scope ledger the rubric specifies, or delete the ledger section
  - `sol-4` — Extend the buffering-pipe DENY to peer-CLI dispatch (`codex exec` / `agy -p`), or accept that a piped dispatch lane stays invisible until it exits
  - `sol-5` — Stop classifying `.claude/hooks/**` as a record path — it is executable guard source, and treating it as a record makes every hook item unprobeable
  - `docs-1` — Bring remediation-goals.md back in line with the retirement — three claims describe execution machinery that no longer exists
  - `docs-2` — audit-goals.md says the final report is promoted to the repo root; the code promotes it to .audit-tools/
  - `docs-3` — The entrypoint contract still advertises budget/step-limit and LLM-runtime inputs the retirement removed — narrow it, or keep the door open
  - `docs-4` — S8 describes an auto-complete stamp as shipped-with-a-known-gap; the stamp was never built at all
  - `docs-5` — A product non-goal still concedes that redirecting review into a second execution backend is possible — it is now impossible
  - `docs-6` — instruction-file edit: CLAUDE.md carries three claims the retirement invalidated — approve the batch
  - `backlog-3` — The "no submit chokepoint" entry compares against a lane the retirement deleted — reword it rather than delete the live half
  - `backlog-4` — A scratch-dir entry needs WIDENING, not trimming — its symbol was renamed, and the fix it claims shipped reaches no prompt at all
  - `sol-6` — A nightly item can never auto-close when the doc it asked you to RETIRE is deleted — patch written and red-green validated
  - `sol-7` — A child agent session looks exactly like yours to the repo Stop gates — so the gates recruit read-only subagents into committing and pushing
  - `sol-8` — Every gate reads the whole working tree and cannot tell whose mess it is — one such gate abandoned all 13 items of a run
  - `sol-9` — Host results arrive by a guessable file path, so a wrong filename, a missing file and a clean empty result are all shaped like success — 9 of 10 lanes drifted

<!-- END GENERATED LIVE STATUS -->

## Verification state

- Green at landing: full `verify:release` (all checks + packaging smokes + full vitest + linked
  smokes), plus independent stale-surface sweeps (docs, host-integration surfaces, backlog) and an
  independent loop-core review whose one confirmed defect (stale `host_handoff` binding surviving an
  applied clarification answer) was fixed red-green in the landing commit.

## Immediate next

1. Run the next dogfood lap (audit → remediate) on the zero-adapter architecture — old run
   artifacts are already cleared.

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
