import { z } from "zod";

export const QuotaUsageSnapshotSchema = z
  .object({
    remaining_pct: z.number().nullable(),
    reset_at: z.string().nullable(),
    requests_remaining: z.number().int().nullable(),
    tokens_remaining: z.number().int().nullable(),
    captured_at: z.string(),
    source: z.string(),
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
