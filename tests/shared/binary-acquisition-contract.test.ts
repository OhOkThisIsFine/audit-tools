import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { hashContent } from "../../src/shared/hash.js";
import { resolveBinary, type BinaryResolveOptions, type BinarySpec } from "../../src/shared/analyzers/binaryAcquisition.js";
import { parseGitleaksVersion } from "../../src/shared/analyzers/binaryVersions.js";

const faults = vi.hoisted(() => ({ operation: "", published: "", lock: "" }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    chmodSync: (...args: Parameters<typeof original.chmodSync>) => {
      if (faults.operation === "chmod") throw new Error("injected chmod failure");
      return original.chmodSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      if (faults.operation === "manifest" && String(args[0]).endsWith(".audit-tools-binary.json")) throw new Error("injected manifest failure");
      return original.writeFileSync(...args);
    },
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      if (faults.operation === "reread" && String(args[0]).includes(".stage-") && String(args[0]).endsWith(".audit-tools-binary.json")) throw new Error("injected reread failure");
      return original.readFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof original.renameSync>) => {
      if (faults.operation === "rename") throw new Error("injected rename failure");
      original.renameSync(...args);
      faults.published = String(args[1]);
    },
  };
});
vi.mock("../../src/shared/io/fileLock.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/shared/io/fileLock.js")>();
  return { ...original, withFileLock: async (path: string, fn: () => Promise<unknown>, timeout?: number) => {
    if (faults.lock === "timeout") throw new original.FileLockTimeoutError(path);
    const result = await original.withFileLock(path, async () => {
      if (faults.lock === "late-admission") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10000);
      return fn();
    }, timeout);
    if (faults.lock === "release") throw new Error("injected post-publication release failure");
    return result;
  } };
});
let root: string;
const bytes = new TextEncoder().encode("inert binary bytes");
const spec: BinarySpec = {
  binaryName: "gitleaks", version: "8.21.2", versionProbeArgs: ["gitleaks", "version"],
  parseVersion: parseGitleaksVersion, archived: false, assetFor: () => "asset", checksumsAsset: "checksums",
  releaseUrlForAsset: name => `https://example.test/${name}`,
};
function options(overrides: BinaryResolveOptions = {}): BinaryResolveOptions {
  return { cacheDir: root, platform: "linux", arch: "x64", resolveExecutable: () => null,
    fetch: async url => url.endsWith("checksums") ? new TextEncoder().encode(`${hashContent(bytes)}  asset\n`) : bytes,
    ...overrides };
}
beforeEach(() => { faults.operation = ""; faults.published = ""; faults.lock = ""; root = fs.mkdtempSync(join(tmpdir(), "binary-contract-")); });
afterEach(() => { faults.operation = ""; fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); });

test("expired/nonfinite entry starts no lookup, network, cache mutation or probe", async () => {
  const lookup = vi.fn(); const fetch = vi.fn(); const run = vi.fn();
  for (const at of [Date.now() - 1, Infinity, NaN]) {
    const result = await resolveBinary(spec, options({ deadline: { at }, resolveExecutable: lookup, fetch, run }));
    expect(result.reason).toBe(Number.isFinite(at) ? "deadline_exceeded" : "invalid_budget");
  }
  expect(lookup).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual([]);
});
test("first absolute PATH selection is probed once, exact pin reused and stderr cannot authenticate", async () => {
  const run = vi.fn(async (argv: string[]) => ({ argv, status: 0, stdout: "8.21.2\n", stderr: "diagnostic", duration_ms: 0 }));
  const result = await resolveBinary(spec, options({ resolveExecutable: () => "/first space/gitleaks", run }));
  expect(result).toEqual({ status: "path", command: "/first space/gitleaks" });
  expect(run.mock.calls[0][0]).toEqual(["/first space/gitleaks", "version"]);
  expect(fs.readdirSync(root)).toEqual([]);
  run.mockImplementation(async argv => ({ argv, status: 0, stdout: "8.18.4\n", stderr: "8.21.2", duration_ms: 0 }));
  const fallback = await resolveBinary(spec, options({ resolveExecutable: () => "/first space/gitleaks", run }));
  expect(fallback.status).toBe("downloaded"); expect(run).toHaveBeenCalledTimes(2);
});
test.each([null, new Uint8Array(), new TextEncoder().encode("malformed")])("missing or invalid checksum never requests payload", async checksum => {
  const fetch = vi.fn(async () => checksum);
  const result = await resolveBinary(spec, options({ fetch }));
  expect(result.status).toBe("unavailable"); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(root)).toEqual([]); // lock removed; no staging/publication
});
test("v2 identity separates arch, platform, source, asset and archive mode; warm hit uses no network", async () => {
  const first = await resolveBinary(spec, options());
  const fetch = vi.fn(async () => { throw new Error("warm hit must not fetch"); });
  expect((await resolveBinary(spec, options({ fetch }))).command).toBe(first.command);
  expect(fetch).not.toHaveBeenCalled();
  const second = await resolveBinary(spec, options({ arch: "arm64" }));
  const third = await resolveBinary({ ...spec, releaseUrlForAsset: name => `https://other.test/${name}` }, options());
  const fourth = await resolveBinary(spec, options({ platform: "win32" }));
  expect(new Set([first.command, second.command, third.command, fourth.command]).size).toBe(4);
});
test.each(["manifest", "reread", "chmod", "rename"])("mandatory %s failure cleans only own staging", async operation => {
  fs.mkdirSync(join(root, "foreign.stage-canary")); fs.writeFileSync(join(root, "foreign.stage-canary", "keep"), "canary");
  fs.mkdirSync(join(root, "gitleaks-8.21.2")); fs.writeFileSync(join(root, "gitleaks-8.21.2", "keep"), "legacy");
  faults.operation = operation;
  const result = await resolveBinary(spec, options());
  expect(result.reason).toBe("write_failed"); expect(result.command).toBeNull();
  expect(fs.readdirSync(root).sort()).toEqual(["foreign.stage-canary", "gitleaks-8.21.2"]);
  expect(fs.readFileSync(join(root, "foreign.stage-canary", "keep"), "utf8")).toBe("canary");
});
test("offline invalid v2 final is read only, online repairs it while foreign stages remain ignored", async () => {
  const first = await resolveBinary(spec, options());
  fs.writeFileSync(first.command!, "drift");
  const offline = await resolveBinary(spec, options({ fetch: undefined }));
  expect(offline.reason).toBe("offline"); expect(fs.readFileSync(first.command!, "utf8")).toBe("drift");
  expect((await resolveBinary(spec, options())).status).toBe("downloaded");
});
test.skipIf(process.platform === "win32").each(["leaf", "manifest", "directory"])("warm %s symlink rejected without modifying target", async kind => {
  const first = await resolveBinary(spec, options());
  const identityDir = dirname(first.command!);
  const outside = join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "canary"), "safe");
  if (kind === "directory") {
    fs.renameSync(identityDir, join(outside, "identity")); fs.symlinkSync(join(outside, "identity"), identityDir);
  } else {
    const target = kind === "leaf" ? first.command! : join(identityDir, ".audit-tools-binary.json");
    fs.rmSync(target); fs.symlinkSync(join(outside, "canary"), target);
  }
  const result = await resolveBinary(spec, options({ fetch: undefined }));
  expect(result.status).toBe("unavailable"); expect(fs.readFileSync(join(outside, "canary"), "utf8")).toBe("safe");
});
test("archive rejects links, cycles, and a directory named as executable without traversing targets", async () => {
  const outside = join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "canary"), "safe");
  const result = await resolveBinary({ ...spec, archived: true }, options({ run: async argv => {
    const stage = argv[argv.indexOf("-C") + 1];
    fs.mkdirSync(join(stage, "gitleaks"));
    if (process.platform !== "win32") fs.symlinkSync(outside, join(stage, "cycle"));
    return { argv, status: 0, stdout: "", stderr: "", duration_ms: 0 };
  } }));
  expect(result.status).toBe("unavailable"); expect(fs.readFileSync(join(outside, "canary"), "utf8")).toBe("safe");
});
test.each(["fulfill", "reject"])("late byte-only %s cannot write after deadline; not a transport cancellation proof", async mode => {
  let signal: AbortSignal | undefined;
  let finish!: (value: Uint8Array) => void;
  let fail!: (error: Error) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const pending = resolveBinary(spec, options({ deadline: { at: Date.now() + 1000 }, fetch: (_url, received) => {
    signal = received; started(); return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  } }));
  await ready;
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).reason).toBe("deadline_exceeded"); expect(signal!.aborted).toBe(true);
  if (mode === "fulfill") finish(bytes); else fail(new Error("late rejection"));
  await Promise.resolve();
  expect(fs.readdirSync(root)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});
test("expiry between checksum and payload starts no payload", async () => {
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
  let calls = 0;
  try {
    const result = await resolveBinary(spec, options({ deadline: { at: now + 100 }, fetch: async () => {
      calls++; vi.spyOn(Date, "now").mockReturnValue(now + 101);
      return new TextEncoder().encode(`${hashContent(bytes)}  asset`);
    } }));
    expect(result.reason).toBe("deadline_exceeded"); expect(calls).toBe(1);
  } finally { vi.restoreAllMocks(); }
});
test("publication survives a subsequent lock-release failure", async () => {
  faults.lock = "release";
  const first = await resolveBinary(spec, options());
  expect(first.reason).toBe("write_failed");
  expect(faults.published).not.toBe(""); expect(fs.existsSync(faults.published)).toBe(true);
  faults.lock = "";
  const fetch = vi.fn();
  const second = await resolveBinary(spec, options({ fetch }));
  expect(second.status).toBe("cached"); expect(fetch).not.toHaveBeenCalled();
});
test.each(["timeout", "late-admission"])("lock %s cannot admit acquisition work", async mode => {
  faults.lock = mode;
  const fetch = vi.fn();
  const result = await resolveBinary(spec, options({ fetch, deadline: { at: Date.now() + 5000 } }));
  expect(result.reason).toBe("deadline_exceeded"); expect(fetch).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([]);
});
test("cooperative fresh lock contention expires without callback work", async () => {
  const identity = [2, spec.binaryName, spec.version, "linux", "x64", "asset", spec.releaseUrlForAsset("asset"), spec.releaseUrlForAsset("checksums"), false];
  const lock = join(root, hashContent(JSON.stringify(identity)) + ".lock");
  fs.writeFileSync(lock, "other-holder");
  const fetch = vi.fn();
  const result = await resolveBinary(spec, options({ fetch, deadline: { at: Date.now() + 30 } }));
  expect(result.reason).toBe("deadline_exceeded"); expect(fetch).not.toHaveBeenCalled();
  expect(fs.readFileSync(lock, "utf8")).toBe("other-holder");
});
test("stolen token residual is not advertised as ownership fencing", async () => {
  let requests = 0;
  const result = await resolveBinary(spec, options({ fetch: async url => {
    requests++;
    if (requests === 1) {
      const lock = fs.readdirSync(root).find(name => name.endsWith(".lock"))!;
      fs.writeFileSync(join(root, lock), "replacement-holder");
    }
    return url.endsWith("checksums") ? new TextEncoder().encode(`${hashContent(bytes)}  asset`) : bytes;
  } }));
  // Existing shared lock semantics do not cancel a callback after replacement.
  expect(result.status).toBe("downloaded");
  const lock = fs.readdirSync(root).find(name => name.endsWith(".lock"))!;
  expect(fs.readFileSync(join(root, lock), "utf8")).toBe("replacement-holder");
});
test("archive-mode and selected-asset changes do not alias a warm identity", async () => {
  const original = await resolveBinary(spec, options());
  const archive = await resolveBinary({ ...spec, archived: true }, options({ run: async argv => {
    fs.writeFileSync(join(argv[argv.indexOf("-C") + 1], "gitleaks"), bytes);
    return { argv, status: 0, stdout: "", stderr: "", duration_ms: 0 };
  } }));
  const asset = await resolveBinary({ ...spec, assetFor: () => "other-asset" }, options({ fetch: async url =>
    url.endsWith("checksums") ? new TextEncoder().encode(`${hashContent(bytes)}  other-asset`) : bytes }));
  expect(new Set([original.command, archive.command, asset.command]).size).toBe(3);
  expect(archive.status).toBe("downloaded"); expect(asset.status).toBe("downloaded");
});
test("cwd and PATH changes during the probe cannot change absolute selection", async () => {
  const original = process.env.PATH;
  const cwd = process.cwd();
  const lookup = vi.fn((_name: string, captured: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    expect(captured.cwd).toBe(cwd); expect(captured.env?.PATH).toBe(original);
    return "/captured/bin/gitleaks";
  });
  try {
    const result = await resolveBinary(spec, options({ resolveExecutable: lookup, run: async (argv, probeCwd) => {
      expect(probeCwd).toBe(cwd); process.env.PATH = "/changed";
      vi.spyOn(process, "cwd").mockReturnValue("/different");
      return { argv, status: 0, stdout: "8.21.2", stderr: "", duration_ms: 0 };
    } }));
    expect(result.command).toBe("/captured/bin/gitleaks"); expect(lookup).toHaveBeenCalledTimes(1);
  } finally {
    if (original === undefined) delete process.env.PATH; else process.env.PATH = original;
    vi.restoreAllMocks();
  }
});
