import { afterEach, expect, test, vi } from "vitest";
import { defaultBinaryFetcher } from "../../src/shared/analyzers/binaryFetcher.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.unstubAllGlobals());

test.each(["resolve", "reject", "throw", "pending", "null"])("non-OK disposal before return: %s", async behavior => {
  const events: string[] = [];
  const body = behavior === "null" ? null : {
    locked: false,
    cancel: () => {
      events.push("cancel");
      if (behavior === "throw") throw new Error("cancel throw");
      if (behavior === "reject") return Promise.reject(new Error("cancel rejected"));
      if (behavior === "pending") return new Promise<void>(() => undefined);
      return Promise.resolve();
    },
  };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    init.signal!.addEventListener("abort", () => events.push("abort"));
    return { ok: false, body, arrayBuffer: () => { throw new Error("must not drain"); } } as unknown as Response;
  });
  expect(await defaultBinaryFetcher("https://example.test/checksum", new AbortController().signal)).toBeNull();
  events.push("return");
  expect(events).toEqual(behavior === "null" ? ["abort", "return"] : ["abort", "cancel", "return"]);
});
test("hanging locked body is aborted, read observed, parent listener removed", async () => {
  const started = deferred<void>();
  const body = deferred<ArrayBuffer>();
  const parent = new AbortController();
  const remove = vi.spyOn(parent.signal, "removeEventListener");
  let requestSignal: AbortSignal | undefined;
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal;
    return { ok: true, body: { locked: true, cancel }, arrayBuffer: () => { started.resolve(); return body.promise; } } as unknown as Response;
  });
  const result = defaultBinaryFetcher("https://example.test/asset", parent.signal);
  await started.promise;
  parent.abort();
  await expect(result).rejects.toThrow("aborted");
  expect(requestSignal!.aborted).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  body.reject(new Error("late body failure"));
  await Promise.resolve();
});
test.each(["fulfill", "reject"])("late noncooperating fetch %s stays disposed", async settlement => {
  const pending = deferred<Response>();
  const started = deferred<void>();
  const parent = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const cancel = vi.fn(async () => undefined);
  const read = vi.fn();
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => { requestSignal = init.signal as AbortSignal; started.resolve(); return pending.promise; });
  const result = defaultBinaryFetcher("https://example.test/checksum", parent.signal);
  await started.promise;
  parent.abort();
  await expect(result).rejects.toThrow("aborted");
  if (settlement === "fulfill") pending.resolve({ ok: true, body: { locked: false, cancel }, arrayBuffer: read } as unknown as Response);
  else pending.reject(new Error("late fetch failure"));
  await Promise.resolve(); await Promise.resolve();
  expect(requestSignal!.aborted).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(settlement === "fulfill" ? 1 : 0);
});
test("already aborted parent starts no fetch; consumed success needs no disposal", async () => {
  const parent = new AbortController(); parent.abort();
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  await expect(defaultBinaryFetcher("https://example.test", parent.signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  const cancel = vi.fn();
  request.mockResolvedValue({ ok: true, body: { locked: false, cancel }, arrayBuffer: async () => new Uint8Array([1, 2]).buffer });
  expect(await defaultBinaryFetcher("https://example.test", new AbortController().signal)).toEqual(new Uint8Array([1, 2]));
  expect(cancel).not.toHaveBeenCalled();
});
test.each(["success", "checksum-non-ok", "payload-non-ok"])("production adapter acquisition: %s", async mode => {
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hashContent } = await import("../../src/shared/hash.js");
  const { resolveBinary } = await import("../../src/shared/analyzers/binaryAcquisition.js");
  const root = mkdtempSync(join(tmpdir(), "adapter-contract-"));
  const payload = new TextEncoder().encode("inert adapter bytes");
  const reads: string[] = []; const cancellations: string[] = []; const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    const checksum = url.endsWith("checksums");
    const ok = !(mode === "checksum-non-ok" && checksum || mode === "payload-non-ok" && !checksum);
    const bytes = checksum ? new TextEncoder().encode(`${hashContent(payload)}  asset`) : payload;
    return { ok, body: { locked: false, cancel: async () => { cancellations.push(url); } },
      arrayBuffer: async () => { reads.push(url); return bytes.buffer; } } as unknown as Response;
  });
  try {
    const result = await resolveBinary({ binaryName: "inert", version: "1.0.0", versionProbeArgs: ["inert"], archived: false,
      assetFor: () => "asset", checksumsAsset: "checksums", releaseUrlForAsset: name => `https://example.test/${name}`,
    }, { cacheDir: root, resolveExecutable: () => null, fetch: defaultBinaryFetcher });
    expect(result.status).toBe(mode === "success" ? "downloaded" : "unavailable");
    expect(requests.length).toBe(mode === "checksum-non-ok" ? 1 : 2);
    expect(reads.length).toBe(mode === "success" ? 2 : mode === "checksum-non-ok" ? 0 : 1);
    expect(cancellations.length).toBe(mode === "success" ? 0 : 1);
    if (mode !== "success") expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("native non-OK Response cancels its never-ending ReadableStream before returning", async () => {
  const events: string[] = [];
  const parent = new AbortController();
  const response = new Response(new ReadableStream<Uint8Array>({
    // Intentionally never enqueue, close or error: draining would hang.
    cancel() { events.push("cancel"); },
  }), { status: 503 });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    init.signal!.addEventListener("abort", () => events.push("abort"), { once: true });
    return response;
  });
  expect(await defaultBinaryFetcher("https://example.test/checksums", parent.signal)).toBeNull();
  events.push("return");
  expect(events).toEqual(["abort", "cancel", "return"]);
  expect(response.body!.locked).toBe(false);
  const reader = response.body!.getReader();
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  reader.releaseLock();
});

test("native hanging Response read receives resolver expiry and restores timer/listener baselines", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveBinary } = await import("../../src/shared/analyzers/binaryAcquisition.js");
  const root = mkdtempSync(join(tmpdir(), "native-body-deadline-"));
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let requestSignal: AbortSignal | undefined;
  let resolverSignal: AbortSignal | undefined;
  const ready = deferred<void>();
  const reading = deferred<void>();
  const events: string[] = [];
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() { events.push("cancel"); },
  }));
  const readBody = response.arrayBuffer.bind(response);
  vi.spyOn(response, "arrayBuffer").mockImplementation(() => {
    const read = readBody(); reading.resolve(); return read;
  });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requestSignal = init.signal as AbortSignal;
    requestSignal.addEventListener("abort", () => {
      events.push("abort");
      // Model cooperative transport cancellation with native stream read failure.
      streamController.error(new Error("transport aborted"));
    }, { once: true });
    ready.resolve();
    return response;
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const timerBaseline = vi.getTimerCount();
  try {
    const result = resolveBinary({ binaryName: "inert", version: "1.0.0", versionProbeArgs: ["inert"], archived: false,
      assetFor: () => "asset", checksumsAsset: "checksums", releaseUrlForAsset: name => `https://example.test/${name}`,
    }, { cacheDir: root, resolveExecutable: () => null, deadline: { at: Date.now() + 1000 },
      fetch: (url, signal) => { resolverSignal = signal; return defaultBinaryFetcher(url, signal); } });
    await ready.promise;
    await reading.promise;
    expect(response.body!.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).reason).toBe("deadline_exceeded");
    expect(requestSignal!.aborted).toBe(true);
    expect(events).toEqual(["abort"]); // A locked native body is aborted, never illegally cancel()ed.
    expect(EventEmitter.getEventListeners(resolverSignal!, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(timerBaseline);
    expect(readdirSync(root)).toEqual([]);
  } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
});

test("a late native Response has one stream disposal owner and is never read", async () => {
  const parent = new AbortController();
  const ready = deferred<void>();
  const pending = deferred<Response>();
  const disposed = deferred<void>();
  let cancels = 0;
  vi.stubGlobal("fetch", () => { ready.resolve(); return pending.promise; });
  const result = defaultBinaryFetcher("https://example.test/checksums", parent.signal);
  await ready.promise; parent.abort();
  await expect(result).rejects.toThrow("aborted");
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancels++; disposed.resolve(); },
  }));
  const read = vi.spyOn(response, "arrayBuffer");
  pending.resolve(response);
  await disposed.promise;
  expect(cancels).toBe(1); expect(read).not.toHaveBeenCalled();
});
