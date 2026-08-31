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
 *   - `outcome.unfinished === 0` — every leaf REPORTED. This is the load-bearing
 *     one for the fault this function recognizes: `HARNESS_FAULT` matches a timeout
 *     on `onTaskUpdate`, the RPC that carries task RESULTS back from the worker. A
 *     result lost to that timeout leaves its leaf with no state at all, so a
 *     genuinely FAILED test would never be counted as failed and `failed === 0`
 *     would hold vacuously. Counting unreported leaves separately from deliberate
 *     skips is what keeps that from laundering a red into a green. A ledger
 *     lacking the field is from an older reporter and cannot prove the absence —
 *     it keeps the red.
 *   - the stderr signature — an unrecognized nonzero exit keeps its exit code.
 *
 * @param {{record: unknown, token: string, stderrText: string}} input
 * @returns {boolean}
 */
export function isReporterTransportFault({ record, token, stderrText }) {
  if (!record || typeof record !== "object") return false;
  const typedRecord = /** @type {any} */ (record);
  if (typedRecord.runToken !== token) return false;
  const outcome = typedRecord.outcome;
  if (!outcome || typeof outcome !== "object") return false;
  if (outcome.failed !== 0) return false;
  if (outcome.unfinished !== 0) return false;
  return HARNESS_FAULT.test(stderrText ?? "");
}

// ─── Failure attribution ───────────────────────────────────────────────────
// A caller that only sees this gate's EXIT CODE knows a run failed and nothing
// else. `.claude/hooks/pre-commit-gate.mjs` used to close that gap by asserting
// a cause — "a staged doc/asset broke a test that pins its exact content" — for
// every failure of `npm run test:doc-contract`, including a globalSetup fault,
// a live child of the run, or an ordinary flake. It was confidently wrong above
// real evidence, and it also named three files while that run has four.
//
// The gate RUNNER is the boundary that owns this: it alone holds the ledger it
// can prove belongs to this run (the run token). So it STATES the attribution
// on one machine-readable line and its callers relay what it said, rather than
// scraping vitest's human output or guessing. PH-05 — a gate states the
// boundary it is authoritative at.

/** The one-line contract between the gate runner and anything reading its output. */
export const ATTRIBUTION_PREFIX = "[vitest-gate] ATTRIBUTION:";

/**
 * What this run's own ledger can prove about WHICH files failed.
 *
 * Unattributable is a first-class verdict, never a guess: a ledger this run
 * cannot prove it wrote, or a nonzero exit carrying zero counted failures, both
 * mean the failure happened somewhere the test results do not describe.
 *
 * @param {{record: unknown, token: string}} input
 * @returns {{attributable: true, failedFiles: string[]} | {attributable: false, reason: string}}
 */
export function attributeFailure({ record, token }) {
  if (!record || typeof record !== "object") {
    return { attributable: false, reason: "this run wrote no readable ledger" };
  }
  const typedRecord = /** @type {any} */ (record);
  if (typedRecord.runToken !== token) {
    return {
      attributable: false,
      reason: "the ledger does not carry this run's token, so it cannot be trusted to describe it",
    };
  }
  const outcome = typedRecord.outcome;
  if (!outcome || typeof outcome !== "object") {
    return { attributable: false, reason: "this run's ledger has no structured outcome" };
  }
  const failedFiles = Array.isArray(outcome.failedFiles) ? outcome.failedFiles : [];
  if (failedFiles.length === 0) {
    return {
      attributable: false,
      reason:
        "this run recorded no failing test file, so it failed OUTSIDE the tests " +
        "(setup, teardown, a lost worker, or the runner itself)",
    };
  }
  return { attributable: true, failedFiles };
}

/**
 * Render {@link attributeFailure}'s verdict as the single line callers parse.
 * @param {{attributable: true, failedFiles: string[]} | {attributable: false, reason: string}} verdict
 * @returns {string}
 */
export function formatAttributionLine(verdict) {
  return verdict.attributable
    ? `${ATTRIBUTION_PREFIX} files=${verdict.failedFiles.join(",")}`
    : `${ATTRIBUTION_PREFIX} unattributable — ${verdict.reason}`;
}

/**
 * Read back the line {@link formatAttributionLine} wrote, from a block of
 * output. Returns null when the runner stated nothing — which a caller must
 * treat as unattributable rather than as permission to assert a cause.
 *
 * @param {string} text
 * @returns {{attributable: true, failedFiles: string[]} | {attributable: false, reason: string} | null}
 */
export function parseAttributionLine(text) {
  const line = (text ?? "")
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes(ATTRIBUTION_PREFIX));
  if (!line) return null;
  const body = line.slice(line.indexOf(ATTRIBUTION_PREFIX) + ATTRIBUTION_PREFIX.length).trim();
  if (body.startsWith("files=")) {
    const failedFiles = body.slice("files=".length).split(",").map((f) => f.trim()).filter(Boolean);
    if (failedFiles.length > 0) return { attributable: true, failedFiles };
    return { attributable: false, reason: "the runner reported an empty file list" };
  }
  const reason = body.replace(/^unattributable\s*[—-]\s*/, "");
  return { attributable: false, reason: reason || "the runner did not say why" };
}
