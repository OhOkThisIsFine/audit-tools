// Slice B (KEYSTONE, backlog 2026-07-11 "Host pools calibrate FOREVER"): fold
// the host-dispatch wave's actual token spend into the host pool's learned
// tokens_per_pct slope, so it graduates out of `calibrating: true` and
// admission can size grants off real headroom instead of the cold-start batch.
//
// The worker subagent itself cannot know its own harness-measured usage —
// only the parent host sees that after each subagent dispatch completes (see
// `AuditResult.token_usage` in `../../types.js`) — so this module only SUMS
// whatever the host already stamped onto this wave's results and attributes
// it against a PRE (dispatch-time) / POST (merge-time re-probe) percent
// reading of the SAME pool. The fold itself is single-sourced in
// `foldSlopeObservationFromSnapshots` (audit-tools/shared), shared with the
// in-process rolling dispatcher's `observeSlope`, so the two engines cannot
// drift on the math.
//
// Best-effort throughout: every function here degrades to a no-op rather than
// throwing, so a malformed dispatch-quota.json, a probe failure, or an absent
// token_usage field never blocks merge-and-ingest.

import { join } from "node:path";
import { readJsonFile, foldSlopeObservationFromSnapshots, HostSessionQuotaSource } from "audit-tools/shared";
import type { QuotaUsageSnapshot } from "audit-tools/shared";
import { buildQuotaSource } from "audit-tools/shared/quota/compositeQuotaSource";
import type { AuditResult } from "../../types.js";
import type { DispatchCapacityPoolSummary, DispatchQuota } from "../../quota/index.js";

/**
 * Sum the input+output tokens reported on a wave's passing results. Ignores
 * results with no `token_usage` and defensively ignores a malformed shape
 * (non-finite/negative numbers) rather than trusting it — the validator
 * downgrades the same malformed shape to a warning (never a hard reject), so
 * this is the second, independent check that keeps a bad value out of the
 * quota-state file.
 *
 * C5 (attribution, SAFE direction): this sums only the results that were
 * actually STAMPED with `token_usage`, but the caller attributes the sum
 * against the WHOLE wave's real pct-delta (every dispatch consumed quota,
 * stamped or not). In a mixed-coverage wave (some subagents' harness usage
 * wasn't stamped) this UNDER-counts tokens relative to the true delta, which
 * biases the learned `tokens_per_pct` slope LOW (understated slope →
 * `remaining_token_budget = tokens_per_pct × remaining_pct × 100` comes out
 * too SMALL, not too big) — the safe direction for the exact over-admission
 * hazard this module exists to avoid. It is never the direction that risks
 * fleet-death-at-the-wall, so it is left uncorrected rather than adding
 * partial-coverage machinery to a best-effort advisory path.
 */
export function sumWaveTokenUsage(passing: readonly AuditResult[]): number {
  let total = 0;
  for (const result of passing) {
    const usage = result.token_usage;
    if (!usage) continue;
    const { input_tokens, output_tokens } = usage;
    if (!Number.isFinite(input_tokens) || input_tokens < 0) continue;
    if (!Number.isFinite(output_tokens) || output_tokens < 0) continue;
    total += input_tokens + output_tokens;
  }
  return total;
}

/**
 * C4 — a coarse plausibility ceiling on a wave's summed `token_usage`: no
 * single dispatch can plausibly report more tokens than its pool's context
 * window, so the SUM across `resultCount` dispatches cannot legitimately
 * exceed `context_tokens × resultCount`. This is a deliberately GENEROUS hard
 * physical bound (not a tight statistical one) — its job is only to catch
 * gross, orders-of-magnitude-wrong input, the concrete danger being a host
 * tool that stamps each result with its CUMULATIVE session-running-total
 * instead of a per-dispatch figure. Left unbounded, that mistake sails
 * straight into `recordTokensPerPctObservation`'s EWMA (alpha 0.3 — see
 * TOKENS_PER_PCT_EWMA_ALPHA) and folds 30% of the bad sample into the slope on
 * a SINGLE merge, which is exactly the over-admission hazard Slice B exists to
 * prevent. `resultCount` uses the whole wave's passing-result count (not just
 * the stamped subset) so the bound stays generous even under partial coverage
 * (see {@link sumWaveTokenUsage}'s C5 note) — a real, honestly-stamped sum
 * should never come close to it.
 */
export function isImplausibleTokenSum(
  tokens: number,
  pool: Pick<DispatchCapacityPoolSummary, "resolved_limits">,
  resultCount: number,
): boolean {
  const perDispatchCeiling = pool.resolved_limits.context_tokens;
  // A ceiling that can't be established is treated as doubtful too — bias
  // toward NOT recording rather than trusting an unbounded sum.
  if (!Number.isFinite(perDispatchCeiling) || perDispatchCeiling <= 0) return true;
  if (!Number.isFinite(resultCount) || resultCount <= 0) return true;
  return tokens > perDispatchCeiling * resultCount;
}

/**
 * Pick the pool `finalizeDispatchQuota` sized THIS wave's grant against, from
 * the `capacity_pools[]` summary array `dispatch-quota.json` persists. Audit's
 * host-dispatch path (`buildDispatchPool`/`finalizeDispatchQuota` in
 * `quotaPool.ts`) only ever populates `capacity_pools` from host pools (no
 * mixed-in backend `source` pools — those belong to the separate in-process
 * engine), so the common case is exactly one entry. When a host model roster
 * produced several ranked pools, replicate `capacity.ts`'s private
 * `choosePrimaryAllocation` tie-break (most slots, then most context, then
 * lowest pool_id) so the SAME pool selection rule applies here as it did when
 * the wave was sized — `choosePrimaryAllocation` itself is not exported (it
 * closes over the live `PoolDispatchAllocation`, not the persisted summary
 * shape), so this is a small, deliberate re-derivation over the summary
 * fields, not a second source of truth for a *different* decision.
 */
export function pickPrimaryCapacityPoolSummary(
  pools: readonly DispatchCapacityPoolSummary[] | undefined,
): DispatchCapacityPoolSummary | null {
  if (!pools || pools.length === 0) return null;
  return pools.reduce((best, candidate) => {
    if (candidate.slots !== best.slots) return candidate.slots > best.slots ? candidate : best;
    const candidateContext = candidate.resolved_limits.context_tokens;
    const bestContext = best.resolved_limits.context_tokens;
    if (candidateContext !== bestContext) return candidateContext > bestContext ? candidate : best;
    return candidate.pool_id < best.pool_id ? candidate : best;
  }, pools[0]!);
}

/** Injectable seam so tests never make a live quota-source network call. */
export type PostWaveProbe = (providerModelKey: string) => Promise<QuotaUsageSnapshot | null>;

/**
 * C1 — build the SAME hostSession-wired source configuration
 * `quotaPool.ts:150`'s `buildQuotaSource({ hostSession })` used for the
 * PRE-grant snapshot, keyed identically (the pool's own `providerModelKey`),
 * so the merge-time POST re-probe composes the cascade the same way the
 * PRE-grant snapshot did. Without this, the PRE snapshot (built WITH a
 * hostSession source) and a bare `buildQuotaSource()` POST probe (built
 * WITHOUT one) can each fall back to the same `"default"` label from two
 * different sources under pause/near-wall — a synthetic sentinel on one side,
 * a real proactive reading on the other — producing a garbage slope. The
 * hostSession instance built here is necessarily fresh (in-memory pause state
 * doesn't cross the process boundary between the dispatch step and this later
 * merge step), but that's fine: an inert hostSession still passes through to
 * the same downstream cascade the PRE snapshot would have used in the common
 * (non-paused) case, and the P1 window-identity guard in
 * `foldSlopeObservationFromSnapshots` is the backstop for any residual
 * mismatch.
 */
function buildPostWaveQuotaSource(providerModelKey: string) {
  const hostSession = new HostSessionQuotaSource({ providerModelKey });
  return buildQuotaSource({ hostSession });
}

const defaultProbe: PostWaveProbe = (providerModelKey) =>
  buildPostWaveQuotaSource(providerModelKey).queryCurrentUsage(providerModelKey).catch(() => null);

/** C6 — a merge must never hang on a slow/hung `/usage` fetch; degrade to no-op instead. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** Outcome of one `recordHostTokenUsageObservation` call, for logging/testing. */
export interface HostTokenUsageObservationOutcome {
  /** True when at least one window's slope sample was folded. */
  recorded: boolean;
  /** Reason nothing was recorded, when `recorded` is false. */
  reason:
    | "recorded"
    | "no_token_usage"
    | "no_dispatch_quota"
    | "no_pool"
    | "no_pre_snapshot"
    | "no_post_snapshot"
    // C4: the wave's summed token_usage grossly exceeded the plausibility
    // ceiling (see isImplausibleTokenSum) — rejected without folding.
    | "implausible_token_sum"
    // C3: a post snapshot WAS obtained, but no window crossed the fold's
    // guards (MIN_SLOPE_DELTA_PERCENT / window-identity / zero-negative
    // delta) — distinct from "no_post_snapshot" so operators don't chase a
    // phantom probe failure.
    | "no_slope_delta"
    // C6: the post-wave re-probe did not settle within the bounded timeout.
    | "probe_timeout";
  poolId?: string;
  tokens?: number;
}

/** C6 — race a promise against a bounded timer; the timer never blocks process exit. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Read this run's `dispatch-quota.json` (already-persisted PRE-grant snapshot
 * from `finalizeDispatchQuota`), sum the wave's host-reported `token_usage`,
 * re-probe the SAME pool's live quota snapshot as the POST reading, and fold
 * the pair through the single-sourced `foldSlopeObservationFromSnapshots` so
 * the pool's `tokens_per_pct` slope learns from REAL host-subagent usage
 * instead of staying `calibrating: true` forever.
 *
 * Never throws: a missing/unreadable dispatch-quota.json (e.g. an in-process-
 * only run with no host grant this round), an absent pool, a zero token sum,
 * an implausible token sum (C4), a probe failure, or a probe timeout (C6) all
 * degrade to a no-op outcome rather than aborting the caller — this is
 * advisory quota-state enrichment, not a merge invariant.
 */
export async function recordHostTokenUsageObservation(params: {
  runDir: string;
  passing: readonly AuditResult[];
  probe?: PostWaveProbe;
  /** Test seam: override the C6 probe timeout (default {@link DEFAULT_PROBE_TIMEOUT_MS}). */
  probeTimeoutMs?: number;
}): Promise<HostTokenUsageObservationOutcome> {
  const tokens = sumWaveTokenUsage(params.passing);
  if (tokens <= 0) return { recorded: false, reason: "no_token_usage" };

  let dispatchQuota: DispatchQuota;
  try {
    dispatchQuota = await readJsonFile<DispatchQuota>(join(params.runDir, "dispatch-quota.json"));
  } catch {
    return { recorded: false, reason: "no_dispatch_quota" };
  }

  const pool = pickPrimaryCapacityPoolSummary(dispatchQuota.capacity_pools);
  if (!pool) return { recorded: false, reason: "no_pool" };

  // C4: reject an implausible sum BEFORE spending a network probe on it — a
  // host tool that stamped cumulative session totals instead of per-dispatch
  // usage must never reach the fold, no matter what the live snapshot shows.
  if (isImplausibleTokenSum(tokens, pool, params.passing.length)) {
    return { recorded: false, reason: "implausible_token_sum", poolId: pool.pool_id, tokens };
  }

  const preSnapshot = pool.quota_source_snapshot ?? null;
  if (!preSnapshot) return { recorded: false, reason: "no_pre_snapshot", poolId: pool.pool_id, tokens };

  const probe = params.probe ?? defaultProbe;
  let postSnapshot: QuotaUsageSnapshot | null;
  try {
    postSnapshot = await withTimeout(
      probe(pool.pool_id),
      params.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
  } catch {
    // C6: a hang or a rejection past the bound degrades to no-op — never
    // stalls merge-and-ingest on a slow/hung /usage fetch.
    return { recorded: false, reason: "probe_timeout", poolId: pool.pool_id, tokens };
  }
  if (!postSnapshot) {
    return { recorded: false, reason: "no_post_snapshot", poolId: pool.pool_id, tokens };
  }

  const folded = await foldSlopeObservationFromSnapshots(pool.pool_id, preSnapshot, postSnapshot, tokens);
  // C3: a post snapshot WAS obtained here (the null case already returned
  // above), so an empty fold means a guard (delta floor / window-identity)
  // rejected every window — distinct from "no_post_snapshot".
  return folded.length > 0
    ? { recorded: true, reason: "recorded", poolId: pool.pool_id, tokens }
    : { recorded: false, reason: "no_slope_delta", poolId: pool.pool_id, tokens };
}
