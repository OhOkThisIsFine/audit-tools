import { expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrackedAsync } from "../../src/shared/tooling/exec.js";
import { spawnHidden } from "../helpers/spawn.mjs";

test.each(process.platform === "win32" ? ["both"] : ["stdout", "stderr", "both", "closed"])("an exited root cannot leave an owned deadline waiting on descendant %s", async (stream) => {
  const dir = await mkdtemp(join(tmpdir(), "audit-owned-bound-"));
  const pidFile = join(dir, "grandchild.pid");
  const readyFile = join(dir, "grandchild.ready");
  const root = join(dir, "root.mjs");
  const descendant = `import fs from 'node:fs';process.on('SIGTERM',()=>{});${stream === "stdout" || stream === "both" ? "process.stdout.write('owned stdout\\n');" : "fs.closeSync(1);"}${stream === "stderr" || stream === "both" ? "process.stderr.write('owned stderr\\n');" : "fs.closeSync(2);"}fs.writeFileSync(${JSON.stringify(readyFile)},String(Date.now()));setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000)`;
  const descendantFile = join(dir, "descendant.mjs");
  await writeFile(descendantFile, descendant);
  const helperUrl = new URL("../../dist/shared/tooling/exec.js", import.meta.url).href;
  await writeFile(root, `import {spawnHidden} from ${JSON.stringify(helperUrl)};import fs from 'node:fs';const child=spawnHidden(process.execPath,[${JSON.stringify(descendantFile)}],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(process.argv[2],String(child.pid));child.unref();${stream === "closed" ? "setInterval(()=>{},1000);" : "process.exit(0);"}`);
  // .NET supplies the inherited native capture handles to its descendant;
  // PowerShell writes markers before exiting, as the descendant only holds them.
  const windows = "$ProgressPreference='SilentlyContinue';[Console]::WriteLine('owned stdout');[Console]::Error.WriteLine('owned stderr');$i=New-Object System.Diagnostics.ProcessStartInfo;$i.FileName=$env:FIXTURE_NODE;$i.Arguments='-e \"setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000)\"';$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$p=[System.Diagnostics.Process]::Start($i);[System.IO.File]::WriteAllText($env:FIXTURE_PID_FILE,[string]$p.Id);exit 0";
  const argv = process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windows, "utf16le").toString("base64")]
    : [process.execPath, root, pidFile];
  const control = spawnHidden(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const controlClosed = new Promise<void>((resolve) => control.once("close", () => resolve()));
  let watchdog: NodeJS.Timeout | undefined;
  const start = Date.now();
  const timeout = process.platform === "win32" ? 5_000 : 2_000;
  const terminalLimit = timeout + 5_000;
  const pending = runTrackedAsync(argv, { timeout, env: { ...process.env, FIXTURE_NODE: process.execPath, FIXTURE_PID_FILE: pidFile } });
  try {
    const observed = await Promise.race([
      pending.then((result) => ({ settled: true as const, result })),
      new Promise<{ settled: false }>((resolve) => { watchdog = setTimeout(() => resolve({ settled: false }), terminalLimit); }),
    ]);
    expect(observed.settled, "the declared deadline plus cleanup grace must be terminal").toBe(true);
    if (!observed.settled) return;
    expect((observed.result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(observed.result.cleanup?.root_exit_observed).toBe(true);
    if (process.platform !== "win32") {
      expect(Number(await readFile(readyFile, "utf8")), "descendant installed TERM handler and closed selected pipes before the bound").toBeLessThan(start + timeout);
    }
    if (stream === "closed") expect(observed.result.duration_ms, "capture close must not cancel the two-second KILL escalation").toBeGreaterThanOrEqual(timeout + 2_000);
    if (stream === "stdout" || stream === "both") expect(observed.result.stdout).toContain("owned stdout");
    if (stream === "stderr" || stream === "both") expect(observed.result.stderr).toContain("owned stderr");
    expect(Date.now() - start).toBeLessThan(terminalLimit);
    expect(() => process.kill(control.pid!, 0), "unrelated fixture remains alive").not.toThrow();
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0), "owned grandchild must be gone").toThrow();
  } finally {
    clearTimeout(watchdog);
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    control.kill("SIGKILL");
    await controlClosed;
    await pending;
    await rm(dir, { recursive: true, force: true });
  }
});

test("owned launch preserves argv, cwd, environment, UTF-8 and stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-owned-fidelity-"));
  const input = "stdin\0雪🙂";
  const script = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:process.env.FIXTURE_VALUE,input}));process.stderr.write('é雪🙂');})";
  try {
    const result = await runTrackedAsync([process.execPath, "-e", script, "space argument", 'literal\"quote', "雪"], { cwd: dir, input, timeout: 5_000, env: { ...process.env, FIXTURE_VALUE: "value with spaces" } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ["space argument", 'literal\"quote', "雪"], cwd: dir, env: "value with spaces", input });
    expect(result.stderr).toBe("é雪🙂");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real output overflow keeps ENOBUFS through owned cleanup", async () => {
  const result = await runTrackedAsync([process.execPath, "-e", "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)"], { timeout: 5_000, maxBuffer: 1_024 });
  expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOBUFS");
  expect(result.cleanup?.scope).toBe(process.platform === "win32" ? "windows_job" : "process_group");
});
