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
import { test, expect } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { suiteLockDir, processAlive, liveHolders, SUITE_OWNED_BUILD_ENV } from "../helpers/suiteLock.ts";

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
