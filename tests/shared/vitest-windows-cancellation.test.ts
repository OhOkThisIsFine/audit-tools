import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFileSyncHidden, spawnHidden } from "../helpers/spawn.mjs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect } from "vitest";
import { isWindowsNpmTest } from "../../scripts/shared/vitest-windows-owner.mjs";

test("the exact Windows npm lifecycle selects the owned suite runner", () => {
  const root = resolve("fixture");
  const lifecycle = { npm_lifecycle_event: "test", npm_package_json: join(root, "package.json") };
  expect(isWindowsNpmTest(root, "win32", lifecycle)).toBe(true);
  expect(isWindowsNpmTest(root, "linux", lifecycle)).toBe(false);
  expect(isWindowsNpmTest(root, "win32", { ...lifecycle, npm_package_json: join(root, "other", "package.json") })).toBe(false);
  expect(isWindowsNpmTest(root, "win32", { ...lifecycle, npm_lifecycle_event: "build" })).toBe(false);
});

const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

test.skipIf(process.platform !== "win32")("terminating only npm ends the exact gate's Vitest tree, not its sibling", async () => {
  assert(existsSync(npmCli), "native fixture requires npm's Node entrypoint");
  const source = resolve(import.meta.dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "vitest-npm-owner-"));
  const pids = join(root, "ready.json");
  const put = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const copy = (path: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(source, path), file);
  };
  // Retain handles to these exact processes. Looking a PID up again while
  // hundreds of other test processes start/exit can observe a different
  // process that reused the PID, and it is not safe to kill that process.
  const { default: koffi } = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const openProcess = kernel.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)");
  const waitForExit = kernel.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)");
  const closeHandle = kernel.func("int __stdcall CloseHandle(void *)");
  const handles = new Map<number, unknown>();
  const track = (pid: number | undefined) => {
    assert(pid, "synthetic child must expose its process id");
    const handle = openProcess(0x00100000, 0, pid); // SYNCHRONIZE only
    assert(handle, `could not observe synthetic process ${pid}`);
    handles.set(pid, handle);
  };
  const isLive = (pid: number | undefined) => {
    const handle = pid === undefined ? undefined : handles.get(pid);
    if (!handle) return false;
    const result = waitForExit(handle, 0);
    assert(result === 0 || result === 258, `unexpected exit wait result for ${pid}: ${result}`);
    return result === 258; // WAIT_TIMEOUT: this exact process is still live
  };
  const eventually = async (predicate: () => boolean, message: () => string) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start >= 20_000) assert.fail(message());
      await delay(50);
    }
  };
  const idle = "setTimeout(() => {}, 60_000)";
  const unrelated = spawnHidden(process.execPath, ["-e", idle], { stdio: "ignore", windowsHide: true });
  let npm: ChildProcess | undefined;
  let owned: number[] = [];
  let npmClosed: Promise<boolean> | undefined;
  let assertionFailure: unknown;
  try {
    track(unrelated.pid);
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    put("package.json", JSON.stringify({
      type: "module", scripts: { test: pkg.scripts.test, build: "node -e 0" },
    }));
    for (const file of [
      "run-vitest-gate.mjs", "vitest-windows-owner.mjs", "vitestShard.mjs", "vitestGateVerdict.mjs",
      "worktree-tree.mjs", "suiteGreenStamp.mjs", "load-flake-record.mjs", "primitives.mjs", "loopCoreAttestationLedger.mjs",
    ]) copy("scripts/shared/" + file);
    copy(".claude/hooks/loop-core-patterns.mjs");
    put("dist/shared/io/fileLock.js", 'export function withFileLock() { throw new Error("unexpected diagnostics"); }');
    for (const file of ["ownedProcessLifecycle.js", "windowsOwnedJob.js"]) copy("dist/shared/tooling/" + file);
    // Keep the native dependency in its normal package root; the isolated fixture
    // re-exports just that runtime dependency, so it cannot resolve real Vitest.
    put("node_modules/koffi/package.json", JSON.stringify({ type: "module", exports: "./index.mjs" }));
    // Ask native Node for the ESM entry. Vitest's transformed import.meta
    // does not implement resolve, and require would pick a different export.
    const koffi = execFileSyncHidden(process.execPath,
      ["--input-type=module", "-e", 'process.stdout.write(import.meta.resolve("koffi"))'],
      { cwd: source, encoding: "utf8" });
    put("node_modules/koffi/index.mjs", `export { default } from ${JSON.stringify(koffi)};`);
    put("node_modules/vitest/package.json", '{"name":"vitest"}');
    put("node_modules/vitest/vitest.mjs", `
      import { spawnHidden } from ${JSON.stringify(new URL("../../dist/shared/tooling/exec.js", import.meta.url).href)};
      import { renameSync, writeFileSync } from 'node:fs';
      const child = spawnHidden(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        writeFileSync('ready.tmp', JSON.stringify([process.pid, child.pid]));
        renameSync('ready.tmp', 'ready.json');
      });
      ${idle};
    `);
    // This is an independent package invocation, not another command in the
    // outer npm test lifecycle. On Windows, Node sorts case variants of env
    // names and passes only the first. An inherited NPM_PACKAGE_JSON or
    // NPM_LIFECYCLE_EVENT would beat the lowercase value nested npm supplies.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^npm_(?:package_|lifecycle_)/i.test(key) &&
      key.toUpperCase() !== "AUDIT_TOOLS_ISOLATED_LOAD_DIAGNOSTIC",
    ));
    npm = spawnHidden(process.execPath, [npmCli, "test", "--", "sample.test.ts"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let npmOutput = "";
    npm.stdout!.on("data", chunk => { npmOutput += chunk; });
    npm.stderr!.on("data", chunk => { npmOutput += chunk; });
    const npmProcess = npm;
    npmClosed = new Promise(resolve => npmProcess.once("close", () => resolve(true)));
    const npmPid = npmProcess.pid;
    track(npmPid);
    await eventually(() => {
      assert.equal(npmProcess.exitCode, null, npmOutput);
      return existsSync(pids);
    }, () => `npm test did not reach synthetic Vitest: ${npmOutput}`);
    owned = JSON.parse(readFileSync(pids, "utf8"));
    assert(owned.length === 2 && owned[0] !== owned[1]);
    owned.forEach(track);
    assert(owned.every(isLive));
    assert(isLive(npmPid) && npmProcess.kill("SIGKILL"), "outer npm only must be the killed process");
    await eventually(() => !isLive(npmPid) && owned.every(pid => !isLive(pid)),
      () => `processes still live after parent-only cancellation: ${[npmPid, ...owned].filter(isLive).join(", ")}. ${npmOutput}`);
    expect(isLive(unrelated.pid)).toBe(true);
    expect(existsSync(join(root, ".claude/hooks/.state/suite-green/latest.json"))).toBe(false);
  } catch (error) {
    assertionFailure = error;
    throw error;
  } finally {
    try {
      for (const child of [npm, unrelated]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      for (const pid of owned) {
        if (pid && isLive(pid)) process.kill(pid, "SIGKILL");
      }
      // npm has already exited, but its inherited pipes can stay open until
      // the shell and gate release the fixture cwd. Wait without tree-killing.
      if (npmClosed) {
        const closed = await Promise.race([npmClosed, delay(5_000, false, { ref: false })]);
        assert(closed, "npm test shell/gate did not close the fixture's inherited pipes");
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      if (assertionFailure) throw new AggregateError([assertionFailure, cleanupError], "Cancellation assertion and fixture cleanup failed");
      throw cleanupError;
    } finally {
      for (const handle of handles.values()) closeHandle(handle);
    }
  }
});
