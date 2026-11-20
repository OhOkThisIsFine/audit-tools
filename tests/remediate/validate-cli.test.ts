import { spawnHidden } from "../helpers/spawn.mjs";
import { once } from "node:events";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../helpers/scratch.js";

const root = scratchDir("validate-cli");
const wrapper = join(root, "remediate-code.mjs");
const require = createRequire(import.meta.url);

afterEach(() => rm(root, { recursive: true, force: true }));

async function exerciseCompiler(outcome: number | "cancel") {
  const dist = join(root, "dist", "remediate");
  await mkdir(dist, { recursive: true });
  await copyFile(new URL("../../remediate-code.mjs", import.meta.url), wrapper);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const source = new URL("../../src/remediate/index.ts", import.meta.url);
  await writeFile(join(dist, "index.js"), `export { program } from ${JSON.stringify(source.href)};`);
  // Substitute only the compiler executable. The public bin, commander action,
  // process ownership, inherited streams and cancellation are production code.
  const preload = join(root, "compiler-fixture.cjs");
  const compiler = join(root, "tsc.cjs");
  await writeFile(compiler, `console.error("compiler inherited caller stamp: " + ("AUDIT_TOOLS_CALLER_CWD" in process.env));
console.error("compiler pid " + process.pid);
process.stdin.once("data", data => process.exit(Number(data.toString())));`);
  await writeFile(preload, `const Module = require("node:module");
const resolve = Module._resolveFilename;
const cp = require("node:child_process");
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (args?.[0] === ${JSON.stringify(compiler)}) console.error("compiler windowsHide: " + options.windowsHide);
  return spawn.apply(this, arguments);
};
Module.syncBuiltinESMExports();
Module._resolveFilename = function(id, ...args) {
  return id === "typescript/bin/tsc" ? ${JSON.stringify(compiler)} : resolve.call(this, id, ...args);
};
if (process.send) {
  process.on("message", () => process.emit("SIGINT"));
  process.channel.unref();
}`);
  const cli = spawnHidden(process.execPath, ["--require", preload, "--import", pathToFileURL(require.resolve("tsx/esm")).href, wrapper, "validate"], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, AUDIT_TOOLS_CALLER_CWD: "caller-stamp" },
  });
  const closed = once(cli, "close");
  const diagnostics = createInterface({ input: cli.stderr! });
  let stdout = "";
  let stderr = "";
  cli.stdout!.on("data", data => { stdout += data.toString(); });
  cli.stderr!.on("data", data => { stderr += data.toString(); });
  let compilerPid: number | undefined;
  try {
    for await (const line of diagnostics) {
      const match = /^compiler pid (\d+)$/.exec(line);
      if (!match) continue;
      compilerPid = Number(match[1]);
      expect(cli.exitCode).toBeNull();
      if (outcome === "cancel") {
        // Windows kill('SIGINT') terminates the target forcibly. Deliver the
        // console interrupt event in that process via the fixture IPC channel.
        if (process.platform === "win32") cli.send("interrupt");
        else cli.kill("SIGINT");
      } else cli.stdin!.end(String(outcome));
      break;
    }
    expect(compilerPid, stderr).toBeDefined();
    const [status] = await closed;
    expect(status).toBe(outcome === "cancel" ? 130 : outcome);
    expect(stderr).toContain("compiler windowsHide: true");
    expect(stderr).toContain("compiler inherited caller stamp: false");
    if (outcome === 0) expect(stdout).toContain("types OK");
    else expect(stderr).toContain("Type check failed.");
    expect(() => process.kill(compilerPid!, 0)).toThrow();
  } finally {
    cli.kill();
    if (compilerPid) {
      try { process.kill(compilerPid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
}

describe("standalone validation", () => {
  it("streams diagnostics from a successful compiler", () => exerciseCompiler(0));
  it("propagates the failing compiler status", () => exerciseCompiler(17));
  it("waits for the compiler to exit on cancellation", () => exerciseCompiler("cancel"));
});
