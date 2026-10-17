/**
 * allowlisted-exec-runner-internals.test.ts — the internal allowlist gate
 * (CP-NODE-4 obligation 1 / invariants[2]) and the runner's timeout/kill
 * escalation, exercised with a FULLY MOCKED `node:child_process` so:
 *   - a refused command's "no spawn occurred" claim is verifiable directly
 *     (the RED case, pre-fix, actually called `spawn`; the GREEN case never
 *     does), rather than inferred indirectly from timing or exit codes;
 *   - the SIGTERM→SIGKILL timeout escalation is deterministic (fake timers),
 *     not dependent on a real slow child process.
 *
 * This file is kept separate from allowlisted-exec.test.ts, which needs REAL
 * spawns for its other assertions — `vi.mock("node:child_process")` is
 * file-scoped, so a file that needs both would have to fake every spawn.
 */
import { test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { delimiter, isAbsolute, join } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const spawnCalls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
let currentChild: any = null;

function makeControllableChild(): any {
  const child: any = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.__closed = false;
  child.once("close", () => { child.__closed = true; });
  const killCalls: string[] = [];
  child.__killCalls = killCalls;
  child.kill = (signal?: string) => {
    killCalls.push(signal ?? "SIGTERM");
    child.killed = true;
    return true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  child.stdout.destroy = vi.fn();
  child.stderr.destroy = vi.fn();
  return child;
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    currentChild = makeControllableChild();
    return currentChild;
  },
}));
vi.mock("../../src/shared/tooling/ownedProcessLifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/shared/tooling/ownedProcessLifecycle.js")>(),
  spawnOwnedProcess: (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command: argv[0]!, args: argv.slice(1), env: options.env });
    const child = currentChild = makeControllableChild();
    return { child, terminate: (signal: string) => child.kill(signal), release: vi.fn(), rootExited: () => false, rootStatus: () => null, rootSignal: () => null, cleanup: (incomplete: boolean) => ({ scope: "process_group", root_exit_observed: false, stdio_incomplete: incomplete, cleanup_verified: child.__closed }) };
  },
}));

const { runAllowlistedReadOnlyCommand, ALLOWLISTED_EXEC_TIMEOUT_MS } = await import(
  "../../src/shared/tooling/allowlistedExec.js"
);

beforeEach(() => {
  spawnCalls.length = 0;
  currentChild = null;
});

test("admitted Git uses an absolute identity and discards inherited executable configuration", async () => {
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "./inert-marker");
  vi.stubEnv("GIT_EXTERNAL_DIFF", "./inert-marker");
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.fsmonitor=./inert-marker'");
  vi.stubEnv("GIT_EXEC_PATH", "./inert-marker");
  vi.stubEnv("Git_TRACE", "./inert-trace");
  vi.stubEnv("PAGER", "./inert-marker");
  try {
    const pending = runAllowlistedReadOnlyCommand(["git", "status", "--short"], process.cwd(), 1000);
    currentChild?.emit("close", 0);
    await pending;
    expect(spawnCalls).toHaveLength(1);
    expect(isAbsolute(spawnCalls[0]!.command)).toBe(true);
    expect(spawnCalls[0]!.env?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(spawnCalls[0]!.env?.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(spawnCalls[0]!.env?.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(spawnCalls[0]!.env?.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(spawnCalls[0]!.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(spawnCalls[0]!.env?.GIT_EXEC_PATH).toBeUndefined();
    expect(spawnCalls[0]!.env?.Git_TRACE).toBeUndefined();
    expect(spawnCalls[0]!.env?.GIT_PAGER).toBe("cat");
    expect(spawnCalls[0]!.args[0]).toBe("--no-lazy-fetch");
    expect(spawnCalls[0]!.args).toContain("--no-pager");
    expect(spawnCalls[0]!.args).toContain("core.fsmonitor=false");
    expect(spawnCalls[0]!.args).toContain("format.pretty=format:%h %s");
    expect(spawnCalls[0]!.args).toContain("log.showSignature=false");
  } finally { vi.unstubAllEnvs(); }
});

function identityFixture(): { root: string; repo: string; sub: string; trusted: string; native: string } {
  const root = mkdtempSync(join(tmpdir(), "inspection-identity-"));
  const repo = join(root, "repo"), sub = join(repo, "src"), trusted = join(root, "trusted");
  for (const dir of [join(repo, ".git"), sub, trusted]) mkdirSync(dir, { recursive: true });
  const native = join(trusted, process.platform === "win32" ? "git.exe" : "git");
  writeFileSync(native, "inert fixture; spawn is mocked");
  chmodSync(native, 0o755);
  return { root, repo, sub, trusted, native };
}

for (const logicalName of ["rg", "ripgrep"]) {
  test(`ambient config is disabled before user args for ${logicalName}`, async () => {
    const fixture = identityFixture();
    const native = join(fixture.trusted, logicalName + (process.platform === "win32" ? ".EXE" : ""));
    const command = [logicalName, "needle", "src"];
    try {
      writeFileSync(native, "inert native candidate; spawn is mocked");
      chmodSync(native, 0o755);
      vi.stubEnv("PATH", fixture.trusted);
      vi.stubEnv("RIPGREP_CONFIG_PATH", "inert-config");
      vi.stubEnv("Ripgrep_Config_Path", "inert-config");
      const pending = runAllowlistedReadOnlyCommand(command, fixture.sub, 1000);
      currentChild?.emit("close", 0);
      expect(await pending).toMatchObject({ exit_code: 0 });
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.command).toBe(realpathSync(native));
      expect(spawnCalls[0]!.args).toEqual(["--no-config", "needle", "src"]);
      expect(Object.keys(spawnCalls[0]!.env!).some(key => key.toUpperCase() === "RIPGREP_CONFIG_PATH")).toBe(false);
      expect(process.env.RIPGREP_CONFIG_PATH).toBe("inert-config");
      expect(command).toEqual([logicalName, "needle", "src"]);
    } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test("ordinary external installation symlinks retain trusted identity", async () => {
  const fixture = identityFixture();
  try {
    const installation = join(fixture.root, "installation");
    mkdirSync(installation);
    const installed = join(installation, process.platform === "win32" ? "git.EXE" : "git");
    writeFileSync(installed, "inert installation; spawn is mocked");
    chmodSync(installed, 0o755);
    rmSync(fixture.native);
    if (process.platform === "win32") {
      rmSync(fixture.trusted, { recursive: true });
      symlinkSync(installation, fixture.trusted, "junction");
    } else symlinkSync(installed, fixture.native);
    vi.stubEnv("PATH", fixture.trusted);
    const pending = runAllowlistedReadOnlyCommand(["git", "status"], fixture.sub, 1000);
    currentChild?.emit("close", 0);
    expect(await pending).toMatchObject({ exit_code: 0 });
    expect(spawnCalls[0]!.command).toBe(realpathSync(installed));
  } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("resolution skips repository roots, empty/relative PATH, caller cwd and physical directory aliases", async () => {
  const fixture = identityFixture();
  try {
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.repo, alias, process.platform === "win32" ? "junction" : "dir");
    const bait = join(fixture.repo, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(bait, "inert repository candidate");
    chmodSync(bait, 0o755);
    vi.stubEnv("PATH", [fixture.repo, "", ".", "relative", process.cwd(), alias, fixture.trusted].join(delimiter));
    vi.stubEnv("PATHEXT", ".CMD;.BAT;.EXE");
    vi.stubEnv("ComSpec", join(fixture.repo, "inert-cmd.exe"));
    const pending = runAllowlistedReadOnlyCommand(["git.cmd", "status", "--short"], fixture.sub, 1000);
    currentChild?.emit("close", 0);
    expect(await pending).toMatchObject({ exit_code: 0 });
    expect(spawnCalls).toHaveLength(1);
    expect(process.platform === "win32" ? spawnCalls[0]!.command.toLowerCase() : spawnCalls[0]!.command)
      .toBe(process.platform === "win32" ? realpathSync(fixture.native).toLowerCase() : realpathSync(fixture.native));
    expect(spawnCalls[0]!.env?.PATH).toBe(realpathSync(fixture.trusted));
  } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("an external executable symlink into the repository cannot establish identity", async () => {
  const fixture = identityFixture();
  try {
    const baitDir = join(fixture.root, "bait");
    mkdirSync(baitDir);
    const bait = join(fixture.repo, "git");
    writeFileSync(bait, "inert");
    chmodSync(bait, 0o755);
    // Windows directory junctions cover aliasing without requiring symlink privilege.
    if (process.platform === "win32") {
      const linked = join(baitDir, "linked");
      symlinkSync(fixture.repo, linked, "junction");
      vi.stubEnv("PATH", linked);
    } else {
      symlinkSync(bait, join(baitDir, "git"));
      vi.stubEnv("PATH", baitDir);
    }
    const outcome = await runAllowlistedReadOnlyCommand(["git", "status"], fixture.sub, 1000);
    expect(outcome.spawn_error).toMatch(/trusted native/);
    expect(outcome.refused).toBeUndefined();
    expect(spawnCalls).toHaveLength(0);
  } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("shim-only or absent installations fail availability without a shell spawn", async () => {
  const fixture = identityFixture();
  try {
    rmSync(fixture.native);
    writeFileSync(join(fixture.trusted, "git.cmd"), "@echo inert");
    writeFileSync(join(fixture.trusted, "git.bat"), "@echo inert");
    vi.stubEnv("PATH", process.platform === "win32" ? '"' + fixture.trusted + '"' : fixture.trusted);
    vi.stubEnv("PATHEXT", ".CMD;.BAT");
    const outcome = await runAllowlistedReadOnlyCommand(["git", "status"], fixture.sub, 1000);
    expect(outcome.spawn_error).toMatch(/trusted native/);
    expect(spawnCalls).toHaveLength(0);
  } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("inspection from inside a bare repository excludes executables elsewhere in that repository", async () => {
  const fixture = identityFixture();
  try {
    rmSync(join(fixture.repo, ".git"), { recursive: true });
    writeFileSync(join(fixture.repo, "HEAD"), "ref: refs/heads/main\n");
    const objects = join(fixture.repo, "objects");
    const bin = join(fixture.repo, "bin");
    for (const path of [objects, bin, join(fixture.repo, "refs")]) mkdirSync(path);
    writeFileSync(join(bin, process.platform === "win32" ? "git.exe" : "git"), "inert bare repository candidate");
    vi.stubEnv("PATH", [bin, fixture.trusted].join(delimiter));
    const pending = runAllowlistedReadOnlyCommand(["git", "status"], objects, 1000);
    currentChild?.emit("close", 0);
    expect(await pending).toMatchObject({ exit_code: 0 });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.env?.PATH).toBe(realpathSync(fixture.trusted));
  } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("inspection inside ordinary .git metadata still excludes the enclosing worktree", async () => {
  const fixture = identityFixture();
  try {
    const metadata = join(fixture.repo, ".git");
    const objects = join(metadata, "objects");
    for (const path of [objects, join(metadata, "refs")]) mkdirSync(path);
    writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    vi.stubEnv("PATH", [fixture.repo, fixture.trusted].join(delimiter));
    writeFileSync(join(fixture.repo, process.platform === "win32" ? "git.exe" : "git"), "inert worktree candidate");
    const pending = runAllowlistedReadOnlyCommand(["git", "status"], objects, 1000);
    currentChild?.emit("close", 0);
    expect(await pending).toMatchObject({ exit_code: 0 });
    expect(spawnCalls[0]!.env?.PATH).toBe(realpathSync(fixture.trusted));
  } finally { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); }
});

// ── CRIT: a refused command must NEVER reach spawn ─────────────────────────

test("CRIT internal gate: a refused ANCHOR argv with NO prior caller-side check resolves a structured refusal and NEVER spawns", async () => {
  // rg --pre is on the adversarial-refusal list (preprocessor exec) — this is
  // called DIRECTLY, with no isAllowedAnchorCommand() call first, unlike a
  // caller-gated path.
  const outcome = await runAllowlistedReadOnlyCommand(
    ["rg", "--pre", "x"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(spawnCalls.length, "a refused command must never reach child_process.spawn").toBe(0);
  expect(outcome.refused).toBe(true);
  expect(outcome.exit_code).toBe(null);
  expect(outcome.timed_out).toBe(false);
  expect(outcome.spawn_error, "a refusal is not a spawn error").toBe(undefined);
});

test("CRIT internal gate: a non-allowlisted executable resolves a structured refusal and NEVER spawns", async () => {
  const outcome = await runAllowlistedReadOnlyCommand(
    ["node", "-e", "1"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(spawnCalls.length).toBe(0);
  expect(outcome.refused).toBe(true);
});

for (const command of [
  ["./untrusted/git", "status"],
  ["C:\\untrusted\\git.exe", "status"],
  ["git", "-ccore.fsmonitor=./payload", "status"],
  ["git", "log", "-o/tmp/report"],
  ["git", "diff", "--textconv"],
]) {
  test(`public refusal never reaches injected spawn: ${JSON.stringify(command)}`, async () => {
    const pending = runAllowlistedReadOnlyCommand(command, process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
    // Settle an incorrectly admitted mock too, so the baseline red leaves no timer.
    currentChild?.emit("close", 0);
    const outcome = await pending;
    expect(spawnCalls).toHaveLength(0);
    expect(outcome).toMatchObject({ refused: true, timed_out: false, exit_code: null, output: "" });
  });
}

test("an ALLOWED command still reaches spawn (the gate does not over-refuse)", async () => {
  const promise = runAllowlistedReadOnlyCommand(
    ["git", "log"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  // Let the mocked spawn run synchronously, then settle the child cleanly.
  await Promise.resolve();
  expect(spawnCalls.length, "an allowed command must reach spawn").toBe(1);
  currentChild.emit("close", 0);
  const outcome = await promise;
  expect(outcome.refused).not.toBe(true);
  expect(outcome.exit_code).toBe(0);
});

// ── truncation signal (CP-NODE-8) ───────────────────────────────────────────
// MAX_CAPTURED_OUTPUT (allowlistedExec.ts) is 256 * 1024 and is not exported;
// mirrored here as a documented constant since these tests drive the cap via
// mocked stdout/stderr chunk sizes rather than importing it.
const MAX_CAPTURED_OUTPUT = 256 * 1024;

test("output past the cap sets truncated:true on close (a genuinely dropped chunk)", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  // First chunk fills the cap exactly — nothing lost yet.
  child.stdout.emit("data", "a".repeat(MAX_CAPTURED_OUTPUT));
  // Second chunk arrives once the cap is already reached — genuinely dropped.
  child.stdout.emit("data", "overflow");
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.output.length).toBe(MAX_CAPTURED_OUTPUT);
  expect(outcome.truncated).toBe(true);
});

test("output past the cap sets truncated:true on spawn_error too", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  child.stdout.emit("data", "a".repeat(MAX_CAPTURED_OUTPUT));
  child.stdout.emit("data", "overflow");
  child.emit("error", new Error("spawn failed"));

  const outcome = await promise;
  expect(outcome.spawn_error).toBe("spawn failed");
  expect(outcome.truncated).toBe(true);
});

test("output under the cap leaves truncated falsy, including a single chunk that lands exactly on the cap", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  // A single chunk that pushes output to exactly the cap in one shot loses
  // nothing — must NOT set truncated.
  child.stdout.emit("data", "a".repeat(MAX_CAPTURED_OUTPUT));
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.output.length).toBe(MAX_CAPTURED_OUTPUT);
  expect(outcome.truncated).toBeFalsy();
});

test("small output well under the cap leaves truncated falsy", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  child.stdout.emit("data", "hello");
  child.stderr.emit("data", "world");
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.output).toBe("helloworld");
  expect(outcome.truncated).toBeFalsy();
});

// ── SIGTERM → SIGKILL escalation at the documented offsets ─────────────────

test("a slow (admitted) child is SIGTERM'd at timeoutMs then SIGKILL'd after the grace period, with timed_out:true", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  try {
    const timeoutMs = 5_000;
    const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), timeoutMs);
    // Let the mocked spawn run (it's called synchronously inside the executor).
    await Promise.resolve();
    expect(spawnCalls.length).toBe(1);
    const child = currentChild;

    // Not yet at the timeout: no kill signal sent.
    vi.advanceTimersByTime(timeoutMs - 1);
    expect(child.__killCalls).toEqual([]);

    // Exactly at the documented timeoutMs offset: SIGTERM fires.
    vi.advanceTimersByTime(1);
    expect(child.__killCalls).toEqual(["SIGTERM"]);

    // Documented SIGKILL_GRACE_MS offset (allowlistedExec.ts) is 2_000ms after
    // SIGTERM; short of it, no escalation yet.
    vi.advanceTimersByTime(1_999);
    expect(child.__killCalls).toEqual(["SIGTERM"]);

    // Exactly at the grace offset: SIGKILL escalation fires.
    vi.advanceTimersByTime(1);
    expect(child.__killCalls).toEqual(["SIGTERM", "SIGKILL"]);

    // The child eventually closes (as if SIGKILL took effect) — outcome
    // reports timed_out:true regardless of the reported exit code.
    child.emit("close", null);
    const outcome = await promise;
    expect(outcome.timed_out).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("missing close after timeout is terminal and ignores later output/error races", async () => {
  vi.useFakeTimers();
  try {
    const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), 20);
    const child = currentChild;
    child.stdout.emit("data", "partial");
    await vi.advanceTimersByTimeAsync(3020);
    const outcome = await promise;
    expect(outcome).toMatchObject({ timed_out: true, output: "partial", exit_code: null, cleanup: { stdio_incomplete: true, cleanup_verified: false } });
    expect(outcome.spawn_error).toBeUndefined();
    expect(outcome.refused).toBeUndefined();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    child.stdout.emit("data", "late");
    child.emit("error", new Error("late error"));
    child.emit("close", 0);
    expect(await promise).toBe(outcome);
    expect(outcome.output).toBe("partial");
  } finally { vi.useRealTimers(); }
});
