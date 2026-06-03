import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, unlink, stat, utimes } from "node:fs/promises";
import {
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
} from "@audit-tools/shared";

const TEST_LOCK = join(tmpdir(), `test-lock-${process.pid}-${randomUUID()}.lock`);

afterEach(async () => {
  try {
    await unlink(TEST_LOCK);
  } catch {
    // ignore
  }
});

describe("acquireLock / releaseLock", () => {
  it("acquires and releases a lock", async () => {
    await acquireLock(TEST_LOCK);
    const info = await stat(TEST_LOCK);
    expect(info.isFile()).toBe(true);
    await releaseLock(TEST_LOCK);
    await expect(stat(TEST_LOCK)).rejects.toThrow();
  });

  it("times out when lock is held", async () => {
    await writeFile(TEST_LOCK, "", { flag: "wx" });
    await expect(acquireLock(TEST_LOCK, 200)).rejects.toThrow(FileLockTimeoutError);
    await unlink(TEST_LOCK);
  });

  it("releaseLock is idempotent", async () => {
    await releaseLock(TEST_LOCK);
    await releaseLock(TEST_LOCK);
  });
});

describe("withFileLock", () => {
  it("executes fn under lock and releases", async () => {
    let insideLock = false;
    const result = await withFileLock(TEST_LOCK, async () => {
      insideLock = true;
      const info = await stat(TEST_LOCK);
      expect(info.isFile()).toBe(true);
      return 42;
    });
    expect(insideLock).toBe(true);
    expect(result).toBe(42);
    await expect(stat(TEST_LOCK)).rejects.toThrow();
  });

  it("releases lock even on error", async () => {
    await expect(
      withFileLock(TEST_LOCK, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(stat(TEST_LOCK)).rejects.toThrow();
  });
});

// DR-008: property / fuzz tests for concurrent-acquirer contention, stale-lock
// recovery, crash-during-write survival, and withFileLock serialization.

describe("DR-008 — fileLock concurrent-acquirer contention", () => {
  it("only one acquirer holds the lock at any instant (N=8 concurrent callers)", async () => {
    const lockPath = join(tmpdir(), `dr008-concurrent-${randomUUID()}.lock`);
    let concurrentHolders = 0;
    let maxConcurrent = 0;
    let incrementCount = 0;

    const acquirers = Array.from({ length: 8 }, () =>
      withFileLock(
        lockPath,
        async () => {
          concurrentHolders++;
          if (concurrentHolders > maxConcurrent) maxConcurrent = concurrentHolders;
          // Yield to let other contenders run (if the lock is incorrectly shared)
          await new Promise<void>((r) => setTimeout(r, 5));
          incrementCount++;
          concurrentHolders--;
        },
        15_000,
      ),
    );

    await Promise.all(acquirers);

    expect(maxConcurrent).toBe(1);
    expect(incrementCount).toBe(8);
    // Lock should be released when all done
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("all N callers eventually acquire without deadlock (no FileLockTimeoutError)", async () => {
    const lockPath = join(tmpdir(), `dr008-nodeadlock-${randomUUID()}.lock`);
    const results: number[] = [];

    const acquirers = Array.from({ length: 6 }, (_, i) =>
      withFileLock(
        lockPath,
        async () => {
          await new Promise<void>((r) => setTimeout(r, 2));
          results.push(i);
        },
        15_000,
      ),
    );

    await expect(Promise.all(acquirers)).resolves.not.toThrow();
    expect(results).toHaveLength(6);
  });
});

describe("DR-008 — fileLock stale-lock recovery", () => {
  it("stale lock (mtime > 30s ago) is cleaned up and subsequent acquire succeeds", async () => {
    const lockPath = join(tmpdir(), `dr008-stale-${randomUUID()}.lock`);
    // Create a lock file then backdate its mtime past the stale threshold
    await writeFile(lockPath, "", { flag: "wx" });
    const staleTime = new Date(Date.now() - 35_000);
    await utimes(lockPath, staleTime, staleTime);

    // acquireLock should detect stale lock, remove it, and succeed
    await expect(acquireLock(lockPath, 3_000)).resolves.not.toThrow();
    await releaseLock(lockPath);
  });

  it("concurrent callers racing on a stale lock: exactly one acquires without error", async () => {
    const lockPath = join(tmpdir(), `dr008-stale-race-${randomUUID()}.lock`);
    await writeFile(lockPath, "", { flag: "wx" });
    const staleTime = new Date(Date.now() - 35_000);
    await utimes(lockPath, staleTime, staleTime);

    // Launch 4 concurrent acquirers — only one removes the stale file; all others
    // retry, but all should ultimately succeed (serialized) without throwing.
    const acquirers = Array.from({ length: 4 }, () =>
      withFileLock(lockPath, async () => {}, 10_000),
    );
    await expect(Promise.all(acquirers)).resolves.not.toThrow();
  });
});

describe("DR-008 — fileLock crash-during-write (orphaned lock) survival", () => {
  it("orphaned lock file left past STALE_LOCK_MS does not permanently block callers", async () => {
    const lockPath = join(tmpdir(), `dr008-orphan-${randomUUID()}.lock`);
    // Simulate a crash: create the lock file without ever releasing it
    await writeFile(lockPath, "", { flag: "wx" });
    // Advance mtime past the 30-second stale threshold
    const staleTime = new Date(Date.now() - 31_000);
    await utimes(lockPath, staleTime, staleTime);

    // A subsequent acquireLock should recover and succeed
    await expect(acquireLock(lockPath, 3_000)).resolves.not.toThrow();
    await releaseLock(lockPath);
  });

  it("releaseLock on an already-absent lock file (ENOENT) does not throw", async () => {
    const missingPath = join(tmpdir(), `dr008-enoent-${randomUUID()}.lock`);
    // File was never created; releaseLock must be idempotent
    await expect(releaseLock(missingPath)).resolves.not.toThrow();
  });
});

describe("DR-008 — withFileLock serializes concurrent writers on shared counter", () => {
  it("N concurrent withFileLock calls produce no lost updates on a shared counter file", async () => {
    const lockPath = join(tmpdir(), `dr008-counter-lock-${randomUUID()}.lock`);
    const counterPath = join(tmpdir(), `dr008-counter-${randomUUID()}.txt`);
    const N = 8;

    await writeFile(counterPath, "0", "utf8");

    const writers = Array.from({ length: N }, () =>
      withFileLock(
        lockPath,
        async () => {
          const current = parseInt(await readFile(counterPath, "utf8"), 10);
          // Yield to amplify races if serialization is broken
          await new Promise<void>((r) => setTimeout(r, 2));
          await writeFile(counterPath, String(current + 1), "utf8");
        },
        15_000,
      ),
    );

    await Promise.all(writers);

    const finalValue = parseInt(await readFile(counterPath, "utf8"), 10);
    expect(finalValue).toBe(N);

    // Cleanup
    try { await unlink(counterPath); } catch { /* ignore */ }
  });
});
