import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink, stat } from "node:fs/promises";
import {
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
} from "@audit-tools/shared";

const TEST_LOCK = join(tmpdir(), `test-lock-${process.pid}.lock`);

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
