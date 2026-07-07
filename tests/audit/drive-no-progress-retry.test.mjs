import { test, expect } from "vitest";

// D1 (NIM/Codex dispatch fix set): the bounded no-progress retry that stops a
// transient all-errored in-process dispatch pass from halting the autonomous loop.
// Tested in isolation with an injected clock so the backoff is instant.
const { driveWithNoProgressRetry } = await import("../../src/audit/cli/nextStepHelpers.ts");

// A no-op sleep that records the backoff durations it was asked to wait.
function fakeSleep() {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  return { sleep, waits };
}

// A no-progress driven result mirrors the guard's condition: not paused, nothing
// ingested, nothing stranded.
const noProgress = { status: "complete", ingest: null, stranded_ids: [], packet_count: 3 };
const progress = { status: "complete", ingest: { ingested: 3 }, stranded_ids: [], packet_count: 3 };
const isNoProgress = (d) => d.status !== "paused" && !d.ingest && d.stranded_ids.length === 0;

test("D1: a transient all-errored pass is retried with backoff, then succeeds", async () => {
  const { sleep, waits } = fakeSleep();
  let calls = 0;
  const result = await driveWithNoProgressRetry(
    async () => { calls += 1; return calls < 2 ? noProgress : progress; },
    isNoProgress,
    { maxRetries: 2, baseBackoffMs: 500, deps: { sleep } },
  );
  expect(calls, "initial drive + one retry that recovers").toBe(2);
  expect(result.ingest, "returns the progress result").not.toBe(null);
  expect(waits, "exactly one backoff wait, exponential base").toEqual([500]);
});

test("D1: retries are bounded — a persistently unproductive pass gives up after the budget", async () => {
  const { sleep, waits } = fakeSleep();
  let calls = 0;
  const result = await driveWithNoProgressRetry(
    async () => { calls += 1; return noProgress; },
    isNoProgress,
    { maxRetries: 2, baseBackoffMs: 500, deps: { sleep } },
  );
  expect(calls, "1 initial + 2 retries, then stops").toBe(3);
  expect(result.ingest, "still no progress → the caller honours the no-progress guard").toBe(null);
  // Exponential backoff across the two retries.
  expect(waits).toEqual([500, 1000]);
});

test("D1: a productive first pass never retries (and never sleeps)", async () => {
  const { sleep, waits } = fakeSleep();
  let calls = 0;
  await driveWithNoProgressRetry(
    async () => { calls += 1; return progress; },
    isNoProgress,
    { maxRetries: 2, baseBackoffMs: 500, deps: { sleep } },
  );
  expect(calls).toBe(1);
  expect(waits).toEqual([]);
});

test("D1: maxTotalMs stops retries once the elapsed budget is spent (all-timeout guard)", async () => {
  const { sleep } = fakeSleep();
  // Injected clock: each drive advances the clock by ~a full timeout window, so after
  // the first drive the elapsed budget is already spent and no retry is attempted.
  let clock = 0;
  const now = () => clock;
  let calls = 0;
  const result = await driveWithNoProgressRetry(
    async () => { calls += 1; clock += 120_000; return noProgress; },
    isNoProgress,
    { maxRetries: 2, baseBackoffMs: 500, maxTotalMs: 120_000, deps: { sleep, now } },
  );
  expect(calls, "first drive spent the whole budget → no expensive retry").toBe(1);
  expect(result.ingest).toBe(null);
});

test("D1: with headroom under maxTotalMs, fast-failing passes still retry", async () => {
  const { sleep } = fakeSleep();
  let clock = 0;
  const now = () => clock;
  let calls = 0;
  await driveWithNoProgressRetry(
    async () => { calls += 1; clock += 10; return noProgress; }, // fast fails
    isNoProgress,
    { maxRetries: 2, baseBackoffMs: 500, maxTotalMs: 120_000, deps: { sleep, now } },
  );
  expect(calls, "fast passes leave headroom → full retry budget used").toBe(3);
});

test("D1: a paused pass is NOT treated as no-progress (resumable, handled separately)", async () => {
  const { sleep, waits } = fakeSleep();
  let calls = 0;
  const paused = { status: "paused", ingest: null, stranded_ids: [], packet_count: 3 };
  const result = await driveWithNoProgressRetry(
    async () => { calls += 1; return paused; },
    isNoProgress,
    { maxRetries: 2, baseBackoffMs: 500, deps: { sleep } },
  );
  expect(calls, "paused is not a no-progress condition → no retry").toBe(1);
  expect(result.status).toBe("paused");
  expect(waits).toEqual([]);
});
