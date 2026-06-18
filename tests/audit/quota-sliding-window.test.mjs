import test from "node:test";
import assert from "node:assert/strict";

const { runSlidingWindow } = await import("audit-tools/shared/quota/slidingWindow");

test("runs all tasks and returns results in order", async () => {
  const tasks = [
    () => Promise.resolve("a"),
    () => Promise.resolve("b"),
    () => Promise.resolve("c"),
  ];
  const { results } = await runSlidingWindow(tasks, 2);
  assert.equal(results.length, 3);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "a");
  assert.equal(results[2].value, "c");
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
  assert.equal(results.length, 6);
  assert.ok(maxObserved <= 2, `max concurrent was ${maxObserved}, expected <= 2`);
  assert.equal(maxObserved, 2, "should use full concurrency when possible");
});

test("isolates failures without stopping other tasks", async () => {
  const tasks = [
    () => Promise.resolve("ok"),
    () => Promise.reject(new Error("fail")),
    () => Promise.resolve("also ok"),
  ];
  const { results } = await runSlidingWindow(tasks, 3);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "ok");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.message, "fail");
  assert.equal(results[2].status, "fulfilled");
  assert.equal(results[2].value, "also ok");
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
  assert.equal(completed.length, 2);
  assert.ok(completed.some((c) => c.index === 0));
  assert.ok(completed.some((c) => c.index === 1));
});

test("handles empty task list", async () => {
  const { results } = await runSlidingWindow([], 5);
  assert.equal(results.length, 0);
});

test("handles concurrency greater than task count", async () => {
  const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)];
  const { results } = await runSlidingWindow(tasks, 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].value, 1);
  assert.equal(results[1].value, 2);
});

test("fires onComplete callback for a rejected task", async () => {
  const completed = [];
  const tasks = [
    () => Promise.reject(new Error("boom")),
  ];
  await runSlidingWindow(tasks, 1, (index, result) => {
    completed.push({ index, result });
  });
  assert.equal(completed.length, 1, "onComplete should fire once for the rejected task");
  assert.equal(completed[0].index, 0);
  assert.equal(completed[0].result.status, "rejected");
  assert.equal(completed[0].result.reason.message, "boom");
});

test("handles invalid concurrency (zero and negative values)", async () => {
  // With concurrency=0: Math.min(0, N) = 0, so no initial runners are launched.
  // The results array is pre-allocated to length N but all entries stay undefined.
  const tasks = [() => Promise.resolve("x"), () => Promise.resolve("y")];

  const zero = await runSlidingWindow(tasks, 0);
  assert.equal(zero.results.length, 2, "results array should have length equal to task count");
  assert.equal(zero.results[0], undefined, "no tasks should execute with concurrency=0");
  assert.equal(zero.results[1], undefined, "no tasks should execute with concurrency=0");

  const neg = await runSlidingWindow(tasks, -1);
  assert.equal(neg.results.length, 2, "results array should have length equal to task count");
  assert.equal(neg.results[0], undefined, "no tasks should execute with concurrency=-1");
  assert.equal(neg.results[1], undefined, "no tasks should execute with concurrency=-1");
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
  assert.ok(start2Idx > end0Idx, "task 2 should start after task 0 ends");
  assert.ok(start2Idx < end1Idx, "task 2 should start before task 1 ends (sliding behavior)");
});
