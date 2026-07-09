/**
 * Generic file-integrity check loop — the common core of audit-code's
 * `checkFileIntegrity` (flat repo-manifest scope) and remediate-code's
 * `checkAffectedFileIntegrity` (finding-affected-files scope). Both iterate a
 * list of records carrying a stored/expected hash, resolve each to an absolute
 * path, classify it as unchanged / changed / missing / an I/O error, and derive
 * `is_clean` from the three buckets. What genuinely differs per side — the
 * record shape, path resolution, how a file/directory is actually hashed, and
 * the I/O-error reporting format — stays with the caller via the injected
 * `resolveAbsolute` / `exists` / `hash` hooks; this module owns only the shared
 * classify-and-bucket loop.
 */

export interface FileIntegrityBuckets {
  changed: string[];
  missing: string[];
  ioErrors: string[];
  isClean: boolean;
}

/**
 * Outcome of hashing one record's resolved path, reported back to the loop:
 * - `ok` — the file was read; compare `hash` against the record's expected hash.
 * - `missing` — the path turned out to be absent (e.g. a race between the
 *   caller's `exists` pre-check and the actual read).
 * - `io_error` — a real read failure (not "absent"). The caller is responsible
 *   for reporting/logging it in its own format before returning this outcome.
 */
export type FileIntegrityHashOutcome =
  | { kind: "ok"; hash: string }
  | { kind: "missing" }
  | { kind: "io_error" };

export interface FileIntegrityCheckOptions<T> {
  /** Records to check (already scoped/deduped by the caller). */
  records: Iterable<T>;
  /** Display path recorded into the changed/missing/io_errors buckets. */
  getPath: (record: T) => string;
  /** The record's stored/expected hash. Records without one are skipped entirely. */
  getExpectedHash: (record: T) => string | undefined;
  /** Resolve the record's display path to an absolute filesystem path. */
  resolveAbsolute: (path: string) => string;
  /** Synchronous existence check, run before attempting to hash. */
  exists: (absolutePath: string) => boolean;
  /** Hash the resolved path, classifying any failure per {@link FileIntegrityHashOutcome}. */
  hash: (absolutePath: string, record: T) => Promise<FileIntegrityHashOutcome>;
}

/**
 * Iterate `records`, classify each into changed / missing / io_errors against
 * its expected hash, and derive `isClean`. Ordering follows iteration order of
 * `records` (callers are responsible for any stable pre-sort/dedup).
 */
export async function checkFileIntegrityRecords<T>(
  options: FileIntegrityCheckOptions<T>,
): Promise<FileIntegrityBuckets> {
  const changed: string[] = [];
  const missing: string[] = [];
  const ioErrors: string[] = [];

  for (const record of options.records) {
    const expectedHash = options.getExpectedHash(record);
    if (!expectedHash) continue;

    const path = options.getPath(record);
    const absolute = options.resolveAbsolute(path);
    if (!options.exists(absolute)) {
      missing.push(path);
      continue;
    }

    const outcome = await options.hash(absolute, record);
    if (outcome.kind === "missing") {
      missing.push(path);
    } else if (outcome.kind === "io_error") {
      ioErrors.push(path);
    } else if (outcome.hash !== expectedHash) {
      changed.push(path);
    }
  }

  return {
    changed,
    missing,
    ioErrors,
    isClean: changed.length === 0 && missing.length === 0 && ioErrors.length === 0,
  };
}
