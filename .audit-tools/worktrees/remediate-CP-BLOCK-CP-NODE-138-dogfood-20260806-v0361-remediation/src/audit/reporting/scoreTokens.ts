/**
 * score-tokens — the COST counterpart to the A-2 quality oracle (`score-audit`).
 *
 * `scoreTokens` is a PURE function of a run's recorded token-usage ledger
 * (`token-usage.jsonl`, appended post-hoc at packet-completion time by
 * `appendTokenUsageLine` — see `src/audit/io/tokenUsageLedger.ts`). It reports
 * real per-step input/output tokens and prefix cache-hit ratio, exactly what the
 * provider reported on a COMPLETED response — never a metered/token-counting API
 * call and never `estimateTokensFromBytes` (that estimator is for PLANNING only).
 *
 * No-silent-scoring (mirrors score-audit's `unmatched[]` discipline): a step
 * whose usage is entirely unreported (the agentic-CLI providers — claude-code /
 * codex / opencode — spawn an external process with no structured usage) is
 * counted in `totals.unmeasured_steps` and excluded from the token/cache-hit
 * aggregates — NEVER folded in as a silent 0.
 *
 * Pure module: no IO, no clock (the ledger's wall-clock timestamp is read but
 * never used to influence the verdict), no model identity — the same (entries,
 * prefixHashes) always yields a byte-identical scorecard, order-independent.
 */

import { createHash } from "node:crypto";

/** One packet's recorded usage, read from a `token-usage.jsonl` line. */
export interface TokenUsageEntry {
  packet_id: string;
  pool_id?: string | null;
  lens?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
}

/** Per-packet prefix-cache-eligibility verdict (structural, provider-independent). */
export interface PrefixStability {
  /** True iff every packet in the corpus hashed to the SAME fixed-prefix. */
  stable: boolean;
  /** Packet ids whose fixed-prefix hash diverged from the majority, sorted. */
  diverging_packet_ids: string[];
}

/** The deterministic scorecard `scoreTokens` emits. */
export interface TokenScorecard {
  schema_version: "score-tokens-scorecard/v1";
  run_id: string;
  steps: Array<{
    packet_id: string;
    pool_id: string | null;
    lens: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    /** cacheRead / (cacheRead + input) when BOTH legs are measured, else null. */
    cache_hit_ratio: number | null;
  }>;
  totals: {
    /** Sum of `input_tokens` over MEASURED steps only. */
    input_tokens: number;
    /** Sum of `output_tokens` over MEASURED steps only. */
    output_tokens: number;
    /** Steps with at least one reported usage field. */
    measured_steps: number;
    /** Steps whose usage was entirely unreported (never folded into totals as 0). */
    unmeasured_steps: number;
  };
  /** Aggregate cache_hit_ratio over measured steps only; null when none qualify. */
  cache_hit_ratio_overall: number | null;
  /** Structural (provider-independent) prompt-prefix cache-eligibility signal. */
  prefix_stability: PrefixStability;
  /** Per-pool (== per-provider identity, `pool_id` is `provider#account/model`) coverage. */
  provider_coverage: Record<string, "measured" | "unmeasured">;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** True iff at least one of the four usage legs was reported (not null/undefined). */
function isMeasured(entry: TokenUsageEntry): boolean {
  return (
    entry.input_tokens != null ||
    entry.output_tokens != null ||
    entry.cache_read_tokens != null ||
    entry.cache_creation_tokens != null
  );
}

/**
 * Score a run's recorded token-usage ledger — the pure score-tokens oracle.
 *
 * `prefixHashes` is an OPTIONAL caller-supplied map of `packet_id ->
 * fixed-prefix hash` (see {@link packetPromptPrefixHash}), computed by the
 * caller from the run's recorded packet prompts. Omit it when wiring real
 * prompt hashes end-to-end is not available — `prefix_stability` then defaults
 * to `{ stable: true, diverging_packet_ids: [] }` (no signal, not a false
 * failure).
 */
export function scoreTokens(
  runId: string,
  entries: TokenUsageEntry[],
  prefixHashes?: Record<string, string>,
): TokenScorecard {
  // Deterministic (sorted by packet_id) iteration so the scorecard is
  // byte-identical regardless of input order.
  const sorted = [...entries].sort((a, b) => a.packet_id.localeCompare(b.packet_id));

  const steps: TokenScorecard["steps"] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let measuredSteps = 0;
  let unmeasuredSteps = 0;
  let cacheHitReadSum = 0;
  let cacheHitDenomSum = 0;
  let cacheHitQualifyingSteps = 0;
  const providerCoverage = new Map<string, "measured" | "unmeasured">();

  for (const entry of sorted) {
    const poolKey = entry.pool_id ?? "unknown";
    const measured = isMeasured(entry);

    if (measured) {
      measuredSteps += 1;
      totalInput += entry.input_tokens ?? 0;
      totalOutput += entry.output_tokens ?? 0;
      // A pool is "measured" the moment ANY of its steps reported usage.
      providerCoverage.set(poolKey, "measured");
    } else {
      unmeasuredSteps += 1;
      // Never downgrade a pool already proven "measured" by an earlier step.
      if (providerCoverage.get(poolKey) !== "measured") {
        providerCoverage.set(poolKey, "unmeasured");
      }
    }

    // cache_hit_ratio requires BOTH legs measured (a lone cache_read with no
    // input denominator, or vice versa, is not a ratio — surfaced as null).
    const cacheRead = entry.cache_read_tokens;
    const input = entry.input_tokens;
    let cacheHitRatio: number | null = null;
    if (cacheRead != null && input != null) {
      cacheHitRatio = ratio(cacheRead, cacheRead + input);
      if (cacheHitRatio !== null) {
        cacheHitReadSum += cacheRead;
        cacheHitDenomSum += cacheRead + input;
        cacheHitQualifyingSteps += 1;
      }
    }

    steps.push({
      packet_id: entry.packet_id,
      pool_id: entry.pool_id ?? null,
      lens: entry.lens ?? null,
      input_tokens: entry.input_tokens ?? null,
      output_tokens: entry.output_tokens ?? null,
      cache_read_tokens: entry.cache_read_tokens ?? null,
      cache_hit_ratio: cacheHitRatio,
    });
  }

  return {
    schema_version: "score-tokens-scorecard/v1",
    run_id: runId,
    steps,
    totals: {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      measured_steps: measuredSteps,
      unmeasured_steps: unmeasuredSteps,
    },
    cache_hit_ratio_overall:
      cacheHitQualifyingSteps > 0 ? ratio(cacheHitReadSum, cacheHitDenomSum) : null,
    prefix_stability: computePrefixStability(prefixHashes),
    provider_coverage: Object.fromEntries(
      [...providerCoverage.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/**
 * Derive `prefix_stability` from an optional `packet_id -> fixed-prefix hash`
 * map. Absent/empty input defaults to "stable" (no structural signal available,
 * not a false failure). Otherwise every packet must share the FIRST (by sorted
 * packet_id) hash; any divergence is surfaced, never silently averaged away.
 */
function computePrefixStability(
  prefixHashes: Record<string, string> | undefined,
): PrefixStability {
  const entries = prefixHashes ? Object.entries(prefixHashes) : [];
  if (entries.length === 0) return { stable: true, diverging_packet_ids: [] };

  const sortedEntries = [...entries].sort(([a], [b]) => a.localeCompare(b));
  const referenceHash = sortedEntries[0]![1];
  const diverging = sortedEntries
    .filter(([, hash]) => hash !== referenceHash)
    .map(([packetId]) => packetId)
    .sort();
  return { stable: diverging.length === 0, diverging_packet_ids: diverging };
}

/**
 * The structural, provider-independent prefix-stability boundary: hash of the
 * FIXED prefix of a packet's rendered prompt — everything BEFORE the volatile
 * `## Packet` section (the same boundary
 * `tests/audit/dispatch-helpers.test.mjs` pins for prompt-caching:
 * `prompt.slice(0, prompt.indexOf("## Packet"))`). Two packets in the same run
 * whose fixed prefix hashes to the SAME value are byte-identical up to that
 * point — the structural precondition for a provider's prefix cache to hit,
 * independent of whether the provider actually reports a cache-hit ratio.
 *
 * A prompt with no `## Packet` marker hashes its entirety (defensive — never
 * throws on an unexpected prompt shape).
 */
export function packetPromptPrefixHash(prompt: string): string {
  const markerIdx = prompt.indexOf("## Packet");
  const prefix = markerIdx >= 0 ? prompt.slice(0, markerIdx) : prompt;
  return createHash("sha256").update(prefix, "utf8").digest("hex");
}

/**
 * The SOLE gate predicate: did the overall cache-hit ratio REGRESS (drop)
 * against a baseline? Mirrors score-audit's `hallucinationRegressed` mechanism
 * exactly, direction-flipped (higher cache-hit ratio is BETTER, so a regression
 * is a DECREASE, not an increase).
 *
 * - With no baseline, nothing has regressed.
 * - A `null` current ratio (no measured cache-eligible steps this run) cannot
 *   regress.
 * - A `null` baseline ratio is treated as 0 (the floor a ratio can't drop
 *   below), so a null baseline never triggers a regression.
 *
 * Token totals are tracked (`totals`) but never gate — track-don't-gate, same
 * policy as score-audit's precision/recall.
 */
export function cacheHitRatioRegressed(
  current: TokenScorecard,
  baseline: TokenScorecard | null | undefined,
  epsilon = 1e-9,
): boolean {
  if (!baseline) return false;
  const currentRatio = current.cache_hit_ratio_overall;
  if (currentRatio === null) return false;
  const baselineRatio = baseline.cache_hit_ratio_overall ?? 0;
  return currentRatio < baselineRatio - epsilon;
}

/** A compact, deterministic human summary of a {@link TokenScorecard}. */
export function renderTokenScorecardMarkdown(scorecard: TokenScorecard): string {
  const pct = (value: number | null): string =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const t = scorecard.totals;
  const lines = [
    `# Token scorecard — ${scorecard.run_id}`,
    "",
    `- Steps: ${t.measured_steps + t.unmeasured_steps} (measured ${t.measured_steps}, unmeasured ${t.unmeasured_steps})`,
    `- Input tokens (measured only): ${t.input_tokens}`,
    `- Output tokens (measured only): ${t.output_tokens}`,
    `- Cache-hit ratio (gated): ${pct(scorecard.cache_hit_ratio_overall)}`,
    `- Prefix stability: ${scorecard.prefix_stability.stable ? "stable" : "DIVERGING"}` +
      (scorecard.prefix_stability.diverging_packet_ids.length > 0
        ? ` (${scorecard.prefix_stability.diverging_packet_ids.join(", ")})`
        : ""),
  ];
  const coverageEntries = Object.entries(scorecard.provider_coverage);
  if (coverageEntries.length > 0) {
    lines.push("", "## Provider coverage");
    for (const [poolId, status] of coverageEntries) {
      lines.push(`- \`${poolId}\`: ${status}`);
    }
  }
  return lines.join("\n") + "\n";
}
