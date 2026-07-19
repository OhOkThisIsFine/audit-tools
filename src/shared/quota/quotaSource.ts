import { z } from "zod";

/**
 * One quota WINDOW's remaining budget. A provider may expose several windows
 * that scale on DIFFERENT denominators (e.g. Claude's 5-hour `session` vs 7-day
 * `weekly`; Codex's primary vs secondary). The same N tokens is a large percent
 * of a small window and a tiny percent of a big one, so tokens→percent slope is
 * learned per (pool, {@link windowSlopeKey}) and each window meters against its own
 * allowance. `label` is an AGNOSTIC string ("session","weekly",…) — never a
 * provider/model identity — so any source can add its own windows.
 */
/**
 * Whether a window's allowance is shared by every model on the credential, or
 * belongs to one model alone. This is the METERING PARTITION and it is decided
 * HERE, by the producer that knows — never re-derived downstream from pool
 * identity, which is what four refused repair attempts each tried and got wrong.
 *
 *  - `account` — one allowance shared across all of the credential's models
 *    (Claude's `five_hour`/`seven_day`, an unscoped `limits[]` entry). Meters on
 *    `(accountKey, label)`: N models on one credential draw down ONE budget.
 *  - `model` — applies to this model alone (a `limits[]` entry carrying
 *    `scope.model`). Meters on `(poolId, label)`: sharing it would falsely
 *    throttle siblings that the limit does not cover.
 *
 * REQUIRED, with no default, on every window from every source. A source that
 * cannot distinguish the two emits `account` for all of its windows — that IS
 * the fallback ("provider exposes only account-wide quota ⇒ it applies to all
 * their models"), stated rather than assumed. The absence of a default is
 * deliberate: a default is how the next provider gets silently special-cased.
 *
 * Orthogonal to the learned slope. `tokens_per_pct` stays per (pool, window)
 * unconditionally — even under an account-scoped window, where N models share
 * one percent allowance but each converts it to tokens at its OWN rate. Scope
 * partitions the ALLOWANCE; the slope prices it per model.
 */
export const QuotaWindowScopeSchema = z.enum(["account", "model"]);
export type QuotaWindowScope = z.infer<typeof QuotaWindowScopeSchema>;

/**
 * A `tokens_per_pct` map key, as produced by {@link windowSlopeKey}. Branded so the
 * slope map cannot be read or written with a bare window label: the two key spaces
 * are both strings, and an unbranded parameter left the guarantee to whoever
 * remembered it — which a test promptly got wrong, writing under `"weekly"` where
 * production only ever reads `"account:weekly"`.
 */
export type WindowSlopeKey = string & { readonly __windowSlopeKey: unique symbol };

/**
 * The key a window's learned tokens-per-percent slope is stored under, within a
 * pool's quota-state entry. **The single resolution point for slope lookup** — the
 * only way to obtain a {@link WindowSlopeKey}, and every read and write of
 * `tokens_per_pct` requires one, so the map cannot be keyed one way by the producer
 * and another by the consumer.
 *
 * Keyed by `(scope, label)`, not label alone: an account-scoped and a model-scoped
 * window can share a group name (both `session`) while pricing different allowances,
 * and collapsing them onto one entry would silently blend two exchange rates into a
 * single wrong one.
 *
 * ⚠ Changing this key ORPHANS previously-learned slopes (they were stored under the
 * bare label). That is deliberate and self-healing: an orphaned window reads as
 * uncalibrated, which routes the pool through the cold-start probe path and re-learns
 * within a few dispatches. A migration shim would instead carry a slope forward onto a
 * partition it was never measured against.
 *
 * This is also the seam for the deferred sibling-derived slope prior (design of
 * record, "Deferred seam"): a prior can be injected at this one lookup point without
 * touching admission.
 */
export function windowSlopeKey(scope: QuotaWindowScope, label: string): WindowSlopeKey {
  return `${scope}:${label}` as WindowSlopeKey;
}

export const QuotaWindowSchema = z
  .object({
    label: z.string(),
    scope: QuotaWindowScopeSchema,
    remaining_pct: z.number().nullable(),
    reset_at: z.string().nullable(),
    tokens_remaining: z.number().int().nullable().optional(),
  })
  .strict();
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/** Whether a window carries a usable metering scope. */
export function hasWindowScope(window: { scope?: unknown }): boolean {
  return window.scope === "account" || window.scope === "model";
}

export const QuotaUsageSnapshotSchema = z
  .object({
    remaining_pct: z.number().nullable(),
    reset_at: z.string().nullable(),
    requests_remaining: z.number().int().nullable(),
    tokens_remaining: z.number().int().nullable(),
    captured_at: z.string(),
    source: z.string(),
    /**
     * Per-window breakdown when the provider exposes multiple quota windows that
     * scale differently. Top-level `remaining_pct`/`reset_at` remain the MIN
     * (binding) window for consumers that want one number. Absent for
     * single-window providers.
     */
    windows: z.array(QuotaWindowSchema).optional(),
  })
  .strict();
export type QuotaUsageSnapshot = z.infer<typeof QuotaUsageSnapshotSchema>;

/**
 * Outcome of probing a quota source for one provider/model key, disambiguating
 * the two cases a bare `null` snapshot conflates:
 *
 *  - `ok`         — a live snapshot was mapped (`snapshot` is non-null).
 *  - `degraded`   — the source HANDLES this provider and was actually queried,
 *                   but produced no snapshot (missing/expired creds, 401/5xx,
 *                   network error, or an unmappable payload). The signal that was
 *                   *expected* was silently lost — the operator-visible failure
 *                   mode that `queryCurrentUsage`'s `null` hides.
 *  - `not_applicable` — the source does not answer for this provider (gated out
 *                   with no I/O), or the live probe was intentionally skipped
 *                   (hermeticity guard / proactive-quota disabled). No signal was
 *                   ever expected, so its absence is not a degrade.
 *
 * This is the contract behind the `CapacityPool.quotaSignalDegraded` marker: a
 * pool whose probe is `degraded` is dispatching blind where it expected a live
 * quota reading, and that fact is attached to the pool rather than swallowed.
 */
export type QuotaProbeStatus = "ok" | "degraded" | "not_applicable";

export interface QuotaProbeResult {
  snapshot: QuotaUsageSnapshot | null;
  status: QuotaProbeStatus;
}

export interface QuotaSource {
  readonly name: string;
  queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null>;
  /**
   * Like {@link queryCurrentUsage}, but reports WHY the snapshot is null: a
   * source that was queried and silently degraded (`degraded`) vs. one that
   * never applied (`not_applicable`). Optional on the interface so plain
   * `{ name, queryCurrentUsage }` stubs remain valid; {@link probeQuotaSource}
   * derives a best-effort result for sources that don't implement it.
   */
  probeUsage?(providerModelKey: string): Promise<QuotaProbeResult>;
  /**
   * Resolve the ACCOUNT identity this source reads for a provider, from its
   * credential — never guessed (see docs/quota-dispatch-design.md §5). Used to
   * stamp the account segment into the pool key so two same-provider accounts
   * form distinct pools. Returns null when the source doesn't handle the provider,
   * the credential is absent/unreadable, or the provider carries no account id.
   * Local-only (no network). Optional so plain stubs stay valid.
   */
  resolveAccountId?(providerModelKey: string): Promise<string | null>;
  /**
   * Pure capability check: does this source provide PROACTIVE quota tracking for
   * `provider`? No credentials, no network — answers "is this provider supported in
   * code", which is what separates an unsupported environment (`unestablished`) from
   * a supported-but-degraded one. Reactive-only sources (learned, host-session) omit
   * it. See {@link classifyQuotaCoverage}.
   */
  coversProvider?(provider: string): boolean;
}

/**
 * Resolve a provider's account id via a source's {@link QuotaSource.resolveAccountId}
 * when it has one, else null. Never throws — account resolution failure degrades to
 * an unkeyed (account-null) pool rather than aborting pool construction.
 */
export async function resolveAccountIdSafe(
  source: QuotaSource,
  providerModelKey: string,
): Promise<string | null> {
  if (!source.resolveAccountId) return null;
  try {
    return await source.resolveAccountId(providerModelKey);
  } catch {
    return null;
  }
}

/**
 * Probe a quota source, using its native {@link QuotaSource.probeUsage} when it
 * has one and otherwise deriving a conservative result from
 * {@link QuotaSource.queryCurrentUsage}: a snapshot is `ok`, a thrown error is
 * `degraded` (it was attempted and failed), and a plain `null` is reported as
 * `not_applicable` (a source without `probeUsage` cannot distinguish a silent
 * degrade from a non-match, so it must not over-report a degrade).
 */
export async function probeQuotaSource(
  source: QuotaSource,
  providerModelKey: string,
): Promise<QuotaProbeResult> {
  if (source.probeUsage) return source.probeUsage(providerModelKey);
  try {
    const snapshot = await source.queryCurrentUsage(providerModelKey);
    return { snapshot, status: snapshot ? "ok" : "not_applicable" };
  } catch {
    return { snapshot: null, status: "degraded" };
  }
}
