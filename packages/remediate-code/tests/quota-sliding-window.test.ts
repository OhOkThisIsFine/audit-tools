import { describe, it, expect } from "vitest";
import { runSlidingWindow } from "@audit-tools/shared";

describe("runSlidingWindow", () => {
  it("runs all tasks with concurrency limit", async () => {
    const order: number[] = [];
    const tasks = [0, 1, 2, 3, 4].map(
      (i) => () =>
        new Promise<number>((resolve) => {
          order.push(i);
          setTimeout(() => resolve(i), 10);
        }),
    );
    const { results } = await runSlidingWindow(tasks, 2);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
  });

  it("handles empty task list", async () => {
    const { results } = await runSlidingWindow([], 3);
    expect(results).toHaveLength(0);
  });

  it("handles concurrency > task count", async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)];
    const { results } = await runSlidingWindow(tasks, 10);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("captures rejections without stopping", async () => {
    const tasks = [
      () => Promise.resolve("ok"),
      () => Promise.reject(new Error("fail")),
      () => Promise.resolve("also ok"),
    ];
    const { results } = await runSlidingWindow(tasks, 2);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });

  it("calls onComplete callback", async () => {
    const completed: number[] = [];
    const tasks = [() => Promise.resolve("a"), () => Promise.resolve("b")];
    await runSlidingWindow(tasks, 2, (index) => completed.push(index));
    expect(completed.sort()).toEqual([0, 1]);
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const tasks = Array.from({ length: 6 }, () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return concurrent;
    });
    await runSlidingWindow(tasks, 3);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});
