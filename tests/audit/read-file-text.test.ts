import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.js";
import { defaultReadFileText } from "../../src/audit/extractors/readFileText.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const root = scratchDir("read-file-text");
beforeEach(async () => {
  vi.mocked(open).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open);
  vi.mocked(open).mockClear();
  await mkdir(root, { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function fakeHandle(data: Buffer, options: {
  size?: number; regular?: boolean; steps?: number[]; statError?: boolean;
  readErrorAt?: number; closeError?: boolean;
} = {}) {
  let offset = 0;
  const requests: Array<{ length: number; before: number; bufferLength: number }> = [];
  const handle = {
    stat: vi.fn(async () => {
      if (options.statError) throw new Error("stat");
      return { size: options.size ?? data.length, isFile: () => options.regular ?? true };
    }),
    read: vi.fn(async (buffer: Buffer, start: number, length: number, position: null) => {
      expect(position).toBeNull();
      requests.push({ length, before: offset, bufferLength: buffer.length });
      if (requests.length === options.readErrorAt) throw new Error("read");
      const bytesRead = Math.min(length, options.steps?.[requests.length - 1] ?? length, data.length - offset);
      data.copy(buffer, start, offset, offset + bytesRead);
      offset += bytesRead;
      return { bytesRead, buffer };
    }),
    close: vi.fn(async () => { if (options.closeError) throw new Error("close"); }),
  };
  vi.mocked(open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof open>>);
  return { handle, requests, actual: () => offset };
}

for (const [size, cap, accepted] of [[0, 4, true], [3, 4, true], [4, 4, true], [5, 4, false], [0, 0, true], [1, 0, false], [4, 4.9, true], [5, 4.9, false], [0, -0, true]] as const) {
  test(`real file ${size} bytes with cap ${cap}`, async () => {
    const bytes = Buffer.alloc(size, 65);
    const file = join(root, "input");
    await writeFile(file, bytes);
    expect(await defaultReadFileText(file, cap)).toBe(accepted ? bytes.toString("utf8") : undefined);
  });
}
test.each([-1, NaN, Infinity, -Infinity])("invalid limit %s never opens", async (cap) => {
  vi.mocked(open).mockClear();
  expect(await defaultReadFileText("unused", cap)).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});
test("missing file and directory resolve undefined; regular file accepts a large limit", async () => {
  expect(await defaultReadFileText(join(root, "absent"), 9)).toBeUndefined();
  expect(await defaultReadFileText(root, 9)).toBeUndefined();
  const file = join(root, "input");
  await writeFile(file, "ok");
  expect(await defaultReadFileText(file, Number.MAX_VALUE)).toBe("ok");
});
test("native file links: regular symlink remains readable", async (ctx) => {
  const file = join(root, "input");
  await writeFile(file, "ok");
  // Probe only Windows file-symlink capability; all other errors still fail.
  if (process.platform === "win32") {
    const probe = join(root, "file-symlink-capability");
    let unavailable = false;
    try {
      await symlink(file, probe, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      unavailable = true;
    } finally {
      await rm(probe, { force: true });
    }
    // Mark pending only after cleanup succeeds, so cleanup failures still fail.
    if (unavailable)
      ctx.skip(true, "Native Windows file-symlink capability unavailable (EPERM); symlink readability is unverified on this host");
  }
  await symlink(file, join(root, "link"));
  expect(await defaultReadFileText(join(root, "link"), 2)).toBe("ok");
});
for (const bytes of [Buffer.from("\ufeffBOM\0\r\nno final newline"), Buffer.from([0x41, 0xff, 0xe2, 0x82]), Buffer.from("A".repeat(65535) + "€Z")]) {
  test(`whole-buffer UTF-8 semantics for ${bytes.length} bytes`, async () => {
    const file = join(root, "input");
    await writeFile(file, bytes);
    expect(await defaultReadFileText(file, bytes.length)).toBe(bytes.toString("utf8"));
  });
}
test.each([
  { label: "short reads", data: "ABCD", cap: 4, steps: [1, 3, 0], result: "ABCD", calls: 3 },
  { label: "growth sentinel", data: "ABCDE", cap: 4, steps: [1, 4], result: undefined, calls: 2 },
  { label: "exact cap still probes EOF", data: "ABCD", cap: 4, steps: [4, 0], result: "ABCD", calls: 2 },
  { label: "zero cap probes content", data: "A", cap: 0, steps: [1], result: undefined, calls: 1 },
])("$label", async ({ data, cap, steps, result, calls }) => {
  const mock = fakeHandle(Buffer.from(data), { size: 0, steps });
  expect(await defaultReadFileText("fake", cap)).toBe(result);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenLastCalledWith("fake", "r");
  expect(mock.handle.stat).toHaveBeenCalledTimes(1);
  expect(mock.handle.close).toHaveBeenCalledTimes(1);
  expect(mock.requests).toHaveLength(calls);
  expect(mock.actual()).toBeLessThanOrEqual(cap + 1);
  for (const request of mock.requests) {
    expect(request.length).toBeGreaterThan(0);
    expect(request.length).toBeLessThanOrEqual(Math.min(65536, cap - request.before + 1));
    expect(request.bufferLength).toBeLessThanOrEqual(65536);
  }
});
test.each([Buffer.from("A€Z"), Buffer.from([0xe2, 0xff, 0x82, 0xe2, 0x82])])("one-byte short reads decode together", async (data) => {
  const mock = fakeHandle(data, { steps: Array<number>(data.length).fill(1) });
  expect(await defaultReadFileText("fake", data.length)).toBe(data.toString("utf8"));
  expect(mock.handle.close).toHaveBeenCalledTimes(1);
});
test.each([{ regular: false }, { size: 100 }, { statError: true }])("stat admission rejects without content IO: %j", async (options) => {
  const mock = fakeHandle(Buffer.from("ok"), options);
  expect(await defaultReadFileText("fake", 2)).toBeUndefined();
  expect(mock.handle.read).not.toHaveBeenCalled();
  expect(mock.handle.close).toHaveBeenCalledTimes(1);
});
test.each([{ readErrorAt: 1 }, { readErrorAt: 2, steps: [1] }, { closeError: true }, { closeError: true, regular: false }, { closeError: true, readErrorAt: 1 }])("IO failure resolves undefined and closes once: %j", async (options) => {
  const mock = fakeHandle(Buffer.from("ok"), options);
  await expect(defaultReadFileText("fake", 2)).resolves.toBeUndefined();
  expect(mock.handle.close).toHaveBeenCalledTimes(1);
});
test("open failure has no handle to close", async () => {
  const mock = fakeHandle(Buffer.from("ok"));
  vi.mocked(open).mockRejectedValue(new Error("open"));
  await expect(defaultReadFileText("fake", 2)).resolves.toBeUndefined();
  expect(mock.handle.close).not.toHaveBeenCalled();
});
test("buffer construction failure still awaits close", async () => {
  const mock = fakeHandle(Buffer.from("ok"));
  vi.spyOn(Buffer, "concat").mockImplementationOnce(() => { throw new Error("buffer"); });
  await expect(defaultReadFileText("fake", 2)).resolves.toBeUndefined();
  expect(mock.handle.close).toHaveBeenCalledTimes(1);
});
test("success waits for close settlement", async () => {
  const mock = fakeHandle(Buffer.alloc(0));
  let release!: () => void;
  const closing = new Promise<void>((resolve) => { release = resolve; });
  mock.handle.close.mockImplementation(() => closing);
  let settled = false;
  const result = defaultReadFileText("fake", 0).then((value) => { settled = true; return value; });
  await vi.waitFor(() => expect(mock.handle.close).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  release();
  expect(await result).toBe("");
});
