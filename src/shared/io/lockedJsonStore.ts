import { withFileLock, STALE_LOCK_MS } from "./fileLock.js";
import {
  isJsonParseError,
  readOptionalJsonFile,
  writeJsonFile,
} from "./json.js";

// Acquire timeout for a locked JSON store, DERIVED to stay safely below shared
// fileLock's STALE_LOCK_MS rather than hardcoded — tying them programmatically so
// the invariant can't silently drift. A fresh-but-held lock then times out
// deterministically before it could be reclaimed as stale; an equal/greater
// timeout makes that a load-sensitive boundary race (the lock is written just
// before the acquire starts, so its stale point precedes the deadline). The
// margin absorbs the write→acquire gap, loop overhead, and load drift.
//
// Single-sourced here for every locked JSON store (the analyzer-policy store
// and the remediate StateStore both used to derive this independently).
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
  /**
   * Degrade-not-throw for a corrupt file (CP-NODE-5's recorded design for the
   * expected-submission set): a read that fails because the file exists but
   * does not PARSE resolves as if the file were absent — `parse` receives
   * `undefined`, so the caller's absent-path (rebuild / merge-from-nothing /
   * skip) IS the degrade. Infrastructure IO errors still propagate, as does a
   * `parse` that throws on its own judgment of the content. Off by default: the
   * loud-fail stores (analyzer policy, remediate state) keep their refusal.
   */
  tolerateCorruptRead?: boolean;
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
 * derived in one place. Owns only what its consumers share (the analyzer-policy
 * store, the remediate state store, and — with
 * {@link LockedJsonStoreOptions.tolerateCorruptRead} — the audit expected-
 * submission set, whose corrupt read degrades to absent per CP-NODE-5);
 * domain validation and public API shape stay with the thin adapters.
 */
export function createLockedJsonStore<T>(
  options: LockedJsonStoreOptions<T>,
): LockedJsonStore<T> {
  const { path, lockPath, parse, validate, tolerateCorruptRead } = options;

  const read = async (): Promise<T> => {
    let raw: unknown | undefined;
    try {
      raw = await readOptionalJsonFile<unknown>(path);
    } catch (error) {
      if (!(tolerateCorruptRead && isJsonParseError(error))) throw error;
      // Degrade: a corrupt file reads as absent (see the option's note), so
      // the caller's absent-path is the recovery — and the next write replaces
      // the corrupt bytes wholesale.
      raw = undefined;
    }
    return parse(raw);
  };

  const persist = async (next: T): Promise<void> => {
    validate?.(next);
    await writeJsonFile(path, next);
  };

  const store: LockedJsonStore<T> = {
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

  return store;
}

/**
 * The sibling lock path for one store/ledger file: `<file>.lock`, named off the
 * file's own stem so the lock is visibly the lock FOR that file rather than an
 * independently invented name. Consumers that already hold an established lock
 * name declare `lockPath` explicitly instead (see {@link LockedJsonStoreOptions});
 * this is for the ones that own their file outright — the submission ledger,
 * which appends under exactly this derivation.
 */
export function siblingLockPath(targetPath: string): string {
  return `${targetPath}.lock`;
}
