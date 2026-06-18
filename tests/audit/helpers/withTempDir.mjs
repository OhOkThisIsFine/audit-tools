import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a temporary directory with the given prefix, passes its path to
 * `fn`, and removes it (recursively) when `fn` resolves or rejects.
 *
 * @template T
 * @param {string} prefix  Prefix passed to mkdtemp (appended to os.tmpdir()).
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
