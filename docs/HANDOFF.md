# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **2026-08-06 backlog sprint SHIPPED as v0.37.0** (`348d9fa8` + smoke fix `7f615f64` + bump
  `bba85f36`; release CI fully green — gate + 4 test shards + publish; npm live; global bins
  reinstalled with postinstall. Multi-agent waves + orchestrator integration; full record in
  [`reviews/backlog-sprint-2026-08-06.md`](reviews/backlog-sprint-2026-08-06.md)):
  - **Mechanical analyzer layer items A/B/D** — safety-derived default set
    (hadolint/actionlint/type-coverage promoted; jscpd stays gated `executable`; semgrep pinned;
    `duration_ms` measured), **consent surfacing live end-to-end** (fold-level batched
    `analyzer_consent` offer step; decisions persist under `analyzer_consent` in session config;
    admission = default ∨ granted ∨ token, token overrides declined; e2e-pinned), and the lizard
    candidate (source-walk detection drives `-l`; leads-only threshold bands). Item C remains —
    see the pinned forward-track.
  - **2026-08-05 minor-friction cluster closed** — handshake persisted once + `--auditor @<file>`
    continue-commands; scope echo on EVERY step prompt (resume-blindness gone); advance liveness
    heartbeat; staleness-record dedupe per call; evidence-grounded observability rationale;
    fallback-stub item was already resolved (premise stale).
  - **Remediate gates** — worker scratch + unchanged tool-seeds now excluded at COMMIT ASSEMBLY
    (recorded in the accept sidecar); close gate drains a deduplicated, full-suite-subsumed
    deferred-verify residual (the sidecar field is now actually persisted).
  - **Dispatch/quota** — tier routing distributes across multi-rank rosters (operator
    `routing_tiers` always wins); `contractPipeline` threads the persisted handshake roster into
    `scheduleWave` (the concurrency-collapse-to-1 root cause).
  - **Worker/runtime** — task-file read failures always yield a failed WorkerResult (file or
    stdout); output-ratio learning fully deleted (no writer can exist — open-bugs:301); bare
    `python` Store-stub refusal via a real PATH walk.
  - Stale entries closed by verification (relay-liveness probe, doc-manifest predicate); the
    vitest false-RED entry stays OPEN with a reverted attempt recorded (top-level `projects` in
    vitest.config VOIDS the config → false GREEN — see the entry before retrying).
- Two dispatch waves ran entirely on a weak model despite explicit overrides (durable-traps
  entry): every agent patch was line-reviewed before landing; two inverted-semantics fixes and
  several vacuous tests were caught and redone by hand. A 16-agent adversarial review over the
  final diff confirmed 10 findings; all 10 are fixed in-tree.
- 179 orphan `remediate-CP-BLOCK-*` worktree DIRS from the closed 2026-08-06 run were MOVED (not
  deleted) to the session scratchpad after they broke filtered vitest runs; branches untouched —
  owner decision tracked in `open-bugs.md`.

## Verification state

- Full suite 7,551 passed / 0 failed at the ship tree; `build`/`check`/`check:tests`/
  `check:guard-reach`/`check:deadcode`/doc gates all 0; both packaged smokes green; **release CI
  green on v0.37.0** (the authoritative signal). Known noise: the suite still prints the tracked
  RPC-timeout "1 error" line (open false-RED/false-GREEN entry in `open-bugs.md`).

## Immediate next

1. **Analyzer item C** (mechanical re-verify at remediation close) — run `/design-check`, then
   implement per `spec/mechanical-analyzer-layer-design.md`; the prep record (advisory) is in
   [`reviews/backlog-sprint-2026-08-06.md`](reviews/backlog-sprint-2026-08-06.md).
2. **Provider mid-run re-detection** (open-bugs, HIGH, pinned) — design draft in the same record;
   verify its mechanism claims against the pause substrate before implementing.

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
> `verify:checks` and at commit). 3 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ Provider auto-selection is construction-time-only — a mid-run provider death has no re-detection or fallback (2026-08-06 self-audit ARC-e01faa3e, verified, high). · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ Mechanical analyzer layer — item C (re-verify loop) is the remaining piece. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
