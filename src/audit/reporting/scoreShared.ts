// Shared pure primitives for audit scoring.
// The pair had byte-copied `ratio` and the `pct` render closure, and had two
// structurally identical gate predicates that differ ONLY in direction — a
// difference that is deliberate and load-bearing, so it is expressed as a
// parameter here rather than collapsed away.

/** numerator/denominator, or null on a zero denominator (undefined, never a silent 0). */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Percent render for a scorecard cell; null → "n/a". */
export function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * Which way a metric has to move to count as a regression.
 * - `lower-is-better` (hallucination RATE): regressed when the current value RISES.
 * - `higher-is-better` (cache-hit RATIO): regressed when the current value FALLS.
 */
export type RegressionDirection = "higher-is-better" | "lower-is-better";

/**
 * The single gate predicate both oracles draw from: did `current` regress against
 * `baseline`, in the given direction? `epsilon` absorbs floating-point noise so a
 * byte-identical re-run never trips.
 *
 * - A `null` current value carries no signal and cannot regress.
 * - A `null` baseline is treated as 0 — the floor a ratio cannot drop below
 *   (`higher-is-better` never trips), and the floor any positive rate exceeds
 *   (`lower-is-better` trips on any positive current).
 */
export function valueRegressed(
  current: number | null,
  baseline: number | null | undefined,
  direction: RegressionDirection,
  epsilon = 1e-9,
): boolean {
  if (current === null) return false;
  const base = baseline ?? 0;
  return direction === "higher-is-better"
    ? current < base - epsilon
    : current > base + epsilon;
}
