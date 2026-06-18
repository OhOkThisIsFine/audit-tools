export interface SlidingWindowResult<T> {
  results: PromiseSettledResult<T>[];
}

export async function runSlidingWindow<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onComplete?: (index: number, result: PromiseSettledResult<T>) => void,
): Promise<SlidingWindowResult<T>> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runOne(index: number): Promise<void> {
    let result: PromiseSettledResult<T>;
    try {
      const value = await tasks[index]();
      result = { status: "fulfilled", value };
    } catch (reason) {
      result = { status: "rejected", reason };
    }
    results[index] = result;
    onComplete?.(index, result);

    if (nextIndex < tasks.length) {
      const next = nextIndex++;
      await runOne(next);
    }
  }

  const initialBatch = Math.min(concurrency, tasks.length);
  const runners: Promise<void>[] = [];
  for (let i = 0; i < initialBatch; i++) {
    const idx = nextIndex++;
    runners.push(runOne(idx));
  }

  await Promise.all(runners);
  return { results };
}
