# Commit 3 — repair-proxy as the kind-1 launch transport (dated plan v2, 2026-07-16)

> Dated planning record. Goal from `spec/unified-dispatch-worker-model.md` §"repair-proxy — the
> kind-1 launch transport". Owner direction: per-worker backend routing (one conversation, mixed
> providers, each worker individually routed); ideal architecture over expediency/back-compat.
> **v2 after independent adversarial review** — v1 died on two integration KILLS (F2: the
> in-session refusal is four layers, v1 refined one; F3: no `DispatchableSource.provider` value
> could produce a kind-1 launch). v2's core cut dissolves both rather than editing around them.

## Verified ground truth (probed live this session — re-verify only if HEAD moved)

1. **`claude` CLI honors `ANTHROPIC_BASE_URL` and passes an arbitrary model string VERBATIM**
   to `POST /v1/messages` (`--model "nim/z-ai/glm-5.2"` observed at a fake loopback endpoint,
   response round-tripped). The proxy's namespace routing key works per-request.
2. **A nested `claude -p` spawn from inside a live Claude Code session works** when the child
   env drops `CLAUDECODE`/`CLAUDE_CODE*` and sets an isolated `CLAUDE_CONFIG_DIR`
   (`CLAUDE_CONFIG_DIR` survives `stripClaudeCodeEnv` — prefix is `CLAUDE_CONF`).
3. **Spawn layer already carries env overlays:** `spawnLoggedCommand(command, args, input, env?)`
   merges `{...process.env, ...env}` then scrubs (spawnLoggedCommand.ts:315). `ClaudeCodeProvider`
   never passes the 4th arg today.
4. **repair-proxy**: loopback `/v1/messages` tool-call repair + namespace routing (first-`/`
   split; tier/default passthrough coexists), `GET /registry` = providers × live models ×
   has_key/reachable/scores. Listen address is operator config (currently 127.0.0.1:8791).
5. **The in-session claude-code refusal is FOUR independent layers** (adversarial review, each
   verified): provider throw (`claudeCodeProvider.ts:95`), `isSelfSpawnBlocked`
   (`providerPathGuard.ts:72-105`), factory `claudeAvailable: !insideClaudeCode`
   (`providerFactory.ts:138`), Gate-0/dispatch exclusion (`sharedProviderConfirmation.ts:277`,
   `resolveDispatchExclusion`). Multiple tests pin each. **Do not edit these** — see the cut.
6. **`DISPATCHABLE_SOURCE_PROVIDERS` is a closed union excluding `claude-code` by documented
   design** (sessionConfig.ts:269-284); the launch bridge switches on `source.provider`
   (`apiPool.ts:77-113` → `providerNodeDispatch.ts:102-108`).
7. Host Agent-tool carrier (Desktop subagent frontmatter model pass-through) UNVERIFIED —
   needs a proxy-fronted session restart. Additive later commit, not blocking.

## Owner decisions (settled)

- Detection: declared `repair_proxy` entry in `~/.audit-code/sources-declared.json` + live
  reach probe. No per-run flag; fail-open (lane dropped with reason).
- Routing: per-WORKER backend selection by the dispatch brain; mixed providers per conversation.
- Scope: CLI-spawn transport + `self.proxy_transport` handshake bit; no prompt-prose routing.

## The cut — a NEW worker class, not an exception to the host class

**`claude-worker` becomes a first-class member of `DISPATCHABLE_SOURCE_PROVIDERS`** — the
proxied, isolated, per-packet-routed Claude-harness worker. It is NOT `claude-code` (the
conversation host / IDE driver) wearing a flag:

- **All four refusal layers key on `claude-code` and never see `claude-worker`** — self-spawn
  blocking, factory availability, Gate-0 self-exclusion all remain byte-identical. No guard is
  refined, no pinned test changes meaning. (Dissolves v1-KILL F2 + review F8: the `claude-code`
  provider's blanket nested guard STAYS; isolation is `claude-worker`'s constructor invariant,
  not a guard exception.)
- **The launch bridge gets an explicit branch** (`sourceProviderConfig` switch + factory):
  `claude-worker` → `ClaudeWorkerProvider` — spawns `claude -p` with REQUIRED
  `{ANTHROPIC_BASE_URL: source.endpoint}` env overlay, scrubbed parent env, isolated
  per-run `CLAUDE_CONFIG_DIR`, and `--model <backend_provider>/<model>` argv. Missing
  endpoint/base-url ⇒ construction fails loudly. (Dissolves v1-KILL F3.)
- **Worker-kind axis becomes explicit contract**: `DispatchableSource.worker_kind:
  "agentic" | "single_shot"` (derived by provider — claude-worker/codex/agy/opencode agentic;
  openai-compatible single_shot; declarable override only where genuinely ambiguous). This is
  the spec's tools-vs-chat router built minimally (review F4): launch-side enforcement now
  (packet-content inlining vs file-access contracts keyed on kind), admission `capable()`
  consumption later.

## Identity & quota keying (review F7)

The transport NEVER enters the identity. Expanded source fields:
`{provider: "claude-worker", endpoint: <proxy url>, backend_provider: "nim",
model: "z-ai/glm-5.2", account: <backend account>}`.
- Ledger key stays `backend_provider[#account]/model` → a direct-NIM lane and the proxied lane
  dedup to ONE quota identity (the `(provider, account)` double-grant boundary holds).
- The namespace string `nim/z-ai/glm-5.2` is COMPOSED AT LAUNCH for argv only.
- Cost: operator-declared cost-class/`cost_per_mtok` on the machine declaration wins (the
  free-to-operator axis, backlog friction item); registry list price is fallback only.

## POPULATE vs RESOLVE (review F6)

- **Populate** (network, expensive, cacheable): fetch `GET /registry`, expand top-K per
  backend provider into `claude-worker` sources, write `~/.audit-code/catalog-<auditor-id>.json`
  (the name `auditorSources.ts:11-14` reserves) with fetched-at timestamp. Runs at Gate-0
  build (once per run, already network-tolerant) and on explicit refresh — NEVER inside
  `resolveAmbientSources`.
- **Resolve** (cheap, per-invocation, sync): declared ∩ ambient stays as-is; the repair-proxy
  lane's reach = cheap liveness probe (injectable dep alongside `commandExists`); expansion
  reads the populate cache. Stale/absent cache ⇒ lane present but unexpanded (degrade, reason
  recorded), never a mid-resolve fetch.

## Gate-0 & the reconciliation gate (review F9/F10)

- Expanded sources fold via `annotateConfirmedPool` on the SHARED Gate-0 path (the per-tool
  seam calls it without sources — that stays; name the asymmetry in tests).
- Top-K cap (declared, default small — e.g. 3/provider) bounds the reconciliation-gate delta
  and the Gate-0 table. The gate treats each expanded model as a backend delta — capped K makes
  attended prompts sane and autonomous fail-closed bounded.
- Known-defective keyspace (backlog: `source::<id>` match vs bare-id display silently drops
  operator `cost_order`) — FIX IN THIS COMMIT for the expanded rows' sake (it is two lines of
  keyspace alignment, and 116-row scale makes the defect acute).

## Descriptor

`self.proxy_transport?: boolean` on `AuditorSelf` (args.ts parse + hostDescriptor re-emit):
"this host's own subagents are proxy-fronted." Consumed by nothing this commit (future
Agent-tool carrier reads it). Environment-vs-self split respected (review F11 upheld v1 here).

## Risks / residuals (carried, named)

- **Lies-reachably quarantine (G5 clause c) is still unbuilt** — a weak backend whose tool
  calls the proxy fails to repair produces corrupted agentic work with no quarantine. For
  remediate implement that is corrupted EDITS. Mitigation this commit: `claude-worker` pools
  rank strictly below the host tier by default (operator promotes deliberately); quarantine
  remains the G5 item. (Review F5.)
- Trust-dialog + credential bootstrap for isolated config dirs: child presents a dummy
  `ANTHROPIC_API_KEY` (the loopback proxy needs none) — set explicitly in the overlay so an
  ambient real key is never silently used for a proxied spawn; trust pre-seeded mechanically
  in the isolated dir (`hasTrustDialogAccepted`). An in-session isolated spawn with NO proxy
  endpoint remains impossible (endpoint is a constructor invariant). (Review F8/F10.)
- Registry expansion volume: top-K cap; zero-match/empty registry ⇒ unexpanded lane + reason.
- `INV-shared-core-14` env-sensitivity may interact with providerFactory changes — baseline
  the suite before/after 3b.

## Bounded sequencing (each green at commit; atomic-replace within each)

1. **3a — contract + populate/resolve split**: `claude-worker` in the union + `worker_kind` +
   `backend_provider` field + `repair_proxy` declaration shape + validators; populate cache
   writer/reader; ambient liveness probe. Tests: shape/validators, populate/resolve seam,
   reach degrade.
2. **3b — `ClaudeWorkerProvider`**: isolated spawn transport (env overlay REQUIRED, config-dir
   lifecycle, argv model composition), factory + launch-bridge branch. Tests: unit + a live
   nested smoke against a fake endpoint (the probe from ground-truth 1 turned into a fixture).
3. **3c — Gate-0 fold + admission + descriptor bit + keyspace fix** (loop-core: independent
   review + attestation). Tests: fold/cost-class ordering, ledger-key dedup vs a direct lane,
   reconciliation-gate delta capping, cost_order keyspace red-green.

## Non-goals (this commit)

- Host Agent-tool routing (prompt-carried model strings) — restart test first; reads
  `self.proxy_transport` when built.
- Proxy autostart/lifecycle; any repo-persisted proxy config; admission-side kind routing
  (axis lands as contract + launch enforcement; scheduler consumption is follow-on).
