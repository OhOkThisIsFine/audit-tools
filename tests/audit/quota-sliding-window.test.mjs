import { test, expect } from "vitest";

const { runSlidingWindow } = await import("audit-tools/shared/quota/slidingWindow");

test("runs all tasks and returns results in order", async () => {
  const tasks = [
    () => Promise.resolve("a"),
    () => Promise.resolve("b"),
    () => Promise.resolve("c"),
  ];
  const { results } = await runSlidingWindow(tasks, 2);
  expect(results.length).toBe(3);
  expect(results[0].status).toBe("fulfilled");
  expect(results[0].value).toBe("a");
  expect(results[2].value).toBe("c");
});

test("maintains concurrency limit", async () => {
  let activeCount = 0;
  let maxObserved = 0;

  const tasks = Array.from({ length: 6 }, (_, i) => async () => {
    activeCount++;
    if (activeCount > maxObserved) maxObserved = activeCount;
    await new Promise((r) => setTimeout(r, 50));
    activeCount--;
    return i;
  });

  const { results } = await runSlidingWindow(tasks, 2);
  expect(results.length).toBe(6);
  expect(maxObserved <= 2, `max concurrent was ${maxObserved}, expected <= 2`).toBeTruthy();
  expect(maxObserved, "should use full concurrency when possible").toBe(2);
});

test("isolates failures without stopping other tasks", async () => {
  const tasks = [
    () => Promise.resolve("ok"),
    () => Promise.reject(new Error("fail")),
    () => Promise.resolve("also ok"),
  ];
  const { results } = await runSlidingWindow(tasks, 3);
  expect(results[0].status).toBe("fulfilled");
  expect(results[0].value).toBe("ok");
  expect(results[1].status).toBe("rejected");
  expect(results[1].reason.message).toBe("fail");
  expect(results[2].status).toBe("fulfilled");
  expect(results[2].value).toBe("also ok");
});

test("fires onComplete callback for each task", async () => {
  const completed = [];
  const tasks = [
    () => Promise.resolve("a"),
    () => Promise.resolve("b"),
  ];
  await runSlidingWindow(tasks, 2, (index, result) => {
    completed.push({ index, status: result.status });
  });
  expect(completed.length).toBe(2);
  expect(completed.some((c) => c.index === 0)).toBeTruthy();
  expect(completed.some((c) => c.index === 1)).toBeTruthy();
});

test("handles empty task list", async () => {
  const { results } = await runSlidingWindow([], 5);
  expect(results.length).toBe(0);
});

test("handles concurrency greater than task count", async () => {
  const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)];
  const { results } = await runSlidingWindow(tasks, 10);
  expect(results.length).toBe(2);
  expect(results[0].value).toBe(1);
  expect(results[1].value).toBe(2);
});

test("fires onComplete callback for a rejected task", async () => {
  const completed = [];
  const tasks = [
    () => Promise.reject(new Error("boom")),
  ];
  await runSlidingWindow(tasks, 1, (index, result) => {
    completed.push({ index, result });
  });
  expect(completed.length, "onComplete should fire once for the rejected task").toBe(1);
  expect(completed[0].index).toBe(0);
  expect(completed[0].result.status).toBe("rejected");
  expect(completed[0].result.reason.message).toBe("boom");
});

test("handles invalid concurrency (zero and negative values)", async () => {
  // With concurrency=0: Math.min(0, N) = 0, so no initial runners are launched.
  // The results array is pre-allocated to length N but all entries stay undefined.
  const tasks = [() => Promise.resolve("x"), () => Promise.resolve("y")];

  const zero = await runSlidingWindow(tasks, 0);
  expect(zero.results.length, "results array should have length equal to task count").toBe(2);
  expect(zero.results[0], "no tasks should execute with concurrency=0").toBe(undefined);
  expect(zero.results[1], "no tasks should execute with concurrency=0").toBe(undefined);

  const neg = await runSlidingWindow(tasks, -1);
  expect(neg.results.length, "results array should have length equal to task count").toBe(2);
  expect(neg.results[0], "no tasks should execute with concurrency=-1").toBe(undefined);
  expect(neg.results[1], "no tasks should execute with concurrency=-1").toBe(undefined);
});

test("sliding window launches new worker as soon as one completes", async () => {
  const timeline = [];
  const tasks = [
    async () => { timeline.push("start-0"); await new Promise(r => setTimeout(r, 100)); timeline.push("end-0"); return 0; },
    async () => { timeline.push("start-1"); await new Promise(r => setTimeout(r, 200)); timeline.push("end-1"); return 1; },
    async () => { timeline.push("start-2"); await new Promise(r => setTimeout(r, 50)); timeline.push("end-2"); return 2; },
  ];
  await runSlidingWindow(tasks, 2);
  // Task 2 should start after task 0 finishes (not after both 0 and 1)
  const start2Idx = timeline.indexOf("start-2");
  const end0Idx = timeline.indexOf("end-0");
  const end1Idx = timeline.indexOf("end-1");
  expect(start2Idx > end0Idx, "task 2 should start after task 0 ends").toBeTruthy();
  expect(start2Idx < end1Idx, "task 2 should start before task 1 ends (sliding behavior)").toBeTruthy();
});
