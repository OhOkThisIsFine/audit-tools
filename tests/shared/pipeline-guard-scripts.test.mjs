/**
 * Guard-script failure classification (COR-85a995a0 / COR-85a995a0-2 /
 * REL-eb3aeddf): the pipeline guard scripts must fail on EVERY non-success —
 * spawn error, non-zero exit status, AND signal termination (spawnSync yields
 * `status: null` with `signal` set) — and `update-models.mjs` must never fire
 * its live network fetch / snapshot write on a `--help` or unknown-arg
 * invocation.
 */
import { test, expect, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../");

const { runProfiledCommands, toSeconds, npmCommand } = await import(
  "../../scripts/shared/profile.mjs"
);

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Fake spawnSync returning a canned result; records invocations. */
function fakeSpawn(results) {
  const calls = [];
  const fn = (command, args) => {
    calls.push({ command, args });
    return results[calls.length - 1];
  };
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
        "test-signal",
        [{ label: "gate", command: "fake-cmd", args: [] }],
        { spawnImpl },
      ),
    (err) => {
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
        "test-status",
        [
          { label: "ok", command: "a", args: [] },
          { label: "bad", command: "b", args: [] },
          { label: "never", command: "c", args: [] },
        ],
        { spawnImpl },
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
        "test-spawn-error",
        [{ label: "gone", command: "missing", args: [] }],
        { spawnImpl },
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
    "test-green",
    [
      { label: "one", command: "a", args: [] },
      { label: "two", command: "b", args: [] },
    ],
    { spawnImpl },
  );
  expect(entries.map((e) => e.label)).toEqual(["one", "two"]);
  for (const entry of entries) expect(entry.status).toBe(0);
});

test("toSeconds/npmCommand helpers stay stable", () => {
  expect(toSeconds(1234)).toBe(1.2);
  expect(npmCommand()).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
});

// ── update-models.mjs invocation guard ───────────────────────────────────────

const UPDATE_MODELS = resolve(REPO_ROOT, "scripts/shared/update-models.mjs");
const SNAPSHOT = resolve(REPO_ROOT, "src/shared/data/model-statics.generated.json");

test("update-models --help prints usage, exits 0, and never fetches or rewrites the snapshot", () => {
  const before = statSync(SNAPSHOT).mtimeMs;
  const beforeContent = readFileSync(SNAPSHOT, "utf8");
  const r = spawnSync(process.execPath, [UPDATE_MODELS, "--help"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, `--help must exit 0\nstdout:${r.stdout}\nstderr:${r.stderr}`).toBe(0);
  expect(r.stdout).toMatch(/[Uu]sage/);
  expect(r.stdout).toMatch(/update-models/);
  // The snapshot must be untouched — a help invocation must never run the
  // networked refresh (REL-eb3aeddf).
  expect(statSync(SNAPSHOT).mtimeMs, "--help must not rewrite the snapshot").toBe(before);
  expect(readFileSync(SNAPSHOT, "utf8")).toBe(beforeContent);
});

test("update-models rejects an unknown argument with a non-zero exit and no snapshot write", () => {
  const before = statSync(SNAPSHOT).mtimeMs;
  const r = spawnSync(process.execPath, [UPDATE_MODELS, "--no-such-flag"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, "unknown args must fail loudly, never silently refresh").not.toBe(0);
  expect(`${r.stderr}${r.stdout}`).toMatch(/--no-such-flag/);
  expect(statSync(SNAPSHOT).mtimeMs, "unknown arg must not rewrite the snapshot").toBe(before);
});
