import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const { acquireLock, releaseLock, withFileLock, FileLockTimeoutError } =
  await import("@audit-tools/shared/quota/fileLock");

function tmpLock() {
  return join(tmpdir(), `test-lock-${randomUUID()}.lock`);
}

test("acquireLock creates lock file and releaseLock removes it", async () => {
  const lockPath = tmpLock();
  await acquireLock(lockPath);
  const info = await stat(lockPath);
  assert.ok(info.isFile());
  await releaseLock(lockPath);
  await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
});

test("acquireLock blocks when lock is held", async () => {
  const lockPath = tmpLock();
  await acquireLock(lockPath);

  const start = Date.now();
  // Release after 150ms
  const releaseTimer = setTimeout(async () => {
    await releaseLock(lockPath);
  }, 150);

  await acquireLock(lockPath, 5000);
  clearTimeout(releaseTimer);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100, `expected to wait at least 100ms, waited ${elapsed}ms`);
  await releaseLock(lockPath);
});

test("acquireLock times out when lock is never released", async () => {
  const lockPath = tmpLock();
  await acquireLock(lockPath);
  await assert.rejects(
    () => acquireLock(lockPath, 200),
    (err) => err instanceof FileLockTimeoutError,
  );
  await releaseLock(lockPath);
});

test("acquireLock cleans up stale lock", async () => {
  const lockPath = tmpLock();
  // Create a lock file with old mtime
  await writeFile(lockPath, "", { flag: "wx" });
  const past = new Date(Date.now() - 60_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(lockPath, past, past);

  await acquireLock(lockPath, 2000);
  const info = await stat(lockPath);
  assert.ok(info.mtimeMs > Date.now() - 5000, "lock file should have fresh mtime");
  await releaseLock(lockPath);
});

test("withFileLock runs function under lock", async () => {
  const lockPath = tmpLock();
  const result = await withFileLock(lockPath, async () => {
    const info = await stat(lockPath);
    assert.ok(info.isFile());
    return 42;
  });
  assert.equal(result, 42);
  await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
});

test("withFileLock releases lock on error", async () => {
  const lockPath = tmpLock();
  await assert.rejects(
    () =>
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    { message: "boom" },
  );
  await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
});

test("releaseLock is idempotent", async () => {
  const lockPath = tmpLock();
  await acquireLock(lockPath);
  await releaseLock(lockPath);
  await releaseLock(lockPath); // should not throw
});
