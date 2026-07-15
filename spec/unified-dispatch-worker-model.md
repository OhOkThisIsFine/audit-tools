# Unified dispatch worker model

Design of record. **Supersedes the retired `repair-proxy-dispatch-integration.md`** (deleted with the
source-pool wiring) — that spec modelled repair-proxy as a cost-ranked openai-compatible *source pool*, which the
2026-07-15 dogfood proved is the wrong abstraction (a host-driven audit planned 430 tasks and
dispatched zero). This spec replaces it.

## Principle

There is ONE shared dispatch core (audit and remediate are two draws of it —
[[dissolve-auditor-remediator-distinction]]). The core dispatches **work nodes** to **workers**.
A worker is one of three *kinds*, distinguished by how it reaches a model and whether it can use
tools. Backend diversity (running on a non-Claude model) is a property of the **worker kind and the
current auditor's environment** — never of the repo, the run, or a "provider pool" the tool
cost-ranks. Dispatch inventory is resolved **per-auditor at dispatch time**, extending
[[capability-is-per-auditor-not-per-audit]] from quota to the whole backend/model set.

## The worker taxonomy

| Kind | Reaches a model via | Tools / file access | Backend diversity via | repair-proxy |
|---|---|---|---|---|
| **Claude-harness agentic** — the host and its `claude` subagents (host fan-out); `claude -p` when headless | the Anthropic `/v1/messages` wire protocol, redirectable by `ANTHROPIC_BASE_URL` | full (Read/Edit/Bash) | pointing the harness at a proxy → backend | ✅ **its lane** |
| **CLI agentic** — codex, agy (spawned subprocess harnesses) | the CLI's own model provider (OpenAI / Gemini), its own config | full | *being a different agent* | ❌ own harness/backend |
| **Single-shot API** — NIM / opencode / vLLM direct | a direct `POST /chat/completions`, one shot | **none** (no tool loop) | *is* the backend | ❌ nothing to repair |

The kinds are not interchangeable per node: a node needing file access (all of remediate implement;
any audit review packet whose granted files exceed the inline caps) requires an **agentic** worker
(kind 1 or 2). Single-shot workers (kind 3) can only take self-contained packets that inline within
the caps — that is their permanent ceiling, not a bug to fix.

## repair-proxy's role — the category-1 launch-transport

repair-proxy is a **loopback base-URL-redirect proxy for the Anthropic `/v1/messages` wire
protocol** whose core function is **validating/repairing a model's tool calls** so a weaker backend
can drive the Claude Code harness. It also exposes an OpenAI `/chat/completions` front (passthrough
+ translate, **no repair**) and a `GET /registry`.

Its value is realized only when a **tool-using (agentic) Claude-harness worker** runs on a non-Claude
backend through it — the tool-repair keeps the backend's malformed tool calls from corrupting the
work. Therefore:

- **remediate implement is the case that justifies repair-proxy** — those workers Read/Edit/Bash/run
  tests, so a weaker backend's tool calls are exactly what repair-proxy fixes.
- **audit review host-fanout** uses the same lane (agentic claude subagents reading source + emitting
  findings); the repair value is dormant only because current audit review *can* also be done
  single-shot, where there are no tool calls.
- Same mechanism, two owner uses: (a) continue working in Claude Desktop past a usage wall by
  invisibly routing to a backend until quota resets; (b) dispatch — proxy the dispatched claude
  subagents. Both are kind-1.

### Graceful degradation — repair-proxy is OPTIONAL, never required

repair-proxy is an *enhancement* to kind-1 workers, not a dependency. It is **auto-detected per
auditor** (conversation-first — no manual flag), and its absence degrades cleanly to **direct
dispatch**:

- **No proxy on the machine** (nothing listening / not installed) → kind-1 workers run **directly on
  Claude** (the normal host fan-out). The run proceeds unchanged; it simply forgoes backend diversity
  via the proxy.
- **Incompatible host** — a host that cannot redirect its spawned workers' harness through a proxy.
  Only harnesses that honor `ANTHROPIC_BASE_URL` for the workers they spawn (Claude Desktop, the
  `claude` CLI with an isolated `CLAUDE_CONFIG_DIR`) can use the proxy transport; a host that spawns
  its subagents on Claude directly (with no control over their base URL) simply reports no
  proxy-transport capability in the handshake → **direct dispatch**.

The dispatch core NEVER assumes repair-proxy exists, NEVER requires a compatible IDE, and NEVER
fails a run for its absence. Whether the auditor can proxy its workers is one more per-auditor
handshake capability (present or absent), resolved at dispatch — exactly like every other
environment-discovered capability ([[enforce-robustness-in-tooling-not-host-discretion]]).

### What repair-proxy CANNOT serve (verified 2026-07-15)

The single-shot-openai-front *source-pool* wiring routed **kind-3** workers through repair-proxy's
OpenAI front — bypassing repair entirely (JSON emitters make no tool calls; the OpenAI front does no
repair) and failing before any POST (no key on the loopback source; audit packets over the inline
caps). It added nothing over talking to NIM directly.

repair-proxy also cannot serve **kind-2 (CLI)** workers: codex speaks OpenAI and runs on its own
config (already pointed at the headroom proxy); agy speaks Gemini and repair-proxy has no Gemini
front. They are their own harnesses with their own backends — orthogonal to repair-proxy. (Wire-
protocol boundary verified: repair-proxy serves only `/v1/messages`, `/v1/chat/completions`,
`/registry`; codex/agy are spawned as subprocesses via `spawnLoggedCommand`, never redirected.)

## Per-auditor inventory (the handshake, "A")

The auditor's dispatchable backend/model set is resolved from the **current auditor's environment,
reported per-invocation via the handshake** (the same channel `--host-models` already uses), NOT
read from the repo's `.audit-tools/audit/session-config.json`. The repo session-config carries audit
**intent** (scope / lenses / policy / synthesis / design-review depth); it does NOT carry dispatch
**inventory** (`provider` / `sources` / `repair_proxy` / per-provider backend blocks). A second
auditor joining one run from another IDE/machine has its own inventory — so nothing dispatch-related
may be baked into the shared repo state. See [[capability-is-per-auditor-not-per-audit]].

## What this retires

- The repair-proxy-as-source-pool integration: `SessionConfig.repair_proxy`, `/registry` discovery
  (`expandRepairProxySources`, `repairProxyRegistry.ts`), the Gate-0 repair-proxy cost fold
  (`gatherDispatchableSources` repair-proxy branch + capability feed), and
  `spec/repair-proxy-dispatch-integration.md`.
- The bugs **B1** (repair-proxy loopback source has no key) and **B2** (single-shot worker can't
  inline large audit packets) dissolve with that wiring — they were defects *in* the retired path,
  not problems to fix.
- Dispatch-inventory fields move off the repo session-config onto the per-invocation handshake.

## Retained / adjacent

- **C — host cold-start admission wall.** A host at 56% session remaining (percent-only claude-oauth,
  no learned tokens-per-percent slope) granted 0 packets and emitted "session limit is exhausted"
  with an empty `admission.explains[]`. This bites the **kind-1 host-fanout path regardless** of the
  repair-proxy work, so it stays on the fix list: cold start must admit ≥1 (probe), must not label
  56%-remaining "exhausted", and must never emit a 0-grant with empty `explains`.
  ([[claude-usage-endpoint-body-shape]].)
- **Direct single-shot API pools (kind 3)** remain a legitimate lane for self-contained packets, but
  their value versus a proxied `claude -p` (kind 1, which adds file access + tool-repair for the same
  backend) is an **open question** — kind 3 may be a candidate for retirement if kind-1-headless
  subsumes it. Not decided here.

## Decomposition (each loop-core commit: green-at-every-commit + attestation)

1. **Retire the repair-proxy source-pool wiring** as one atomic replace (config field + discovery +
   Gate-0 fold + capability feed + old spec), with its tests.
2. **Move dispatch inventory to the handshake** — the auditor reports `sources` / backend set
   per-invocation; `gatherDispatchableSources` reads the handshake, not the repo config; the repo
   session-config validator rejects (or ignores + warns) dispatch-inventory fields.
3. **Wire repair-proxy as a kind-1 launch-transport** — a worker-launch option that points an
   agentic claude worker's harness at a proxy endpoint (resolved per-auditor), shared by audit
   review host-fanout and remediate implement. **Must auto-detect availability and degrade to direct
   dispatch** when there is no proxy or the host cannot redirect its workers — with a test that a
   proxy-absent / incompatible-host run dispatches directly and never fails.
4. **Fix C** — cold-start admission (probe-admit ≥1, correct wall labeling, non-empty explains).
5. **(open) decide kind-3's fate** — keep direct single-shot API pools, or retire in favor of
   kind-1-headless.

## Invariants

- Backend diversity is a property of the **worker kind + the current auditor's environment**, never
  a repo-stored cost-ranked "provider pool."
- repair-proxy serves **only kind-1** (agentic claude-harness workers); its value is tool-call
  repair, so a worker that makes no tool calls (kind 3) gains nothing, and a worker on a foreign wire
  protocol (kind 2) cannot use it.
- Dispatch inventory is resolved **per-auditor per-invocation**; the repo session-config holds intent
  only.
- **repair-proxy is optional and auto-detected; its absence — no proxy on the machine, or a host that
  cannot redirect its workers' harness (not Claude Desktop / `claude` CLI) — degrades cleanly to
  direct dispatch.** Never a hard dependency, never a required flag, never a run failure. Proxy-
  transport is just one more present-or-absent per-auditor handshake capability.
