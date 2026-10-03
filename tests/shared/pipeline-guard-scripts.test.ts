/**
 * Guard-script failure classification (COR-85a995a0 / COR-85a995a0-2): the
 * pipeline guard scripts must fail on EVERY non-success —
 * spawn error, non-zero exit status, AND signal termination (spawnSync yields
 * `status: null` with `signal` set).
 */
import { test, expect, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "../helpers/scratch.js";
import type { SpawnSyncReturns } from "node:child_process";
import { runProfiledCommands, toSeconds, npmCommand } from "../../scripts/shared/profile.mjs";

const profileDir = scratchDir("pipeline-guard-profiles");
const summaryPath = join(profileDir, "summary.md");
const outputs = { profileDir, summaryPath };
let nextProfile: string | undefined;
const checkoutProfiles = fileURLToPath(new URL("../../.audit-tools-profile/", import.meta.url));
const fixtureNames = ["test-signal", "test-status", "test-spawn-error", "test-green"];
let priorFiles: Array<{ path: string; content: string | null }> = [];

beforeEach(() => {
  nextProfile = undefined;
  mkdirSync(profileDir, { recursive: true });
  priorFiles = fixtureNames.flatMap((name) => ["latest.json", "history.ndjson"].map((suffix) => {
    const path = join(checkoutProfiles, `${name}-${suffix}`);
    return { path, content: existsSync(path) ? readFileSync(path, "utf8") : null };
  }));
});
afterEach(() => {
  for (const { path, content } of priorFiles) {
    expect(existsSync(path) ? readFileSync(path, "utf8") : null,
      "fixture profiling must leave checkout ledgers unchanged").toBe(content);
  }
  if (!nextProfile) return;
  const record = JSON.parse(readFileSync(join(profileDir, `${nextProfile}-latest.json`), "utf8"));
  expect(record.profile).toBe(nextProfile);
  expect(record.steps.length).toBeGreaterThan(0);
  const history = readFileSync(join(profileDir, `${nextProfile}-history.ndjson`), "utf8").trim().split("\n");
  expect(JSON.parse(history.at(-1)!).profile).toBe(nextProfile);
  expect(readFileSync(summaryPath, "utf8")).toContain(nextProfile);
  nextProfile = undefined;
});

interface FakeSpawnResult {
  status?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: Error;
}

/** Fake spawnSync returning a canned result; records invocations. */
function fakeSpawn(results: FakeSpawnResult[]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  function fn(command: string, args?: readonly string[], options?: any): SpawnSyncReturns<any>;
  function fn(command: string, options?: any): SpawnSyncReturns<any>;
  function fn(command: string, argsOrOptions?: any, _options?: any): SpawnSyncReturns<any> {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    calls.push({ command, args: [...args] });
    const res = results[calls.length - 1];
    return {
      pid: 123,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: res?.status ?? null,
      signal: (res?.signal as NodeJS.Signals) ?? null,
      error: res?.error,
    };
  }
  fn.calls = calls;
  return fn;
}

// ── runProfiledCommands failure classification ────────────────────────────────

test("runProfiledCommands: a signal-terminated step (status null + signal) FAILS, naming the signal", async () => {
  // spawnSync for a child killed by a signal: status is null, signal is set,
  // error is undefined. The old `status ?? (error ? 1 : 0)` mapping classified
  // this as SUCCESS — an OOM-killed or timeout-killed gate step sailed through.
  const spawnImpl = fakeSpawn([{ status: null, signal: "SIGKILL" }]);
  await assert.rejects(
    () =>
      runProfiledCommands(
        (nextProfile = "test-signal"),
        [{ label: "gate", command: "fake-cmd", args: [] }],
        { spawnImpl, ...outputs },
      ),
    (err: any) => {
      expect(String(err.message)).toMatch(/SIGKILL/);
      return true;
    },
    "signal termination must throw, naming the signal",
  );
});

test("runProfiledCommands: a non-zero exit status FAILS fail-fast (later steps never spawn)", async () => {
  const spawnImpl = fakeSpawn([
    { status: 0, signal: null },
    { status: 3, signal: null },
    { status: 0, signal: null }, // must never be reached
  ]);
  await assert.rejects(
    () =>
      runProfiledCommands(
        (nextProfile = "test-status"),
        [
          { label: "ok", command: "a", args: [] },
          { label: "bad", command: "b", args: [] },
          { label: "never", command: "c", args: [] },
        ],
        { spawnImpl, ...outputs },
      ),
    /exited with code 3/,
  );
  expect(spawnImpl.calls.length, "fail-fast: step after the failure must not spawn").toBe(2);
});

test("runProfiledCommands: a spawn error FAILS naming the spawn failure", async () => {
  const spawnImpl = fakeSpawn([{ status: null, signal: null, error: new Error("ENOENT") }]);
  await assert.rejects(
    () =>
      runProfiledCommands(
        (nextProfile = "test-spawn-error"),
        [{ label: "gone", command: "missing", args: [] }],
        { spawnImpl, ...outputs },
      ),
    /failed to spawn.*ENOENT/,
  );
});

test("runProfiledCommands: all-success returns one timed entry per step and throws nothing", async () => {
  const spawnImpl = fakeSpawn([
    { status: 0, signal: null },
    { status: 0, signal: null },
  ]);
  const entries = await runProfiledCommands(
    (nextProfile = "test-green"),
    [
      { label: "one", command: "a", args: [] },
      { label: "two", command: "b", args: [] },
    ],
    { spawnImpl, ...outputs },
  );
  expect(entries.map((e: any) => e.label)).toEqual(["one", "two"]);
  for (const entry of entries) expect(entry.status).toBe(0);
});

test("toSeconds/npmCommand helpers stay stable", () => {
  expect(toSeconds(1234)).toBe(1.2);
  expect(npmCommand()).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
});
