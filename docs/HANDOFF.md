# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **The unlanded 2026-07-30 stack is RE-LANDED — 8/8 commits, owner decision executed and
  closed (2026-08-07).** Review method + per-commit verdicts + landing adaptations:
  [`reviews/reland-review-2026-08-07.md`](reviews/reland-review-2026-08-07.md). Commits
  `b27f27d9`…`24d12f62` on main; preservation branch deleted; open-bugs entry removed. Now
  ON MAIN and relevant to the pinned re-detection item: `ProviderConstructionError` +
  `ProviderLaunchOutcomeEnvelope` (CP-NODE-4), `classifyProviderConstructionAttempt` + the
  explicit `clear_persisted_state` directive (CP-NODE-3), pausePersist locked-store
  atomicity + terminal ratchet + full-success pause clear (CP-NODE-6).
- **Offload topology finding (2026-08-07):** this Claude-Desktop session's traffic bypasses
  headroom/llm-relay entirely — CC 2.1.223's launcher-stamped process env wins over the
  settings.json env block (it worked on 2.1.220; the property flip-flops across releases).
  Subagents therefore ran on real Anthropic, not DeepSeek. Verify by TRAFFIC (headroom log
  mtime, relay observed traffic, provider spend), never config. Details + nested-CLI overlay
  workaround status: project memory `claude-desktop-proxy-redirect-flip-flops` and the new
  nested-`claude -p` entry in [`backlog/durable-traps.md`](backlog/durable-traps.md).

## Verification state

- Full suite after the final landing commit: **7,640 passed / 0 failed** (`npm test`,
  vitest-gate classified the known reporter-RPC false-RED as PASS — tracked in open-bugs).
  Every landing commit was individually green (check + check:tests + touched suites);
  loop-core commits carry review attestations. Tree clean and pushed at `24d12f62`.

## Immediate next

1. **Provider mid-run re-detection** (open-bugs, HIGH, pinned) — implement Option B per the
   annotated draft in
   [`reviews/backlog-sprint-2026-08-06.md`](reviews/backlog-sprint-2026-08-06.md). The 4
   named implementation gaps: (a) no provider-death outcome in `classifyFailureChannels`
   (`src/shared/dispatch/providerLaunchFinalize.ts`); (b) `DispatchPausedState` lacks
   provider identity (`src/audit/types/activeDispatch.ts`); (c) no per-pool spawn-failure
   counter (`QuotaStateEntry`, `src/shared/quota/types.ts`); (d) thread the existing
   `CapacityPool.providerName` (required field — no new join infrastructure needed) into
   the pause artifact. The envelope substrate is now LANDED on main (see Live state), so
   the construction-time pattern can be extended to the mid-run retryable class directly.

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
> `verify:checks` and at commit). 2 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ Provider auto-selection is construction-time-only — a mid-run provider death has no re-detection or fallback (2026-08-06 self-audit ARC-e01faa3e, verified, high). · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
