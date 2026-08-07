# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Provider mid-run re-detection (ARC-e01faa3e) SHIPPED — item CLOSED (2026-08-07).** Three
  commits: `80523ccf` (provider_unavailable classified/counted/pool-settling, all six
  adjacent consumers handled, counter at the recordWaveOutcome chokepoint), `28e2b370`
  (dead-provider identity captured at strand time; pause names it), `1b7299f9` (resume
  excludes dead providers via the shared transport-keyed exclusion; remediate re-resolves
  per invocation, needing no persisted carry). Design-check gated; the draft's open
  questions got recorded dispositions in `1b7299f9`'s message (N-threshold DISSOLVED into
  pool exhaustion; exclusion lifetime = the pause record; prompt names provider + PATH).
- **The 2026-07-30 stack re-land is COMPLETE (same day, earlier):** 8/8 commits
  (`b27f27d9`…`24d12f62`), branch deleted, backlog entry closed — record:
  [`reviews/reland-review-2026-08-07.md`](reviews/reland-review-2026-08-07.md).
- **Offload topology (2026-08-07):** this Desktop session bypassed headroom/llm-relay all
  day (CC 2.1.223 launcher env wins; worked on 2.1.220 — the property flip-flops). The
  owner applied a relay-side fix mid-session; it CANNOT take effect for an already-running
  session — **verify by TRAFFIC at next session start** (headroom log mtime, relay observed
  traffic, provider spend; never config): memory `claude-desktop-proxy-redirect-flip-flops`.

## Verification state

- Item-close gates: 45/45 (exclusion + dc4 + audit dispatch), 139/139 (part-1 suites),
  115/115 (part-2 suites); check + check:tests green at every commit; loop-core commits
  attested. Full `npm test` last ran green at the re-land close (7,640/0); rerun at ship.

## Immediate next

1. **Ship the release** if not already done this session — the `/ship` flow (verify green →
   version → publish → verify live → reinstall bins). Today's mainline carries the re-landed
   stack + the re-detection feature on top of v0.38.1.
2. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — the one remaining pinned
   item: live-run-watch properties.
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
