/**
 * Shared locked JSON store (src/shared/io/lockedJsonStore.ts) — the single
 * source for the read-under-lock → validate → atomic-write cycle and the
 * below-STALE_LOCK_MS lock-timeout derivation that the audit session-config
 * mutator and the remediate StateStore adapt.
 *
 * Replaces the retired tests/audit/seam-file-lock-convergence.test.mjs: its
 * premise (two DIFFERENT lock protocols converging) is obsolete — both sides
 * now share this one store. Its live coverage maps here as follows: threshold
 * parity (A) → the timeout-derivation test (one constant, nothing to
 * converge); serialized no-lost-updates (B5) → the concurrent-mutate test;
 * cross-protocol non-interference (C1–C3, permanently skipped there) → the
 * two-stores-same-dir test below; TOCTOU stale-steal (D) → already covered at
 * its source in fileLock.test.mjs / fileLock-clock-seam.test.mjs.
 */

import { test, expect } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createLockedJsonStore,
  SKIP_WRITE,
  LOCKED_JSON_STORE_TIMEOUT_MS,
  STALE_LOCK_MS,
} from "audit-tools/shared";
import { withTempDir } from "./fileLockTestSupport.mjs";

/** Counter-shaped store used across the tests: {count} on disk, 0 when absent. */
function counterStore(dir, overrides = {}) {
  return createLockedJsonStore({
    path: join(dir, "counter.json"),
    lockPath: join(dir, "counter.lock"),
    parse: (raw) =>
      raw !== undefined && typeof raw === "object" && raw !== null
        ? raw
        : { count: 0 },
    ...overrides,
  });
}

// ── Timeout derivation ────────────────────────────────────────────────────────

test("lock timeout is derived strictly below the shared stale-lock threshold", () => {
  // A held-but-fresh lock must time out before it could be reclaimed as stale;
  // an equal/greater timeout makes that a load-sensitive boundary race. Derived
  // (STALE_LOCK_MS - margin), not hardcoded, so the invariant cannot drift.
  expect(LOCKED_JSON_STORE_TIMEOUT_MS).toBeGreaterThan(0);
  expect(LOCKED_JSON_STORE_TIMEOUT_MS).toBeLessThan(STALE_LOCK_MS);
});

// ── Initial-value path ────────────────────────────────────────────────────────

test("read() on an absent file returns the parse-supplied initial value", async () => {
  await withTempDir(async (dir) => {
    const store = counterStore(dir);
    expect(await store.read()).toEqual({ count: 0 });
    // read() is lockless and must not create the file.
    await expect(stat(join(dir, "counter.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test("mutate on an absent file receives the initial value and persists the result", async () => {
  await withTempDir(async (dir) => {
    const store = counterStore(dir);
    const result = await store.mutate((current) => {
      expect(current).toEqual({ count: 0 });
      return { count: current.count + 1 };
    });
    expect(result).toEqual({ count: 1 });
    expect(await store.read()).toEqual({ count: 1 });
  });
});

// ── Concurrent mutate exclusion ───────────────────────────────────────────────

test("concurrent mutates against one store serialize — no lost updates", async () => {
  await withTempDir(async (dir) => {
    const store = counterStore(dir);
    const N = 6;
    const seen = [];
    await Promise.all(
      Array.from({ length: N }, () =>
        store.mutate(async (current) => {
          seen.push(current.count);
          // Amplify the race window if the lock were broken.
          await new Promise((r) => setTimeout(r, 2));
          return { count: current.count + 1 };
        }),
      ),
    );
    // Every mutate observed a distinct prior value (each saw the previous
    // holder's write), and no increment was lost.
    expect(new Set(seen).size).toBe(N);
    expect(await store.read()).toEqual({ count: N });
  });
});

// ── Atomic write (temp-then-rename) ──────────────────────────────────────────

test("a throwing validate aborts the write — prior content intact, no partial/temp file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "counter.json");
    const store = counterStore(dir, {
      validate: (next) => {
        if (next.count < 0) throw new Error("count must be non-negative");
      },
    });
    await store.mutate(() => ({ count: 3 }));
    const before = await readFile(path, "utf8");

    await expect(
      store.mutate(() => ({ count: -1 })),
    ).rejects.toThrow(/non-negative/);

    // The failed write left the previous durable content byte-identical...
    expect(await readFile(path, "utf8")).toBe(before);
    // ...and no partial/temp residue behind (temp-then-rename never exposes a
    // half-written destination; the lock file itself is released too).
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(files).not.toContain("counter.lock");

    // The store is still usable after the aborted write.
    expect(await store.mutate((c) => ({ count: c.count + 1 }))).toEqual({
      count: 4,
    });
  });
});

test("replace() also validates and never lands a partial file on failure", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "counter.json");
    const store = counterStore(dir, {
      validate: (next) => {
        if (next.count < 0) throw new Error("count must be non-negative");
      },
    });
    await store.replace({ count: 9 });
    expect(await store.read()).toEqual({ count: 9 });

    const before = await readFile(path, "utf8");
    await expect(store.replace({ count: -5 })).rejects.toThrow(/non-negative/);
    expect(await readFile(path, "utf8")).toBe(before);
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

// ── SKIP_WRITE (idempotent no-op under the same held lock) ───────────────────

test("mutate returning SKIP_WRITE resolves with the read value and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const store = counterStore(dir);
    const result = await store.mutate(() => SKIP_WRITE);
    expect(result).toEqual({ count: 0 });
    // No write happened: the file still does not exist.
    await expect(stat(join(dir, "counter.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

// ── Non-interference (ports the C-intent of the retired convergence test) ────

test("two stores on different files in the same dir do not block or corrupt each other", async () => {
  await withTempDir(async (dir) => {
    const a = counterStore(dir);
    const b = createLockedJsonStore({
      path: join(dir, "other.json"),
      lockPath: join(dir, "other.lock"),
      parse: (raw) => raw ?? { status: "pending" },
    });

    await Promise.all([
      a.mutate(async (c) => {
        await new Promise((r) => setTimeout(r, 10));
        return { count: c.count + 1 };
      }),
      b.mutate(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { status: "planning" };
      }),
    ]);

    expect(await a.read()).toEqual({ count: 1 });
    expect(await b.read()).toEqual({ status: "planning" });
  });
});
