import assert from "node:assert/strict";
import { spawnHidden } from "../helpers/spawn.mjs";
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
  const isLive = (pid: number | undefined) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const eventually = async (predicate: () => boolean, message: string) => {
    const start = Date.now();
    while (!predicate()) {
      assert(Date.now() - start < 20_000, message);
      await delay(50);
    }
  };
  const idle = "setTimeout(() => {}, 60_000)";
  const unrelated = spawnHidden(process.execPath, ["-e", idle], { stdio: "ignore", windowsHide: true });
  let npmPid: number | undefined;
  let owned: number[] = [];
  let npmClosed: Promise<boolean> | undefined;
  let assertionFailure: unknown;
  try {
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
    const koffi = import.meta.resolve("koffi");
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
    const npm = spawnHidden(process.execPath, [npmCli, "test", "--", "sample.test.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let npmOutput = "";
    npm.stdout.on("data", chunk => { npmOutput += chunk; });
    npm.stderr.on("data", chunk => { npmOutput += chunk; });
    npmPid = npm.pid;
    npmClosed = new Promise(resolve => npm.once("close", () => resolve(true)));
    await eventually(() => {
      assert.equal(npm.exitCode, null, npmOutput);
      return existsSync(pids);
    }, "npm test did not reach synthetic Vitest");
    owned = JSON.parse(readFileSync(pids, "utf8"));
    assert(owned.length === 2 && owned.every(isLive));
    assert(isLive(npmPid) && npm.kill("SIGKILL"), "outer npm only must be the killed process");
    await eventually(() => owned.every(pid => !isLive(pid)), "Vitest or its worker remained live after parent-only cancellation");
    expect(isLive(unrelated.pid)).toBe(true);
    expect(existsSync(join(root, ".claude/hooks/.state/suite-green/latest.json"))).toBe(false);
  } catch (error) {
    assertionFailure = error;
    throw error;
  } finally {
    try {
      for (const pid of [npmPid, unrelated.pid, ...owned]) {
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
    }
  }
});
