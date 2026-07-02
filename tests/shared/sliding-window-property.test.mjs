// DR-008 property tests for runSlidingWindow: concurrency-invariant and
// rejection-isolation cases.
import { test, expect } from "vitest";

const { runSlidingWindow } = await import("../../src/shared/quota/slidingWindow.ts");

test("DR-008 slidingWindow: at most `concurrency` tasks run simultaneously", async () => {
  const concurrency = 3;
  const total = 10;
  let inFlight = 0;
  let maxInFlight = 0;

  const tasks = Array.from({ length: total }, (_, i) => async () => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    // Yield to let the event loop schedule other tasks
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i;
  });

  const { results } = await runSlidingWindow(tasks, concurrency);

  expect(maxInFlight <= concurrency, `max in-flight (${maxInFlight}) exceeded concurrency (${concurrency})`).toBe(true);
  expect(results.length).toBe(total);
});

test("DR-008 slidingWindow: all tasks complete and results array is fully populated", async () => {
  const total = 10;
  const tasks = Array.from({ length: total }, (_, i) => async () => i * 2);

  const { results } = await runSlidingWindow(tasks, 3);

  expect(results.length).toBe(total);
  for (let i = 0; i < total; i++) {
    expect(results[i].status).toBe("fulfilled");
    expect((results[i]).value).toBe(i * 2);
  }
});

test("DR-008 slidingWindow: task rejections do not drop subsequent tasks", async () => {
  // Tasks at even indices reject; odd indices fulfill
  const total = 8;
  const tasks = Array.from({ length: total }, (_, i) => async () => {
    if (i % 2 === 0) throw new Error(`task-${i}-failed`);
    return i;
  });

  const { results } = await runSlidingWindow(tasks, 2);

  expect(results.length).toBe(total);
  for (let i = 0; i < total; i++) {
    if (i % 2 === 0) {
      expect(results[i].status).toBe("rejected");
    } else {
      expect(results[i].status).toBe("fulfilled");
      expect((results[i]).value).toBe(i);
    }
  }
});

test("DR-008 slidingWindow: runSlidingWindow itself resolves even when all tasks reject", async () => {
  const tasks = Array.from({ length: 5 }, (_, i) => async () => {
    throw new Error(`always-fail-${i}`);
  });

  // Must not throw — returns results array with all rejected entries
  const { results } = await runSlidingWindow(tasks, 2);
  expect(results.length).toBe(5);
  for (const r of results) {
    expect(r.status).toBe("rejected");
  }
});

test("DR-008 slidingWindow: onComplete callback fires once per task in completion order", async () => {
  const total = 6;
  const completedIndices = [];
  const tasks = Array.from({ length: total }, (_, i) => async () => i);

  await runSlidingWindow(tasks, 2, (index) => {
    completedIndices.push(index);
  });

  expect(completedIndices.length).toBe(total);
  // Every index from 0..total-1 should appear exactly once
  const sorted = [...completedIndices].sort((a, b) => a - b);
  for (let i = 0; i < total; i++) {
    expect(sorted[i]).toBe(i);
  }
});

test("DR-008 slidingWindow: concurrency=1 serializes tasks (maxInFlight never exceeds 1)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  const tasks = Array.from({ length: 8 }, () => async () => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  });

  await runSlidingWindow(tasks, 1);
  expect(maxInFlight).toBe(1);
});

test("DR-008 slidingWindow: empty task list returns empty results", async () => {
  const { results } = await runSlidingWindow([], 3);
  expect(results.length).toBe(0);
});
