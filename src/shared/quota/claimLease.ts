import type { ClaimRegistry, ClaimResult } from "./claimRegistry.js";

/**
 * Cooperative-claim helpers on top of `ClaimRegistry` for multi-agent runs
 * (`spec/multi-ide-concurrent-runs-design.md`). Two pieces:
 *
 *  - `claimWithBackoff` — OD1's "a few increasing in-process waits, then hand
 *    back": try to claim; on contention wait a little and retry a bounded number
 *    of times before returning the final (still-contended) result so the caller
 *    can emit a cooperative-wait step.
 *  - `withClaimHeartbeat` — OD3 layer 1: run a unit while heartbeating its claim
 *    so a long executor is not reclaimed mid-flight, AND — because
 *    `heartbeat(node, token)` returns false once the token no longer owns the
 *    node — treat a failed heartbeat as a revocation signal (`onRevoked`). The
 *    airtight guarantee is still the caller's merge-time ownership gate (layer 2).
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Default increasing in-process backoff (ms) before handing back a cooperative-wait. */
export const DEFAULT_CLAIM_BACKOFF_MS: readonly number[] = [250, 750, 2000];

export interface ClaimBackoffOptions {
  poolId: string;
  /** Increasing waits (ms) between re-attempts; defaults to `DEFAULT_CLAIM_BACKOFF_MS`. */
  backoffMs?: readonly number[];
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Attempt to claim `nodeId`, retrying through a bounded increasing backoff while
 * it is held by a live peer. Returns the final `ClaimResult` — `acquired:true`
 * with the owner token, or `acquired:false` after the backoff is exhausted.
 */
export async function claimWithBackoff(
  registry: ClaimRegistry,
  nodeId: string,
  options: ClaimBackoffOptions,
): Promise<ClaimResult> {
  const backoff = options.backoffMs ?? DEFAULT_CLAIM_BACKOFF_MS;
  const doSleep = options.sleepFn ?? sleep;
  let result = await registry.claim(nodeId, options.poolId);
  for (let i = 0; i < backoff.length && !result.acquired; i += 1) {
    await doSleep(backoff[i]);
    result = await registry.claim(nodeId, options.poolId);
  }
  return result;
}

export interface ClaimHeartbeatOptions {
  intervalMs: number;
  /** Injectable timer factory for tests; defaults to `setInterval`. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Called once if a heartbeat reports the claim is no longer owned (revoked). */
  onRevoked?: () => void;
}

/**
 * Run `fn` while periodically heartbeating the held claim. A heartbeat returning
 * false (the claim was reclaimed by a peer) fires `onRevoked` once. The timer is
 * unref'd so it never keeps the process alive, and always cleared when `fn`
 * settles.
 */
export async function withClaimHeartbeat<T>(
  registry: ClaimRegistry,
  nodeId: string,
  ownerToken: string,
  options: ClaimHeartbeatOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const setIntervalImpl = options.setIntervalFn ?? setInterval;
  const clearIntervalImpl = options.clearIntervalFn ?? clearInterval;
  let revoked = false;
  const timer = setIntervalImpl(() => {
    void registry
      .heartbeat(nodeId, ownerToken)
      .then((stillOwned) => {
        if (!stillOwned && !revoked) {
          revoked = true;
          options.onRevoked?.();
        }
      })
      .catch(() => {
        /* transient registry read error — the next tick (or the merge-time gate) covers it */
      });
  }, options.intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    return await fn();
  } finally {
    clearIntervalImpl(timer);
  }
}
