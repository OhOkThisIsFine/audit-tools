/**
 * **The identity module.** Every axis-derived key in dispatch is produced by a named
 * function HERE, each documented with the question it answers.
 *
 * The invariant is `spec/backend-identity-axes.md`'s:
 *
 * > **Co-locate and name; do not unify.**
 *
 * These are near-identical strings answering DIFFERENT questions, and that adjacency
 * is the whole point: a reader reaching for one is shown the others, so a consumer
 * PICKS an axis from the spec's table instead of inventing an identity. Collapsing
 * them into "one identity function" was tried and produces either a gate that
 * approves backends the operator never saw, or an exclusion rule that matches
 * nothing — both shipped, both as silent fail-opens.
 *
 * This module is a LEAF on purpose: pure string derivation, no value imports. That is
 * what lets the quota ledger, the Gate-0 confirmation, the source fold, and the
 * routing filter all import the same answers without an import cycle — the previous
 * homes (`quota/scheduler.ts`, `providers/sharedProviderConfirmation.ts`) could not
 * all be reached from each other, which is why the keys were rediscovered per-consumer
 * in the first place.
 */

import type { DispatchExclusionPattern } from "./sharedProviderConfirmation.js";

/**
 * **"Is this the backend the operator already saw?"** → **service** + model.
 *
 * `service:model` where the model is knowable, else the coarse service name — where
 * "service" is the BACKEND ACTUALLY SERVING the model (`service ?? transport`), never
 * the transport that reaches it. Approval is about whose model you consume, not the
 * road taken: two transports onto one service+model are ONE backend the operator
 * confirms once.
 *
 * **Service-qualification is load-bearing, not cosmetic.** The earlier `model_id ??
 * provider` form dropped the provider whenever a model was known, and that was a gate
 * BYPASS in two directions: two backends from different services advertising the SAME
 * model string collapsed into one delta entry (only one got an exclusion pattern),
 * and — worse — confirming one service's model marked a different service's
 * identically-named model as confirmed, so a backend the operator never saw routed as
 * approved. Proxy expansion makes that collision ordinary, not exotic.
 *
 * **The coarse fallback is equally load-bearing** — do not "simplify" it away. A model
 * is knowable here only for `openai-compatible` and `codex`; for claude-code / agy /
 * opencode / worker-command the model arrives only at the dispatch handshake. A
 * model-ONLY identity would let such a backend contribute no key at all, so installing
 * `agy` on PATH would leave the Gate-0 delta empty and the gate would dispatch it
 * silently — reopening the exact PATH-appearance case the gate exists to catch, blind
 * rather than loud.
 *
 * ⚠ NOT interchangeable with {@link transportRoute}. Building an exclusion rule from
 * this identity matches nothing for a proxied lane — `ruleMatches` compares the
 * TRANSPORT. They were unified once; that was the bypass.
 *
 * ⚠ Nor is it the dispatch COST-POSITION map (`readConfirmedCostPositions`), a third
 * keyspace keyed by BARE `model_id` because `costRank` looks positions up with no
 * service in hand at the lookup site. Do not unify with either.
 */
export function backendIdentity(
  modelId: string | undefined,
  serviceName: string,
): string {
  return modelId ? `${serviceName}:${modelId}` : serviceName;
}

/** The service a source is served BY — its declared backend, else its own transport. */
export function sourceService(source: {
  transport: string;
  service?: string;
}): string {
  return source.service ?? source.transport;
}

/**
 * **"How much quota is left?"** → **service** (+account) + model.
 *
 * The key indexing `quota-state.json` entries and gating sources. Quota is billed
 * per-ACCOUNT, so two same-account-provider pairs must NOT alias to one pool (see
 * `docs/quota-dispatch-design.md` §5). Format: `provider[#account]/model`. The account
 * segment is OMITTED when null, so a single-account run keeps the legacy
 * `provider/model` key (no migration). The `model` tail may itself contain `/`;
 * provider + account live in the head before the first `/`.
 *
 * ⚠ **These values are PERSISTED.** Changing the derivation orphans every learned
 * `quota-state.json` key, which degrades silently to blind defaults rather than
 * failing. Enumerate what is on DISK before touching this.
 *
 * **Which axis reaches the first parameter is the CALLER's choice, and the callers
 * deliberately differ** — read them before assuming:
 *   • `dispatchableSourceId` (the persisted ledger key) passes **service**, which is
 *     the spec's binding: a proxied lane and a direct lane onto one backend dedup to
 *     ONE ledger entry. Its transport-passing fallback is unreachable post-chokepoint.
 *   • Host pools pass the resolved **host provider name** — the host is its own
 *     account boundary, not a source with a declared service.
 *   • `buildSourcePool` passes **transport** for the throwaway key it hands
 *     `resolveAccountIdSafe`. That value only resolves an account id; the pool's real
 *     key is `dispatchableSourceId`. Not a ledger key, so not a divergence.
 */
export function quotaPoolKey(
  providerName: string,
  hostModel: string | null | undefined,
  account?: string | null,
): string {
  const head = account ? `${providerName}#${account}` : providerName;
  return hostModel ? `${head}/${hostModel}` : `${head}/*`;
}

/**
 * **"What must the routing filter match to drop this?"** → **transport** + model.
 *
 * The pattern that rules out one backend at the finest granularity its model is
 * knowable at — keyed on the TRANSPORT provider, because that is the field
 * `ruleMatches` compares (`ExcludableBackend.transport`). A backend whose model
 * arrives only at the dispatch handshake (a CLI) must be ruled out at the coarse
 * `provider` tier or the rule would never match.
 *
 * ⚠ NOT the same value as {@link backendIdentity} — see that function's note.
 */
export function transportRoute(
  modelId: string | undefined,
  transportProvider: string,
): DispatchExclusionPattern {
  return modelId ? `${transportProvider}:${modelId}` : transportProvider;
}
