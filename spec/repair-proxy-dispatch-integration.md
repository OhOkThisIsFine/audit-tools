# repair-proxy ↔ audit-tools dispatch integration (JIT model)

Design of record. audit-tools' dispatcher is the **brain** (owns quota / rate / token +
selection); repair-proxy is the **arm** (given a `provider/model`, translate + validate/repair
+ reach the backend). This integration lets audit-tools dispatch background packets across
many HTTP providers behind one repair-proxy endpoint, selecting `provider/model` **just-in-time**
from live capability + quota + cost — realizing the [[relax-dispatch-source-forcing]] forward-track.

## Decisions (approved)

- **JIT per-packet model**, not N pre-bound pools. One pool per *backend provider* (nim /
  openrouter / groq / mistral); the model is chosen per packet at dispatch. Threaded through
  `LaunchFreshSessionInput.model`. This is the [[relax-dispatch-source-forcing]] shape.
- **Cost-aware top-K candidate set**: from repair-proxy `/registry`, take the top-K models per
  reachable provider by capability (BFCL/Arena raw scores), **factoring cost** — free models
  (declared/registry price 0) rank ahead; paid models are admitted only when capability justifies
  the price per the cost↔speed λ dial. Never the full 800-model catalog.
- **repair-proxy grows an OpenAI-compatible front** so audit-tools' existing
  `OpenAiCompatibleProvider` transport (HTTP + edit-apply + cost-capture) is reused verbatim.
- Per-backend-provider quota accounting via pool `account` = backend provider (cooldown/429 fold
  per provider, not per proxy URL). Pool key stays `(provider, model, account)`.

## What repair-proxy contributes to *this* path

The background pool does single-shot structured output (`{files,result}` via guided JSON), not an
agentic tool-call loop — so repair-proxy here is **multiplexer + `/registry` discovery + capability
source**, and tool-call *repair* is a passthrough no-op (repair's value is on the Claude-*harness*
Anthropic-front path). The OpenAI front therefore = namespace-routing reverse proxy + optional
repair; it must not mistranslate a non-tool structured response.

## Slices (each green + shippable; loop-core slices need the review attestation)

**A — repair-proxy OpenAI front** (repair-proxy repo, NOT loop-core).
`POST /v1/chat/completions` + `/chat/completions`: accept OpenAI Chat Completions, route by the
request `model`'s `provider/…` namespace (strip prefix → backend model), call the backend, return
OpenAI Chat Completions. Reuses `resolveTarget`. Non-tool responses pass through untouched.

**B — audit-tools config + registry discovery → per-provider pools** (loop-core).
- `SessionConfig.repair_proxy?: { base_url; api_key_env?; top_k?; ... }` + validator
  (`src/shared/types/sessionConfig.ts`, `src/shared/validation/sessionConfig.ts`).
- `src/shared/quota/repairProxyRegistry.ts`: `GET {base_url}/registry` → for each reachable
  provider emit ONE `DispatchableSource` (`provider:"openai-compatible"`, `endpoint` = proxy,
  `account` = backend provider, `quota`/`cost_per_mtok` from registry). Cost-aware top-K model
  candidates attached as dispatch metadata (not one source per model — JIT picks the model).
- Fold into `collectDispatchableSources` (`src/shared/quota/apiPool.ts` ~L422) — the single
  source-gather point both orchestrators inherit. Advances [[nim-not-auto-detected]].

**C — per-packet model thread (the JIT seam)** (loop-core).
- `LaunchFreshSessionInput.model?: string` (`src/shared/providers/types.ts`).
- `OpenAiCompatibleProvider.launch` prefers `input.model ?? this.config.model`
  (`src/shared/providers/openAiCompatibleProvider.ts` ~L114/L183).
- Dispatch sites pass the slot-selected `provider/model`:
  `src/remediate/steps/providerNodeDispatch.ts` ~L98-117,
  `src/audit/cli/rollingAuditDispatch.ts` ~L275-278.

**D — capability→cost-rank (per-model) + quota-aware Gate-0** (loop-core).
- `src/shared/dispatch/costRank.ts`: a per-`(provider,model)` `capabilityRank` from registry scores
  (fixes [[per-model-tiering]]); live registry price → `declaredCostPerMtok` rung-2, superseding the
  models.dev fallback where present.
- `src/shared/providers/providerConfirmation.ts` / `suggestCostOrdering`: fuse each candidate with
  audit-tools' live `quotaSourceSnapshot` so saturated backends demote (fixes
  [[quota-before-cost-ordering]]).

## Invariants to hold

- Endpoint/host/model/key all operator-supplied — no hardcoded `127.0.0.1:8791` in core logic.
- `/registry` fetch degrades to empty (no sources) on failure — never throws into source-gather.
- Capability scores stay RAW end-to-end; tiering is a *derived rank*, never a stored high/med/low.
- Quota is always-on; a registry-discovered pool with no quota signal = uncapped-but-loud, per
  [[quota-onetrack-always-on]].
