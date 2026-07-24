/**
 * vitest-gate-false-red.test.mjs — the gate's NONZERO-exit verdict.
 *
 * The gate already defends the false-GREEN case (exit 0 with reported failures).
 * This pins its mirror: vitest exits nonzero because its worker RPC timed out
 * under load while every test passed and the reporter finished cleanly. Observed
 * twice in one lap on the full three-area run — `Tests 7400 passed | 0 failed`
 * alongside `Errors 1 error` and a nonzero status.
 *
 * A green run that reads red by exit code is not a harmless annoyance: it is the
 * same false-signal class as a false green, and it trains a reader to wave at
 * reds — which is precisely how `main` sat red for ~a dozen laps while every lap
 * reported "green".
 *
 * The downgrade is deliberately NARROW, and each guard below is a way the naive
 * version ("nonzero but nothing failed ⇒ pass") would swallow a real red.
 */
import { test, expect } from "vitest";
import { isReporterTransportFault, HARNESS_FAULT } from "../../scripts/shared/vitestGateVerdict.mjs";

const TOKEN = "run-token-abc";
const RPC_TIMEOUT_STDERR = `
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.js:53:10
`;
const greenLedger = { runToken: TOKEN, outcome: { passed: 7400, failed: 0, skipped: 4 } };

test("downgrades a nonzero exit when THIS run's ledger is green and stderr shows the RPC fault", () => {
  expect(
    isReporterTransportFault({ record: greenLedger, token: TOKEN, stderrText: RPC_TIMEOUT_STDERR }),
  ).toBe(true);
});

test("keeps the red when a test actually failed, RPC fault or not", () => {
  // A worker RPC timeout can co-occur with genuine failures; the failures win.
  expect(
    isReporterTransportFault({
      record: { runToken: TOKEN, outcome: { passed: 10, failed: 1 } },
      token: TOKEN,
      stderrText: RPC_TIMEOUT_STDERR,
    }),
  ).toBe(false);
});

test("keeps the red when the nonzero exit has NO recognized harness signature", () => {
  // The critical guard. A crashed worker also exits nonzero having COUNTED zero
  // failures — precisely because its tests never ran. Downgrading on "nothing
  // failed" alone would silently pass a suite that never executed.
  expect(
    isReporterTransportFault({ record: greenLedger, token: TOKEN, stderrText: "FATAL: worker pool died" }),
  ).toBe(false);
  expect(isReporterTransportFault({ record: greenLedger, token: TOKEN, stderrText: "" })).toBe(false);
});

test("keeps the red when the green ledger belongs to a DIFFERENT run", () => {
  // Without the token check, yesterday's green ledger would launder today's red.
  expect(
    isReporterTransportFault({
      record: { ...greenLedger, runToken: "some-older-run" },
      token: TOKEN,
      stderrText: RPC_TIMEOUT_STDERR,
    }),
  ).toBe(false);
});

test("keeps the red when there is no usable ledger at all", () => {
  for (const record of [null, undefined, {}, { runToken: TOKEN }, "not-an-object"]) {
    expect(
      isReporterTransportFault({ record, token: TOKEN, stderrText: RPC_TIMEOUT_STDERR }),
      `record ${JSON.stringify(record)} must not downgrade a red`,
    ).toBe(false);
  }
});

test("the harness signature matches the observed form and not arbitrary prose", () => {
  expect(HARNESS_FAULT.test('[vitest-worker]: Timeout calling "onTaskUpdate"')).toBe(true);
  expect(HARNESS_FAULT.test('[vitest-worker]: Timeout calling "onCollected"')).toBe(true);
  // Test NAMES are author-chosen prose and must never trip it — the same
  // shortcut that produced two false hits when the gate grepped stdout.
  expect(HARNESS_FAULT.test('✓ handles a Timeout calling "onTaskUpdate" gracefully')).toBe(false);
});
