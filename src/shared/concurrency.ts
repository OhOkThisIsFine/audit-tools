/**
 * Run `fn` over `items` with a bounded number of concurrent in-flight calls,
 * preserving input order in the returned results. A small primitive for
 * parallelizing I/O- or process-bound work (e.g. spawning per-finding
 * verification commands at ingest) without launching one task per item at once.
 *
 * - `limit` is clamped to at least 1; with fewer items than the limit, fewer
 *   workers launch. Empty `items` resolves to `[]` with no work started.
 * - **Order-preserving:** `results[i]` is `fn(items[i], i)` regardless of which
 *   call settled first, so output is deterministic.
 * - A rejection from `fn` propagates (rejecting the returned promise) and other
 *   in-flight results are discarded. Callers whose work must not abort the whole
 *   batch should make `fn` non-throwing (return a result that encodes failure).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const cap = Math.max(1, Math.floor(limit));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      // Reserve an index synchronously (single-threaded: no await between the
      // read and the increment, so every worker claims a distinct item).
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workerCount = Math.min(cap, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
