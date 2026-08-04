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
 * what lets the quota ledger and source fold import the same answer without an
 * import cycle — the previous homes could not
 * all be reached from each other, which is why the keys were rediscovered per-consumer
 * in the first place.
 */

/**
 * **"How much quota is left?"** → **service** (+account) + model.
 *
 * The key indexing `quota-state.json` entries and gating sources. Quota is billed
 * per-ACCOUNT, so two same-account-provider pairs must NOT alias to one pool (see
 * `spec/dispatch-quota.md` §5). Format: `provider[#account]/model`. The account
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
