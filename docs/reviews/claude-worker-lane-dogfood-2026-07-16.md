# Claude-worker lane dogfood — 2026-07-16 (owner-attended, first live run)

Benchmark to beat: the 2026-07-15 dogfood (430 tasks planned, zero dispatched). Result: the
lane's **transport is proven end-to-end**; **zero packets succeeded**, all on backend
feedback gaps the lane doesn't yet close. Far past the old benchmark — packets launched,
workers ran agentic turns through the proxy, every failure is now a named, fixable class.

## What was proven working

- Declaration → populate → Gate-0 fold → confirmation → admission → **isolated proxied
  `claude -p` spawn** with the `<backend>/<model>` namespace composed at launch.
- **480 `/v1/messages` requests through the repair-proxy** across all four confirmed free
  pools: `nim/z-ai/glm-5.2` (353), `nim/moonshotai/kimi-k2.6` (66), `groq/openai/gpt-oss-120b`
  (31), `groq/qwen/qwen3-32b` (30). Per-worker routing + backend-keyed pool identity live.
- Worker heartbeats, stdout/stderr harvest per packet, graceful wall pause, resumable state.
- Gate-0 model-tier exclusion rules honored (4 metered pools excluded by `provider:model` rule).

## Defects found AND fixed this lap (shipped `bebd69f2`, `b6a5f0ea`)

1. `extractRegistryModels` couldn't parse the live proxy's provider-MAP registry → empty
   expansion. 2. Ranking read a nonexistent `score` field → alphabetical top-K picked
   TTS/embedding models. 3. Duplicate registry rows → duplicate pool identities.
4. **`claude-worker` missing from BOTH in-process provider sets** → lane confirmable but
   undrivable (313 packets all bound to the walled host pool). The fork itself is backlog'd.

## Failure classes still open (the run's data — 119 workers, 0 accepted results)

| Count | Signal | Root |
|---|---|---|
| 61 | CLI "Request too large (max 32MB)" | groq returned **413** on every request — the packet prompt + harness overhead exceeds groq's per-request cap; packets are sized against the HOST window, not the assigned backend's |
| 29 (307 proxy-side) | API 429 | NIM free-tier RPM saturated by 12 concurrent agentic workers; no backend-429 → pool-cooldown feedback on the claude-worker path |
| 28 (56 proxy-side 404) | "model may not exist" | `nim/moonshotai/kimi-k2.6` 404s live — the registry advertises capability data for a model the backend doesn't serve; populate never verifies per-model availability |
| 1 | repair refused | proxy's destructive-tool guard; expected behavior |

## Feedback gaps to close (backlog: "claude-worker lane dogfood feedback gaps")

- **Per-backend packet sizing:** admission/partition must fit each packet to the ASSIGNED
  pool's context/request caps (groq 413 class), not the host window.
- **Backend rate signal → pool pacing:** 429s from the worker's own API calls must reach the
  pool ledger (cooldown/demote), or concurrency per pool must be capped far lower for free tiers.
- **Populate-time model verification:** a top-K model that 404s should be demoted/dropped
  (availability analog of `declared_cost_drift`); registry capability data is a lead, not reach.

## Environment/process notes

- Staleness cascade: committing the mid-run fix invalidated the self-audit's planning chain
  (correct semantics; cost = full LLM re-plan). Backlog'd with two tool slivers.
- Stale prior-run shared confirmation suppressed the populate trigger (backlog'd, medium).
- Step prompts' trailing advance command turns any delegated executor into a second driver
  (backlog'd, medium; bit once live this lap).
- The paused run `20260717T062404401Z_audit_tasks_completed_001` is resumable once the gaps
  are fixed; the ~06:17 run dir holds the 119 worker outcome files (the corpus for this table).
