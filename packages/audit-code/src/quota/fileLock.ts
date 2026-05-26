import { open, unlink, stat } from "node:fs/promises";

const STALE_LOCK_MS = 30_000;
const RETRY_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out acquiring lock: ${lockPath}`);
    this.name = "FileLockTimeoutError";
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export async function acquireLock(
  lockPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = await open(lockPath, "wx");
      await fd.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    if (await isLockStale(lockPath)) {
      try {
        await unlink(lockPath);
        continue;
      } catch {
        // Another process may have already cleaned it up
      }
    }

    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath);
    }

    await new Promise<void>((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  await acquireLock(lockPath, timeoutMs);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}
