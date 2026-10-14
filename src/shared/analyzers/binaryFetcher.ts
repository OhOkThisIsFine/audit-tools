// sites-pinned: tests/shared/binary-fetcher.test.ts
import type { BinaryFetcher } from "./binaryAcquisition.js";

/** Response-owning transport. Cancellation requests are bounded, never cleanup awaits. */
export const defaultBinaryFetcher: BinaryFetcher = async (url, parentSignal) => {
  const controller = new AbortController();
  let interested = true;
  let response: Response | undefined;
  let consumed = false;
  const disposed = new WeakSet<Response>();
  const abortError = (): Error => new Error("binary request aborted");
  const dispose = (value: Response): void => {
    if (disposed.has(value)) return;
    disposed.add(value);
    controller.abort();
    try {
      if (value.body && !value.body.locked) {
        // Observe immediately, including noncooperating cancellation promises.
        void value.body.cancel().catch(() => undefined);
      }
    } catch { /* Disposal must not manufacture an unhandled rejection. */ }
  };
  let rejectAbort: (reason: Error) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // Attach before any synchronously delivered parent abort.
  void aborted.catch(() => undefined);
  const onAbort = (): void => {
    interested = false;
    controller.abort();
    if (response && !consumed) dispose(response);
    rejectAbort(abortError());
  };
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (parentSignal?.aborted) onAbort();
    if (!interested) throw abortError();
    const pending = Promise.resolve().then(() => {
      if (!interested) throw abortError();
      return fetch(url, { signal: controller.signal });
    });
    // The observer owns late headers even after this adapter has returned.
    void pending.then(value => {
      response = value; // Own headers even if abort wins before the awaiting continuation.
      if (!interested) dispose(value);
    }, () => undefined);
    response = await Promise.race([pending, aborted]);
    if (!interested) { dispose(response); throw abortError(); }
    if (!response.ok) { dispose(response); return null; }
    const body = response.arrayBuffer();
    void body.then(() => undefined, () => undefined);
    const bytes = await Promise.race([body, aborted]);
    if (!interested) throw abortError();
    consumed = true;
    return new Uint8Array(bytes);
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    return null;
  } finally {
    interested = false;
    if (response && !consumed) dispose(response);
    parentSignal?.removeEventListener("abort", onAbort);
  }
};
