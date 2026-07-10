import { detectRateLimitFromChannel } from "../quota/errorParsing.js";
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
 * The shared launch-result finalize tail run by BOTH per-packet dispatchers
 * (audit `makeAuditProviderPacketDispatcher`, remediate `makeProviderNodeDispatcher`)
 * once `provider.launch(...)` returns. Everything here is provider/domain-neutral,
 * so single-sourcing it removes the drift that previously lived across the two
 * copies (e.g. an audit-only dead `observedUsage` result field). The launch INPUT
 * and the result-CONTENT adjudication stay per-orchestrator — those are the genuine
 * read-only-vs-git-mutating / AuditResult-vs-ImplementWorkerResult divergences.
 *
 * In order:
 *  1. not-accepted → error;
 *  2. channel-isolated session-limit detection on stderr (CE-003) → non-consuming
 *     rate_limited re-queue (the result file is never scanned for limit strings);
 *  3. relay the endpoint-reported cost (when present) so `handleResult` can demote a
 *     declared-free pool that started charging;
 *  4. confirm the worker's result file landed + parses — if missing, check stdout for
 *     a session-limit message (some providers report status there) before erroring;
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
  if (!launch.accepted) {
    return {
      packet,
      outcome: "error",
      error: new Error(
        launch.error ?? `provider ${ctx.providerName} rejected ${ctx.entityLabel}`,
      ),
    };
  }

  // Channel-isolated session-limit detection (CE-003): only the error/status channel
  // (stderr) is inspected — the result file is never scanned for limit strings, so a
  // healthy result quoting a limit never triggers a re-queue.
  const stderrText = (await readOptionalTextFile(ctx.stderrPath)) ?? "";
  const limitCheck = detectRateLimitFromChannel("error", stderrText);
  if (limitCheck.isRateLimited) {
    // Non-consuming re-queue: the rolling engine drops the provider and puts this
    // packet back into the pending pool so it retries once the cooldown passes.
    return {
      packet,
      outcome: "rate_limited",
      rateLimit: { channel: "error", text: stderrText },
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
    // Also check stdout for a session-limit message before reporting as error (some
    // providers write their status to stdout, not stderr).
    const stdoutText = (await readOptionalTextFile(ctx.stdoutPath)) ?? "";
    const stdoutLimitCheck = detectRateLimitFromChannel("status", stdoutText);
    if (stdoutLimitCheck.isRateLimited) {
      return {
        packet,
        outcome: "rate_limited",
        rateLimit: { channel: "status", text: stdoutText },
      };
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
