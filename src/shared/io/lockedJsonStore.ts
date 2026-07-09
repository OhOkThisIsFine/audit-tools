import { withFileLock, STALE_LOCK_MS } from "../quota/fileLock.js";
import { readOptionalJsonFile, writeJsonFile } from "./json.js";

// Acquire timeout for a locked JSON store, DERIVED to stay safely below shared
// fileLock's STALE_LOCK_MS rather than hardcoded — tying them programmatically so
// the invariant can't silently drift. A fresh-but-held lock then times out
// deterministically before it could be reclaimed as stale; an equal/greater
// timeout makes that a load-sensitive boundary race (the lock is written just
// before the acquire starts, so its stale point precedes the deadline). The
// margin absorbs the write→acquire gap, loop overhead, and load drift.
//
// Single-sourced here for every locked JSON store (the audit session-config
// mutator and the remediate StateStore both used to derive this independently).
const LOCK_TIMEOUT_MARGIN_MS = 10_000;
export const LOCKED_JSON_STORE_TIMEOUT_MS = STALE_LOCK_MS - LOCK_TIMEOUT_MARGIN_MS;

/**
 * Sentinel a `mutate` callback returns to skip the write (idempotent no-op).
 * The skip decision runs against the value read inside the SAME held lock as
 * the potential write, so it cannot race a concurrent writer that changed the
 * file between read and write.
 */
export const SKIP_WRITE: unique symbol = Symbol("locked-json-store/skip-write");

export interface LockedJsonStoreOptions<T> {
  /** The JSON file this store owns. */
  path: string;
  /**
   * Sibling lock file serializing every read-modify-write on `path`. Explicit
   * (not derived from `path`) because both consumers use an established lock
   * filename that is not `<path>.lock`.
   */
  lockPath: string;
  /**
   * Map the raw on-disk JSON value to the domain value handed to callers.
   * Receives `undefined` when the file is absent — return the initial value
   * there. May throw on corrupt/invalid content (the error propagates to the
   * caller; nothing is written).
   */
  parse: (raw: unknown | undefined) => T;
  /**
   * Validate a value about to be persisted; throw to abort the write (the lock
   * is still released, the file is untouched). Runs on every write — never on
   * a {@link SKIP_WRITE} no-op.
   */
  validate?: (next: T) => void;
}

export interface LockedJsonStore<T> {
  /**
   * Lockless read: parse the current on-disk value (or the parse-supplied
   * initial value when the file is absent). Use {@link LockedJsonStore.mutate}
   * for any read-modify-write that requires TOCTOU safety.
   */
  read: () => Promise<T>;
  /**
   * TOCTOU-safe read-modify-write: acquires the file lock ONCE, reads + parses
   * the current value, passes it to `fn`, and atomically writes the returned
   * value (shared `writeJsonFile`: temp + atomic rename) before releasing the
   * lock. No other holder can interleave between the read and the write.
   * Returning {@link SKIP_WRITE} skips the write and resolves with the value
   * that was read. No caller adds backoff/retry of its own; that lives solely
   * in the shared lock.
   */
  mutate: (
    fn: (current: T) => T | typeof SKIP_WRITE | Promise<T | typeof SKIP_WRITE>,
  ) => Promise<T>;
  /**
   * Write `next` unconditionally under the lock, WITHOUT reading first (so a
   * corrupt on-disk value cannot block recovery). Prefer
   * {@link LockedJsonStore.mutate} for transitions; use this only when the
   * caller holds an external guarantee that no concurrent writer's update
   * could be lost.
   */
  replace: (next: T) => Promise<void>;
}

/**
 * A JSON file guarded by the shared {@link withFileLock}: read-under-lock →
 * domain parse/validate → atomic write, with the below-stale lock timeout
 * derived in one place. Owns only what its two real consumers share (audit
 * `session-config.json`, remediate `state.json`); domain validation and
 * public API shape stay with the thin adapters.
 */
export function createLockedJsonStore<T>(
  options: LockedJsonStoreOptions<T>,
): LockedJsonStore<T> {
  const { path, lockPath, parse, validate } = options;

  const read = async (): Promise<T> =>
    parse(await readOptionalJsonFile<unknown>(path));

  const persist = async (next: T): Promise<void> => {
    validate?.(next);
    await writeJsonFile(path, next);
  };

  return {
    read,
    async mutate(fn) {
      let result!: T;
      await withFileLock(
        lockPath,
        async () => {
          const current = await read();
          const next = await fn(current);
          if (next === SKIP_WRITE) {
            result = current;
            return;
          }
          await persist(next);
          result = next;
        },
        LOCKED_JSON_STORE_TIMEOUT_MS,
      );
      return result;
    },
    async replace(next) {
      await withFileLock(
        lockPath,
        async () => {
          await persist(next);
        },
        LOCKED_JSON_STORE_TIMEOUT_MS,
      );
    },
  };
}
