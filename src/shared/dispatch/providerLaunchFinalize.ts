import {
  detectRateLimitFromChannel,
  detectCreditExhaustionFromChannel,
  detectModelUnavailableFromChannel,
  detectRequestTooLargeFromChannel,
  detectQuotaSuspicious,
} from "../quota/errorParsing.js";
import { appendTokenUsageLine } from "../io/tokenUsageLedger.js";
import { readOptionalJsonFile, readOptionalTextFile } from "../io/json.js";
import type { LaunchFreshSessionResult } from "../providers/types.js";
import type { RollingDispatchPacket, RollingDispatchResult } from "./rollingDispatch.js";

export interface ProviderLaunchFinalizeContext<TPacket> {
  /** The packet/node being dispatched, echoed back on the result verbatim. */
  packet: RollingDispatchPacket<TPacket>;
  /** Resolved provider name, for the not-accepted error message. */
  providerName: string;
  /**
   * Human label for this unit of work in error messages — `packet ${id}` on the
   * audit side, `node ${id}` on the remediate side. The ONLY per-orchestrator
   * wording difference in the finalize tail.
   */
  entityLabel: string;
  /** Worker result file the prompt instructed the worker to write. */
  resultPath: string;
  /** Worker stdout capture (fallback rate-limit channel when no result landed). */
  stdoutPath: string;
  /** Worker stderr capture (primary rate-limit channel). */
  stderrPath: string;
  artifactsDir: string;
  runId: string;
  /** Token-usage ledger key: audit's `packet.id` / remediate's `block.block_id`. */
  packetId: string;
  poolId: string | null;
}

/**
 * Classify a worker's failure text by scanning stderr and stdout in order for known
 * quota/API-error patterns. Reused identically by both not-accepted (exit ≠ 0) and
 * accepted-but-no-result-file branches so they cannot drift.
 *
 * **Scan order (load-bearing — F4 requires stderr request-too-large BEFORE rate-limit
 * so a combined "413 ... retry rate limit" cannot cooldown-poison a healthy pool):**
 *  1. stderr: credit-exhaustion (permanent, no reset timer)
 *  2. stderr: request-too-large (per-packet sizing fault, no cooldown)
 *  3. stderr: model-unavailable (404, permanent pool exclusion)
 *  4. stderr: rate-limit (transient 429)
 *  5. stdout: credit-exhaustion
 *  6. stdout: request-too-large
 *  7. stdout: model-unavailable
 *  8. stdout: rate-limit
 *  9. TIER 2 `detectQuotaSuspicious` over both channels combined (fallback pre-filter)
 *
 * Returns the corresponding RollingDispatchResult fragment or null if no match.
 */
function classifyFailureChannels<TPacket>(
  packet: RollingDispatchPacket<TPacket>,
  stderrText: string,
  stdoutText: string,
): Omit<RollingDispatchResult<TPacket>, "packet"> | null {
  // Stderr TIER 1: credit exhaustion (permanent, checked first — must never fall through to rate-limit)
  const stderrCreditCheck = detectCreditExhaustionFromChannel("error", stderrText);
  if (stderrCreditCheck.isCreditExhausted) {
    return {
      outcome: "credit_exhausted",
      creditExhaustion: { channel: "error", text: stderrText, rawMatch: stderrCreditCheck.rawMatch },
    };
  }

  // Stderr TIER 1: request-too-large (F4 — must be checked BEFORE rate-limit to prevent cooldown-poisoning)
  const stderrTooLargeCheck = detectRequestTooLargeFromChannel("error", stderrText);
  if (stderrTooLargeCheck.isRequestTooLarge) {
    return {
      outcome: "packet_too_large",
      packetTooLarge: { channel: "error", text: stderrText, rawMatch: stderrTooLargeCheck.rawMatch },
    };
  }

  // Stderr TIER 1: model-unavailable (permanent pool exclusion, checked before rate-limit)
  const stderrModelUnavailableCheck = detectModelUnavailableFromChannel("error", stderrText);
  if (stderrModelUnavailableCheck.isModelUnavailable) {
    return {
      outcome: "model_unavailable",
      modelUnavailable: { channel: "error", text: stderrText, rawMatch: stderrModelUnavailableCheck.rawMatch },
    };
  }

  // Stderr TIER 1: rate-limit (transient, applies cooldown)
  const stderrLimitCheck = detectRateLimitFromChannel("error", stderrText);
  if (stderrLimitCheck.isRateLimited) {
    return {
      outcome: "rate_limited",
      rateLimit: { channel: "error", text: stderrText },
    };
  }

  // Stdout TIER 1: credit exhaustion (some providers report to stdout instead)
  const stdoutCreditCheck = detectCreditExhaustionFromChannel("status", stdoutText);
  if (stdoutCreditCheck.isCreditExhausted) {
    return {
      outcome: "credit_exhausted",
      creditExhaustion: { channel: "status", text: stdoutText, rawMatch: stdoutCreditCheck.rawMatch },
    };
  }

  // Stdout TIER 1: request-too-large
  const stdoutTooLargeCheck = detectRequestTooLargeFromChannel("status", stdoutText);
  if (stdoutTooLargeCheck.isRequestTooLarge) {
    return {
      outcome: "packet_too_large",
      packetTooLarge: { channel: "status", text: stdoutText, rawMatch: stdoutTooLargeCheck.rawMatch },
    };
  }

  // Stdout TIER 1: model-unavailable
  const stdoutModelUnavailableCheck = detectModelUnavailableFromChannel("status", stdoutText);
  if (stdoutModelUnavailableCheck.isModelUnavailable) {
    return {
      outcome: "model_unavailable",
      modelUnavailable: { channel: "status", text: stdoutText, rawMatch: stdoutModelUnavailableCheck.rawMatch },
    };
  }

  // Stdout TIER 1: rate-limit
  const stdoutLimitCheck = detectRateLimitFromChannel("status", stdoutText);
  if (stdoutLimitCheck.isRateLimited) {
    return {
      outcome: "rate_limited",
      rateLimit: { channel: "status", text: stdoutText },
    };
  }

  // TIER 2 (Slice A2b): broad pre-filter on combined channels (fallback for unclassified quota-suspicious text)
  const combinedText = [stderrText, stdoutText].filter((t) => t.length > 0).join("\n");
  if (combinedText.length > 0 && detectQuotaSuspicious(combinedText)) {
    return {
      outcome: "quota_unclassified",
      quotaUnclassified: {
        channel: stderrText.length > 0 ? "error" : "status",
        text: combinedText,
      },
    };
  }

  return null;
}

/**
 * The shared launch-result finalize tail run by BOTH per-packet dispatchers
 * (audit `makeAuditProviderPacketDispatcher`, remediate `makeProviderNodeDispatcher`)
 * once `provider.launch(...)` returns. Everything here is provider/domain-neutral,
 * so single-sourcing it removes the drift that previously lived across the two
 * copies (e.g. an audit-only dead `observedUsage` result field). The launch INPUT
 * and the result-CONTENT adjudication stay per-orchestrator — those are the genuine
 * read-only-vs-git-mutating / AuditResult-vs-ImplementWorkerResult divergences.
 *
 * In order:
 *  1. not-accepted → classify the failure text via the shared `classifyFailureChannels`
 *     helper (mirrors the accepted-but-no-result-file branch so both cannot drift);
 *  2. channel-isolated credit-exhaustion (TIER 1) then session-limit (TIER 1)
 *     detection on stderr (CE-003) → credit_exhausted / non-consuming
 *     rate_limited re-queue (the result file is never scanned for these strings);
 *  3. relay the endpoint-reported cost (when present) so `handleResult` can demote a
 *     declared-free pool that started charging;
 *  4. confirm the worker's result file landed + parses — if missing, check stdout for
 *     credit-exhaustion / session-limit (TIER 1, some providers report status there),
 *     then the broad quota-suspicious pre-filter (TIER 2, Slice A2b) across both
 *     channels combined → `quota_unclassified` conservative re-queue + verbatim-text
 *     harvest, before finally erroring (TIER 3 — text matches nothing quota-shaped);
 *  5. append the per-run token-usage ledger line at result-handling time (never on the
 *     admission path — INV: no added admission latency), best-effort;
 *  6. success. The result CONTENT is adjudicated downstream by the deterministic merge,
 *     so the finalizer only confirms the file exists — it does not return the payload.
 */
export async function finalizeProviderLaunchResult<TPacket>(
  launch: LaunchFreshSessionResult,
  ctx: ProviderLaunchFinalizeContext<TPacket>,
): Promise<RollingDispatchResult<TPacket>> {
  const { packet } = ctx;

  // Read both channels for classification (reused by both not-accepted and accepted-but-no-result branches)
  //
  // DELIBERATE semantic change (2026-07-17, gap-fix lap): an ACCEPTED launch whose
  // result file landed + parses is a SUCCESS even if a channel carries limit text —
  // an agentic worker that retried through transient 429s and still delivered must
  // not have its completed work discarded and re-run (the old order scanned stderr
  // before the result read and re-queued such packets). Channel classification now
  // applies only when the launch was rejected or no result landed; result CONTENT
  // is still never scanned (CE-003) and is adjudicated by the merge downstream.
  const stderrText = (await readOptionalTextFile(ctx.stderrPath)) ?? "";
  const stdoutText = (await readOptionalTextFile(ctx.stdoutPath)) ?? "";

  // The not-accepted branch NOW runs the channel classifier BEFORE returning error.
  // This fixes the dogfood gap: a nonzero-exit worker's 429/404/413 text is now scanned.
  if (!launch.accepted) {
    const classification = classifyFailureChannels(packet, stderrText, stdoutText);
    if (classification) {
      return { packet, ...classification };
    }
    // No classification matched — return the original error
    return {
      packet,
      outcome: "error",
      error: new Error(
        launch.error ?? `provider ${ctx.providerName} rejected ${ctx.entityLabel}`,
      ),
    };
  }

  // Reactive cost verification: relay the endpoint-reported cost (when the provider
  // surfaced one) so `handleResult` can demote a declared-free pool that started
  // charging. Absent for providers that report no cost.
  const observedCost =
    launch.observedCostUsd != null ? { observedCostUsd: launch.observedCostUsd } : {};

  // The worker writes its result file per the prompt; confirm it landed and parses.
  // Contents are adjudicated by the deterministic merge downstream.
  const result = await readOptionalJsonFile<unknown>(ctx.resultPath);
  if (!result) {
    // No result file landed — reuse the same channel classifier so both branches cannot drift.
    // Channel isolation (CE-003) is preserved: result channel is never scanned.
    const classification = classifyFailureChannels(packet, stderrText, stdoutText);
    if (classification) {
      return { packet, ...classification };
    }

    return {
      packet,
      outcome: "error",
      error: new Error(
        `worker for ${ctx.entityLabel} wrote no result at ${ctx.resultPath}`,
      ),
    };
  }

  // Record the token-usage ledger line NOW — at packet-completion / result-handling
  // time, never on the dispatch/admission path (INV: no added admission latency).
  // Every completed packet gets a line, including the agentic-CLI providers
  // (claude-code/codex/opencode) that report no structured usage — their legs are
  // null, distinctly "unmeasured" rather than silently 0. Best-effort.
  await appendTokenUsageLine(ctx.artifactsDir, ctx.runId, {
    packet_id: ctx.packetId,
    pool_id: ctx.poolId,
    input_tokens: launch.observedUsage?.inputTokens ?? null,
    output_tokens: launch.observedUsage?.outputTokens ?? null,
    cache_read_tokens: launch.observedUsage?.cacheReadTokens ?? null,
    cache_creation_tokens: launch.observedUsage?.cacheCreationTokens ?? null,
    observed_cost_usd: launch.observedCostUsd ?? null,
  });
  return { packet, outcome: "success", ...observedCost };
}
