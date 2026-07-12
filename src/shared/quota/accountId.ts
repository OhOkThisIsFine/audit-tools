import type { QuotaStateEntry } from "./types.js";

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
  if (!source.endpoint || !source.api_key_env) return null;
  const normalizedEndpoint = source.endpoint.trim().toLowerCase().replace(/\/+$/, "");
  if (!normalizedEndpoint) return null;
  return `${normalizedEndpoint}::${source.api_key_env}`;
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
