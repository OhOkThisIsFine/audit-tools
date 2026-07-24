// The vitest gate's two-sided verdict, extracted so it can be tested directly
// rather than only through a live vitest run (a real worker-RPC timeout is not
// reproducible on demand).
//
// The gate defends BOTH false signals, and they are mirror images:
//   • false GREEN — vitest exits 0 while the ledger reports failures. Caught by
//     the caller, which fails the gate.
//   • false RED  — vitest exits nonzero because its worker RPC timed out under
//     load, while every test passed and the reporter finished cleanly. This is
//     just as corrosive: a green run that reads red by exit code teaches a
//     reader to wave at reds, which is how `main` sat red for ~a dozen laps
//     while every lap reported green.

/**
 * Reporter-transport faults. Matched on a KNOWN signature on purpose — never
 * "no failures were counted, so it must be fine". A crashed worker also exits
 * nonzero with zero COUNTED failures, precisely because its tests never ran,
 * and that must stay red.
 */
export const HARNESS_FAULT = /\[vitest-worker\]:\s*Timeout calling "on[A-Za-z]+"/;

/**
 * Whether a NONZERO vitest exit should be downgraded to a pass.
 *
 * Every condition is load-bearing:
 *   - `record.runToken === token` proves the ledger belongs to THIS run, so a
 *     stale green ledger from a prior run can never launder a red one.
 *   - `outcome.failed === 0` — any counted failure is a real failure.
 *   - the stderr signature — an unrecognized nonzero exit keeps its exit code.
 *
 * @param {{record: unknown, token: string, stderrText: string}} input
 * @returns {boolean}
 */
export function isReporterTransportFault({ record, token, stderrText }) {
  if (!record || typeof record !== "object") return false;
  if (record.runToken !== token) return false;
  const outcome = record.outcome;
  if (!outcome || typeof outcome !== "object") return false;
  if (outcome.failed !== 0) return false;
  return HARNESS_FAULT.test(stderrText ?? "");
}
