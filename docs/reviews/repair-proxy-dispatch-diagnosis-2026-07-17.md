# Why the claude-worker / repair-proxy lane dispatches zero — full trace (2026-07-17)

Timeless-ish diagnostic snapshot from the re-dogfood lap. Records the mechanism and the
one missing coupling, so it isn't re-derived. Shipped detail → git log; open sequencing → HANDOFF.

## Live state at diagnosis (all healthy)
- **repair-proxy is UP and healthy** — `127.0.0.1:8791`, `GET /registry` ~25ms warm (cold first
  probe is slow → the known cold-catalog liveness drop, backlog line ~44; all 4 provider keys set).
- **Populate cache is FRESH** — `~/.audit-code/catalog-cache.json` fetched today 16:30, endpoint
  matches, **8 `claude-worker` sources, `worker_kind:"agentic"`, `cost_per_mtok:0`** (groq-backed, free).
- So the two-step declared-source expansion's POPULATE half is satisfied.

## The mechanism (confirmed in code)
1. **claude-worker = kind-1 launch transport** (`src/shared/providers/claudeWorkerProvider.ts:80-181`):
   spawns `claude -p` with a **required `ANTHROPIC_BASE_URL` overlay → repair-proxy**, a dummy API key
   (never the real ambient one), `--model <backend_provider>/<model>` as the proxy's routing namespace,
   scrubbed parent env. ⇒ a proxied claude-worker is a **full agentic `claude -p` worker on a free
   backend = a host-subagent-equivalent, off-quota.** This is the wiring the owner means by "repair-proxy
   makes other provider dispatches function like your host subagents."
2. **Declared `repair_proxy` → claude-worker pools** (`src/shared/providers/auditorSources.ts`): a
   two-step — POPULATE (`populateProxyCatalog`, fetch `/registry` → cache) then RESOLVE (a live-probe-pass
   expands **from the cache** into claude-worker capacity pools). Line ~511: *"reachable but the populate
   cache is absent/invalid → run the registry populate to expand this lane."*

## The gap (why 0 dispatched)
The source pools (incl. claude-worker/proxy) only fan out inside the **in-process rolling-dispatch hybrid
path**, and that path is gated (`src/audit/cli/nextStepHelpers.ts:259-268`, `rollingAuditDispatch.ts:158`):

> route to the in-process rolling driver **when `rolling_engine` is ON AND an explicit in-process backend
> provider is configured** → then host + backend + any NIM/claude-worker source fan out concurrently.

- `rolling_engine` resolves: option → `sessionConfig.dispatch.rolling_engine` → `AUDIT_CODE_ROLLING_ENGINE` env.
- A **conversation-first host run** (empty `session-config.json`, provider = claude-code host) meets
  NEITHER condition → the task-dispatch obligation emits a host **`semantic_review`** step handed back to
  the host (my Anthropic quota). The claude-worker pools are never dispatched to.
- **Conversation-first host fan-out to the proxy is the UNBUILT follow-on** (HANDOFF ▶ IMMEDIATE NEXT
  step 2: the Agent-tool carrier + "host fan-out half … is the follow-on commit").

### Evidence from the parked dogfood run
`.audit-tools/audit/runs/20260717T062404401Z_audit_tasks_completed_001` (yesterday 23:24):
`status:"dispatched"`, `dispatch-plan.json = []`, `admission.granted_packet_ids = []`, **436 pending / 0
dispatched**, `capacity_pools = [claude-code/*]` only, `source:"provider_default"`. It froze with only the
host pool — proxy was cold/down at creation so the lane never expanded. Resuming it can't help (pools
froze at creation). (It DID capture a real `claude-oauth` quota snapshot: 58% session / 72% weekly.)

## RESOLUTION (2026-07-17, shipped + verified)
The probe cold-drop was the root cause, and it is fixed both sides:
- **repair-proxy `catalog.ts`** — `ModelCatalog.list` is now **stale-while-revalidate**: a stale cache is
  served immediately while a deduped background refresh updates it; only a genuine cold start (no prior)
  blocks. So `GET /registry` never pays a multi-second upstream rebuild — a liveness probe is always fast.
- **audit-tools `auditorSources.ts`** — `defaultProbeHttpReachable` now retries at an **escalating budget**
  (`probeReachableWithEscalation`, [1s, 4s]) so one cold probe cannot drop a healthy lane. (Not loop-core.)

**Verified:** `resolveAmbientSources` returns **8 pools (was 0)**; a fresh run's Gate-0 roster lists them
as routable `$0.00` sources; direct claude-worker-style dispatches through the proxy routed to
`mistral/mistral-medium-3.5` (200, a correct divide-by-zero finding — a FREE, off-Anthropic-quota model),
`groq/qwen/qwen3-32b` (200), `openrouter/anthropic/claude-fable-5` (200), `nim/z-ai/glm-5.2` (429, backend
rate-limit) — the proxy log records the backend per request ("know we're doing it"). Corrected belief:
the conversation-first host fan-out was NOT unbuilt — dispatch is already pool-availability-driven; the
probe was the only blocker. Open: raw `claude -p` on a small-context backend hit 413 — confirm in a live
run that real packet-sizing (`packet_too_large`) routes oversized packets away from small pools.

## What it actually takes to dogfood the lane
A **fresh run** with proxy live + cache fresh (both true now) **AND** the rolling-dispatch hybrid armed:
`rolling_engine` ON + an explicit in-process backend provider (openai-compatible NIM / codex / opencode)
as the driver. Then host + claude-worker(proxy, 8 free agentic pools) + NIM fan out; the claude-workers
spawn `claude -p` through the proxy = off-quota host-subagent-equivalents. The backlog residual's ⬇ watch
line is the pass/fail checklist (413→`packet_too_large`, 429→`cooldown_until`, drop reasons, etc.).

## The fork this surfaces
- **(A) Rolling-engine dogfood now:** fresh run, `rolling_engine` + a backend driver + the declared
  claude-worker pool → watch the fan-out spawn proxy workers. Exercises the built lane; needs a driving
  backend chosen.
- **(B) Build the conversation-first host fan-out (the unbuilt follow-on):** let a plain conversation-first
  host run fan its own subagent work (e.g. this lap's charter/perspective/adversary dispatch) out to the
  claude-worker pool — i.e. the host offloads to free groq models through the proxy instead of burning
  Anthropic quota. This is the most literal reading of "make provider dispatches function like host
  subagents" for the conversation-first product surface, and it's gated on step-2's Agent-tool carrier test.
