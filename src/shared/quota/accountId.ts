import { createHash } from "node:crypto";
import type { QuotaStateEntry } from "./types.js";

/**
 * The CREDENTIAL a source authenticates with, as a stable, value-free string —
 * `(normalized endpoint, credential REFERENCE)`. Two sources reaching the same
 * endpoint through the same credential reference resolve to one identity, which is
 * what makes them ONE metered account.
 *
 * ⚠ It compares REFERENCES, not values. Two sources naming the same real key by
 * different references — one `api_key_env: "NVIDIA_API_KEY"`, a sibling pasting that
 * same key inline — split into two accounts and each meters its own allowance.
 * Deliberate: keying on the VALUE would make the account identity change whenever the
 * operator rotates the credential, orphaning the ledger state and the learned slopes
 * for what is still the same account. The mixed-reference config is narrow (inline
 * `api_key` is documented as discouraged) and tracked in `docs/backlog.md`.
 *
 * ⚠ Never contains a secret. An `api_key_env` contributes its NAME; an inline
 * `api_key` contributes a truncated SHA-256 of its value, never the value — this
 * string is persisted into the reservation-ledger file and appears in artifacts.
 * Supporting the inline shape is not optional polish: it is a documented supported
 * field, and treating it as "no credential" is what left the motivating
 * `nim-nano`/`nim-super` case splitting across four rounds of repairs.
 *
 * Returns null only when the source exposes no discriminator at all — no endpoint,
 * or no credential of either shape.
 */
export function deriveCredentialIdentity(source: {
  endpoint?: string;
  api_key_env?: string;
  api_key?: string;
}): string | null {
  const normalizedEndpoint = source.endpoint?.trim().toLowerCase().replace(/\/+$/, "");
  if (!normalizedEndpoint) return null;
  if (source.api_key_env) return `${normalizedEndpoint}::env:${source.api_key_env}`;
  if (source.api_key) {
    const digest = createHash("sha256").update(source.api_key).digest("hex").slice(0, 16);
    return `${normalizedEndpoint}::inline:${digest}`;
  }
  return null;
}

/**
 * The ACCOUNT a pool meters against — the partition an `account`-scoped quota
 * window's allowance is shared across.
 *
 * Decided HERE, at the producer, from the source's own declaration. It is NOT
 * recoverable from the pool-key string: `dispatchableSourceId` returns an explicitly
 * declared `source.id` verbatim, so an operator naming two models `nim-nano` and
 * `nim-super` on one credential produces two keys with no account segment and no
 * shared substring. Parsing identity back out of that string was the defect that made
 * a fifth round of this repair necessary — the producer holds the credential, so the
 * producer decides.
 *
 * Precedence: an explicit operator `account` declaration always wins (two declared
 * accounts on one endpoint must never be silently re-merged), then the derived
 * credential identity. Returns null when neither is available, and the caller then
 * falls back to a pool-scoped key — correct, because a source we cannot attribute to
 * a credential must not be merged with anyone else's allowance.
 */
export function deriveAccountKey(source: {
  provider: string;
  endpoint?: string;
  api_key_env?: string;
  api_key?: string;
  account?: string | null;
}): string | null {
  if (source.account) return `${source.provider}#${source.account}`;
  return deriveCredentialIdentity(source);
}

/**
 * Derive a LOCAL, credential-VALUE-free account id for a bare-API-key source
 * (`openai-compatible` — NIM/vLLM/LM Studio/...), from `(endpoint,
 * api_key_env)` — the only discriminator such a source exposes with no
 * whoami/network call. Two sources declaring the SAME normalized endpoint and
 * the SAME `api_key_env` NAME (never its value — the env var's contents are
 * never read here) resolve to the SAME account id, so a learned 429/cooldown
 * observed on one folds onto every sibling sharing that credential.
 *
 * Backlog HIGH, 2026-07-11: the primary `openai-compatible/*` source and the
 * explicitly-`id`'d `nim-nano`/`nim-super`/`nim-kimi` sources all authenticate
 * with the same `NVIDIA_API_KEY` against the same endpoint, but formed
 * separately-keyed quota pools (`dispatchableSourceId` — untouched by this
 * module, still subdivides BUDGETS per source/model) — so a learned cooldown
 * on the primary never gated the siblings. See {@link foldAccountCooldown}
 * for how the derived id is used.
 *
 * Deliberately NOT an extension of `BaseHttpQuotaSource.resolveAccountId`
 * (`httpQuotaSource.ts`) — that interface is a stub for a live network
 * handshake (Claude/Codex/Copilot/Antigravity each expose a whoami-shaped
 * endpoint); a bare API key has no such endpoint, so this is a pure, local,
 * no-I/O derivation instead.
 *
 * Returns null when: the source isn't `openai-compatible`; either half of the
 * discriminator is missing; or the source already carries an explicit
 * `account` override (`DispatchableSource.account` — the operator's own
 * account declaration always wins, and two explicitly-different declared
 * accounts on the same endpoint/key must NOT be silently re-merged here).
 */
export function deriveLocalAccountId(source: {
  provider: string;
  endpoint?: string;
  api_key_env?: string;
  account?: string | null;
}): string | null {
  if (source.account) return null;
  if (source.provider !== "openai-compatible") return null;
  if (!source.api_key_env) return null;
  return deriveCredentialIdentity(source);
}

/**
 * The account key for a pool whose key is PROVIDER-SHAPED by construction —
 * `provider[#account]/model`, as built by `buildProviderModelKey`. Host pools are the
 * only such class: the caller builds the key itself, so the account segment is present
 * exactly when an account was resolved.
 *
 * ⚠ Valid ONLY for keys this codebase constructed. Never call it on a
 * {@link https | dispatchableSourceId} result: an explicitly declared `source.id` is
 * returned verbatim, so the whole opaque id parses as the "provider" and every sibling
 * on one credential gets a distinct account. Source pools derive their account from the
 * source declaration ({@link deriveAccountKey}) instead.
 *
 * An absent account segment folds every model on that provider onto one key. For host
 * pools that is right: they are the one conversation host's own credential.
 */
export function accountKeyFromProviderShapedKey(poolKey: string): string {
  const slash = poolKey.indexOf("/");
  const head = slash === -1 ? poolKey : poolKey.slice(0, slash);
  return head;
}

/**
 * Fold the ACCOUNT-scoped 429/cooldown signal from a set of sibling pools'
 * quota-state entries into `ownEntry`, taking whichever of `cooldown_until` /
 * `last_429_at` is furthest in the future across the whole group. This is the
 * mechanism that makes the invariant hold: a cooldown learned on ANY sibling
 * source of the same account gates EVERY sibling, because every sibling's
 * effective entry is re-derived through this fold.
 *
 * `tokens_per_pct` / `output_per_input` / `consecutive_429_count` (per-pool
 * BUDGET and backoff-growth bookkeeping) are always taken from `ownEntry`
 * only — the account fold gates the cooldown-gating axis alone, never the
 * per-model budget subdivision (`dispatchableSourceId` stays untouched).
 *
 * Pure; never mutates its inputs. Returns null only when `ownEntry` is null
 * and no sibling contributes a cooldown/last-429 signal either.
 */
export function foldAccountCooldown(
  ownEntry: QuotaStateEntry | null | undefined,
  siblingEntries: ReadonlyArray<QuotaStateEntry | null | undefined>,
): QuotaStateEntry | null {
  let cooldownUntil = ownEntry?.cooldown_until ?? null;
  let cooldownUntilMs = cooldownUntil ? Date.parse(cooldownUntil) : NaN;
  let lastAt = ownEntry?.last_429_at ?? null;
  let lastAtMs = lastAt ? Date.parse(lastAt) : NaN;

  for (const sibling of siblingEntries) {
    const siblingCooldown = sibling?.cooldown_until;
    if (siblingCooldown) {
      const ms = Date.parse(siblingCooldown);
      if (Number.isFinite(ms) && (!Number.isFinite(cooldownUntilMs) || ms > cooldownUntilMs)) {
        cooldownUntil = siblingCooldown;
        cooldownUntilMs = ms;
      }
    }
    const siblingLast = sibling?.last_429_at;
    if (siblingLast) {
      const ms = Date.parse(siblingLast);
      if (Number.isFinite(ms) && (!Number.isFinite(lastAtMs) || ms > lastAtMs)) {
        lastAt = siblingLast;
        lastAtMs = ms;
      }
    }
  }

  if (!ownEntry && cooldownUntil === null && lastAt === null) return null;

  return {
    updated_at: ownEntry?.updated_at ?? new Date().toISOString(),
    cooldown_until: cooldownUntil,
    last_429_at: lastAt,
    ...(ownEntry?.consecutive_429_count !== undefined
      ? { consecutive_429_count: ownEntry.consecutive_429_count }
      : {}),
    ...(ownEntry?.tokens_per_pct !== undefined ? { tokens_per_pct: ownEntry.tokens_per_pct } : {}),
    ...(ownEntry?.output_per_input !== undefined
      ? { output_per_input: ownEntry.output_per_input }
      : {}),
  };
}
