/**
 * suite-lock-parity.test.mjs — the running-suite registry has TWO readers and
 * they must agree.
 *
 * `tests/helpers/suiteLock.ts` (TypeScript, imported by vitest's globalSetup)
 * WRITES the registry; `scripts/shared/guard-no-suite-running.mjs` READS it as
 * npm's `prebuild`, which runs before dist/ exists under plain node with no TS
 * loader — so it cannot import the helper and re-declares the derivation. Same
 * constraint as the .claude hooks re-declaring LOOP_CORE_PATTERNS.
 *
 * A drift between them fails OPEN in the worst way: the guard would compute a
 * different lock dir, find it empty, and cheerfully rewrite dist/ underneath a
 * running suite — the exact corruption the guard exists to prevent, with the
 * guard reporting success. So parity is pinned on BEHAVIOUR (the paths each side
 * actually produces), never on matching source text.
 */
import { test, expect, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import {
  suiteLockDir,
  processAlive,
  liveHolders,
  registerSuite,
  SUITE_OWNED_BUILD_ENV,
} from "../helpers/suiteLock.js";

/**
 * CP-NODE-23: `registerSuite` must publish the holder file ATOMICALLY —
 * temp-file-then-rename inside the same holder directory — so a concurrent
 * `liveHolders` reader can never observe an in-flight write at the final path,
 * fail to parse it, and sweep a LIVE holder's registration as stale.
 *
 * Re-running the behavioural parity scenarios does NOT cover this: they stay
 * green when `registerSuite` is reverted to a direct `writeFileSync` (the fix
 * commit says so outright). The property is about the WRITE MECHANISM, so it is
 * pinned by intercepting the `node:fs` calls `registerSuite` actually makes —
 * and by observing the final path at the instant the write returns, which is
 * exactly when a racing reader could look.
 */
const fsTrace = vi.hoisted(() => ({
  calls: [] as { op: "writeFileSync" | "renameSync"; path: string; to?: string }[],
  /** When set, the final holder path is read the moment a write returns. */
  observeAfterWrite: null as string | null,
  /** What the final path held at that instant (`null` = did not exist). */
  observedAfterWrite: undefined as string | null | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: unknown, ...args: unknown[]): void => {
      (actual.writeFileSync as (...values: unknown[]) => void)(path, ...args);
      fsTrace.calls.push({ op: "writeFileSync", path: String(path) });
      if (fsTrace.observeAfterWrite !== null) {
        try {
          fsTrace.observedAfterWrite = actual.readFileSync(fsTrace.observeAfterWrite, "utf8");
        } catch {
          fsTrace.observedAfterWrite = null;
        }
      }
    },
    renameSync: (from: unknown, to: unknown): void => {
      (actual.renameSync as (...values: unknown[]) => void)(from, to);
      fsTrace.calls.push({ op: "renameSync", path: String(from), to: String(to) });
    },
  };
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardPath = join(repoRoot, "scripts", "shared", "guard-no-suite-running.mjs");

test("suite-lock parity: the prebuild guard resolves the SAME lock dir as the TS helper", () => {
  const fromGuard = spawnSync(process.execPath, [guardPath, "--print-lock-dir"], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  expect(fromGuard.status, fromGuard.stderr).toBe(0);
  // If these diverge the guard reads an empty registry and permits a build
  // during a live suite while reporting success.
  expect(fromGuard.stdout.trim()).toBe(suiteLockDir(repoRoot));
});

test("suite-lock parity: the guard exempts a SUITE-OWNED build, whatever the registry says", () => {
  // The dev wrapper auto-rebuilds and several tests spawn it. If the guard
  // blocked those, the suite could not run at all — this very run is a
  // registered holder. The exemption env var is the seam, so its NAME is part of
  // the contract between the TS helper and the plain-node guard.
  expect(SUITE_OWNED_BUILD_ENV).toBe("AUDIT_TOOLS_SUITE_OWNED_BUILD");
  const guard = spawnSync(process.execPath, [guardPath], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, [SUITE_OWNED_BUILD_ENV]: "1" },
  });
  expect(guard.status, guard.stderr).toBe(0);
});

test("CP-NODE-23: registerSuite publishes the holder file by rename, never writing the final path directly", () => {
  // A private, throwaway "checkout root": suiteLockDir hashes it, so this gets
  // its own holder dir under tmpdir and cannot disturb the registry that this
  // very vitest run is a live holder in.
  const fakeRoot = join(dirname(fileURLToPath(import.meta.url)), `atomic-probe-${randomUUID()}`);
  const dir = suiteLockDir(fakeRoot);
  const finalPath = join(dir, `${process.pid}.json`);
  const preexisting = JSON.stringify({ pid: process.pid, startedAt: "1999-01-01T00:00:00.000Z" });
  try {
    mkdirSync(dir, { recursive: true });
    // A prior, complete registration: whatever a racing reader sees at the final
    // path during the next registration must be THIS valid record, never a
    // half-written one and never nothing.
    writeFileSync(finalPath, preexisting, "utf8");

    fsTrace.calls.length = 0;
    fsTrace.observedAfterWrite = undefined;
    fsTrace.observeAfterWrite = finalPath;
    registerSuite(fakeRoot);
    fsTrace.observeAfterWrite = null;

    const writes = fsTrace.calls.filter((c) => c.op === "writeFileSync");
    const renames = fsTrace.calls.filter((c) => c.op === "renameSync");

    expect(writes.length, "registerSuite writes exactly one file").toBe(1);
    // The whole mechanism: the content goes to a TEMP path, not the path readers
    // poll. A direct writeFileSync to finalPath flips this red.
    expect(writes[0].path, "the holder content must not be written straight to the published path").not.toBe(
      finalPath,
    );
    expect(dirname(writes[0].path), "the temp file must sit in the holder dir (same volume ⇒ atomic rename)").toBe(dir);
    expect(renames.length, "the temp file must be published by exactly one rename").toBe(1);
    expect(renames[0].path, "the rename must publish the file that was just written").toBe(writes[0].path);
    expect(renames[0].to, "the rename target is the published holder path").toBe(finalPath);

    // The reader's view at the instant the write returned: still the previous
    // complete record. Under a direct writeFileSync the new content is already
    // visible at the published path mid-registration, so this flips red too.
    expect(
      fsTrace.observedAfterWrite,
      "an in-flight registration must never be visible at the published holder path",
    ).toBe(preexisting);

    // And the end state is a complete, parseable, live registration.
    const published = JSON.parse(readFileSync(finalPath, "utf8")) as { pid: number; startedAt: string };
    expect(published.pid).toBe(process.pid);
    expect(published.startedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(liveHolders(fakeRoot).some((h) => h.pid === process.pid)).toBe(true);
  } finally {
    fsTrace.observeAfterWrite = null;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suite-lock parity: a malformed or dead holder is stale on BOTH sides, never 'live'", () => {
  // A null/NaN/negative pid must not read as a live process. An earlier revision
  // returned true for these, so a corrupt entry wedged every later build.
  for (const bogus of [null, undefined, NaN, 0, -1, "1234", {}]) {
    expect(processAlive(bogus), `${String(bogus)} must not read as alive`).toBe(false);
  }
  expect(processAlive(process.pid), "our own pid is alive").toBe(true);

  const dir = suiteLockDir(repoRoot);
  const bogusEntry = join(dir, "bogus-parity-probe.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(bogusEntry, "{ not json at all", "utf8");
    // The helper must sweep it rather than count it, and must not throw.
    const holders = liveHolders(repoRoot);
    expect(holders.every((h) => Number.isInteger(h.pid))).toBe(true);

    // And the guard must agree: an unparseable entry is not a running suite, so
    // a build is permitted (exit 0) rather than wedged forever.
    const guard = spawnSync(process.execPath, [guardPath], { encoding: "utf8", cwd: repoRoot });
    expect([0, 1]).toContain(guard.status);
    if (guard.status === 1) {
      // Only acceptable when a REAL concurrent suite is live (this very run does
      // not register itself — globalSetup registers the vitest process, and that
      // is a legitimate holder). Assert it named a live integer pid, not our junk.
      expect(guard.stderr).toMatch(/pid \d+/);
      expect(guard.stderr).not.toMatch(/pid (null|NaN|undefined)/);
    }
  } finally {
    rmSync(bogusEntry, { force: true });
  }
});
