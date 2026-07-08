// Throughput axis for the cost↔speed dispatch dial (spec/dispatch-cost-speed-dial.md).
//
// A pool's throughput score is the sustained token-intake rate its DECLARED limits
// permit — higher is faster. It is composed ONLY from declared/discovered signals
// (TPM, then RPM); nothing is learned or measured. This is the direct consequence of
// the settled rule "concurrency is declared or absent, never learned": there is no
// AIMD ceiling to lean on, and a measured tokens/sec signal is the same class of
// learned dispatch signal that rule forbids. `declaredCap` (a COUNT) is NOT part of
// the score — it stays the hard parallelism gate the admission spill loop already
// enforces.

/**
 * A declared-signal proxy converting a request/min limit into a token/min rate when
 * no token/min limit is declared. Deliberately coarse — it only has to order pools on
 * the speed axis, and RPM-only pools are rare.
 */
export const REPRESENTATIVE_PACKET_TOKENS = 8000;

export interface ThroughputSignals {
  /** Declared sustained input token rate (tokens/min). */
  inputTokensPerMinute?: number | null;
  /** Declared sustained request rate (requests/min). */
  requestsPerMinute?: number | null;
}

/**
 * Sustained token-intake rate (tokens/min) a pool's declared limits permit; higher =
 * faster. Resolution, declared-only:
 *   1. TPM present  → the declared input-token rate.
 *   2. TPM absent, RPM present → RPM × representative packet size (a declared-signal
 *      proxy for token rate).
 *   3. no declared rate limit → rate-unbounded ⇒ +Infinity (ranks fastest; an
 *      unmetered endpoint is hardware-bound, not rate-capped, and the operator's
 *      declared config is authoritative).
 */
export function throughputScore(signals: ThroughputSignals): number {
  const tpm = signals.inputTokensPerMinute;
  if (typeof tpm === "number" && Number.isFinite(tpm) && tpm > 0) return tpm;
  const rpm = signals.requestsPerMinute;
  if (typeof rpm === "number" && Number.isFinite(rpm) && rpm > 0) {
    return rpm * REPRESENTATIVE_PACKET_TOKENS;
  }
  return Number.POSITIVE_INFINITY;
}
