# Host fan-out to arbitrary proxy backends — design assessment (2026-07-17)

Goal (owner, verbatim intent): **use repair-proxy to launch arbitrary models toward arbitrary
(compatible) providers, and KNOW that we're doing it.** i.e. per-dispatch choice of backend
`provider/model`, with audit-code aware of and attributing each target — not just host subagents
transparently redirected.

## Model correction (owner, 2026-07-17): repair-proxy is a TRANSPORT, not a pool
- A **pool** = `(backend_provider[#account], model)` — the quota-bearing identity (NIM/X, groq/Y).
- **repair-proxy is a dispatch METHOD** to reach a pool — the one that wraps the Anthropic wire so a
  full agentic `claude -p` (tool-loop) worker runs on that backend. **Orthogonal to which pool.**
- The **same pool** (e.g. NIM/X) is reachable two ways: **direct** openai-compatible API (kind-3 packet
  worker, no tools) OR **via repair-proxy** (kind-1 agentic worker). Same quota identity either way.
- **This is already coded correctly:** `dispatchableSourceId` (`src/shared/quota/apiPool.ts:32-49`) keys
  on `backend_provider[#account]/model` and explicitly excludes the transport, so a proxied `claude-worker`
  lane and a direct lane to the same backend **dedup to ONE CapacityPool/ledger entry**. `source.provider`
  (`apiPool.ts:96-134`) is the *method* axis (`openai-compatible` direct · `claude-worker` via-proxy ·
  `codex`/`opencode`/`agy` CLI); `backend_provider`+`model` is the *pool* axis.
- ⇒ "8 claude-worker pools" earlier was wrong: those are `(backend, model)` **pools tagged
  reachable-via-proxy-as-agentic** — the same pools a direct dispatch would target. Dispatch has two
  orthogonal choices: **which pool** (tier/λ) and **which transport** (proxy when agentic wanted + live,
  else direct/host).

## Two dispatch mechanisms, and why only one meets the goal
| Mechanism | arbitrary provider/model? | audit-code knows/attributes? |
|---|---|---|
| Host **Agent-tool** subagents, session proxy-fronted (`ANTHROPIC_BASE_URL`) | ✗ — the Agent `model` param is an enum (opus/sonnet/haiku/fable); reaches only what the proxy's 4 `routing.tiers` map to | ✗ — audit-code emitted a host `semantic_review`; it believes it dispatched to `claude-code/*` |
| **claude-worker CLI** dispatch — `claude -p --model <provider/model>` spawned by audit-code (`src/shared/providers/claudeWorkerProvider.ts`) | ✓ — any namespace the proxy routes; the 8 resolved agentic pools are the arbitrary targets | ✓ — recorded in `dispatch-plan.json` / `dispatch-result-map.json` / the claude-worker capacity pool in `dispatch-quota.json` |

⇒ the goal is the **claude-worker CLI path**. The host-subagent-redirect path (spec line 28's "host
fan-out") is capacity-capped to the proxy's tier map and gives no per-target attribution, so it does not
satisfy "arbitrary … and know we're doing it."

## The gap (one trigger, not a rewrite)
The claude-worker CLI path already exists and already attributes — it just only fires behind the
rolling-dispatch hybrid gate (`src/audit/cli/nextStepHelpers.ts:259-268`,
`src/audit/cli/rollingAuditDispatch.ts:158`): **`rolling_engine` ON AND an explicit in-process backend
provider configured.** A conversation-first host run (empty config) meets neither, so its task-dispatch
obligation emits a host `semantic_review` instead. Meanwhile `self.proxy_transport` is a live handshake
field but has **no consumer** (`nextStepCommand.ts:349` comment: "3c, no consumer this commit").

## Proposed build — `proxy_transport` becomes the trigger
When the host descriptor carries `proxy_transport: true` **and** declared `repair_proxy` resolved into
claude-worker capacity pools (live probe + fresh populate cache — both true now: 8 agentic groq pools,
`cost_per_mtok:0`), the conversation-first next-step **drives in-process claude-worker dispatch to those
pools** rather than emitting `semantic_review`. audit-code (not the host) spawns the `claude -p` workers,
picks each packet's backend, and records the target.

Concretely:
1. **Trigger** (`nextStepHelpers.ts` dispatch gate): add `proxy_transport && claudeWorkerPoolsResolved`
   as a path into `driveRollingAuditDispatch`, alongside the existing `rolling_engine + backend-provider`
   path. (Decision A below: is `proxy_transport` sufficient on its own, or do we also default
   `rolling_engine` on when claude-worker pools are present?)
2. **Backend selection per packet** — reuse the existing `model_hint.tier` (`dispatch.ts:529
   resolveDispatchTier`): map each packet's tier (small/standard/deep) to a claude-worker pool by
   **relative capability + cost** (cheapest-fit for the tier), keeping the "never a named-model→tier map"
   invariant — the concrete `provider/model` is audit-code's *output* of tier→pool resolution, not a
   host-reported name. (Decision B: selection policy — cheapest-fit-per-tier vs cost/λ dial reuse.)
3. **Attribution / "know we're doing it"** — mostly already there on this path: `dispatch-plan.json`
   entries + `dispatch-result-map.json` carry the pool assignment; the claude-worker pool appears in
   `dispatch-quota.json capacity_pools` with `backend_provider`/`model`; add a next-step summary line
   ("dispatched N packets → groq/openai/gpt-oss-120b … via repair-proxy") so the surface states it
   explicitly rather than only living in artifacts.

## Open decisions for the owner
- **A. Trigger shape.** `proxy_transport` alone triggers claude-worker dispatch, or `proxy_transport`
  flips `rolling_engine` default-on only when claude-worker pools resolved? (The latter keeps one gate;
  the former is a distinct, self-describing trigger.)
- **B. Tier→backend selection policy.** Cheapest-fit-per-tier from the resolved pools, or route through
  the existing cost↔speed λ dial ([[cost-speed-dispatch-dial]])? Free pools (cost 0) make cost-first
  degenerate → tier/capability becomes the real discriminator.
- **C. Host's role.** Does the conversation host remain a pool (mixed host + claude-worker fan-out), or
  does `proxy_transport` route ALL packets to claude-worker pools (host reserved for synthesis/judgment)?
- **D. Non-audit surfaces.** Same trigger for the conceptual/design-review dispatch
  (`conceptualDispatch.ts`) and remediate implement dispatch, or audit task-dispatch first? (One-core
  principle says the trigger should be shared, but staging the first landing to audit is reasonable.)

## Constraints (loop-core)
`nextStepHelpers.ts` / `rollingAuditDispatch.ts` / `dispatch.ts` / quota are loop-core → the change ships
green + independent review + a fresh attestation (`.claude/hooks/attest-loop-core-review.mjs`), atomic
new-trigger-plus-any-deletion in one commit. Prefer the change that makes proxied dispatch the *simpler*
path, not one that adds a flag the host must remember (auditor-agnostic robustness).
