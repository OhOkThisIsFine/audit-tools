import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ioError(
  action: "read" | "write" | "append" | "prepare parent directory",
  path: string,
  error: unknown,
): Error {
  return new Error(`Failed to ${action} ${path}: ${errorMessage(error)}`);
}

async function ensureParentDirectory(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    throw ioError("prepare parent directory", path, error);
  }
}

const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EEXIST"]);

/**
 * Windows can transiently fail an atomic rename-over-existing with EPERM/EBUSY
 * (antivirus, the search indexer, or a concurrent reader briefly holding the
 * destination handle). Those are retryable; a missing path or bad input is not.
 */
export function isTransientFsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_FS_CODES.has(code);
}

export interface FsRetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests so retries don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Retry a filesystem operation on transient Windows lock errors with bounded
 * exponential backoff (mirrors the quota file lock's 50ms→500ms convention).
 * Non-transient errors propagate immediately.
 */
export async function withFsRetry<T>(
  operation: () => Promise<T>,
  options: FsRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  let delayMs = options.initialDelayMs ?? 20;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientFsError(error)) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await ensureParentDirectory(path);
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, content, "utf8");
    // The temp name is unique per process+uuid, so only the final rename-over-
    // existing-destination is exposed to transient Windows lock errors.
    await withFsRetry(() => rename(temp, path));
  } catch (error) {
    throw ioError("write", path, error);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function readJsonFile<T>(path: string): Promise<T> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) {
      throw error;
    }
    throw ioError("read", path, error);
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${errorMessage(error)}`);
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Resolve a JSON-pointer-style path (a list of object keys / array indices)
 * against an already-parsed value. Returns `undefined` if any segment is
 * missing. Kept tiny and fully-owned: it only walks plain objects and arrays,
 * which is all a stored artifact ever nests.
 */
function resolveScalarPath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Bounded-accessor read path for an over-cap SCALAR string value.
 *
 * 2-space indentation (see `writeJsonFile`) wraps containers across lines but
 * CANNOT wrap a single scalar string — a >2000-char `quoted_text` / base64
 * `evidence` value lands on one physical line, which a line-truncating reader
 * (e.g. the host Read tool, capped at ~2000 chars/line) silently clips. A
 * worker that must re-read such a value cannot reconstruct it by eyeballing the
 * file. This accessor reconstructs it programmatically: it `JSON.parse`s the
 * whole file (Node has no per-line cap) and returns the full scalar at
 * `segments`, regardless of length.
 *
 * Returns the string value, or `undefined` if the path is missing or the value
 * at the path is not a string scalar.
 */
export async function readJsonStringScalar(
  path: string,
  segments: readonly string[],
): Promise<string | undefined> {
  const root = await readJsonFile<unknown>(path);
  const value = resolveScalarPath(root, segments);
  return typeof value === "string" ? value : undefined;
}

/**
 * Same reconstruction as `readJsonStringScalar`, but yields the scalar in
 * fixed-size character chunks so a consumer whose own read surface is bounded
 * (e.g. a worker relaying through a capped transport) can stream an arbitrarily
 * long scalar without ever holding a single over-cap line. Concatenating the
 * yielded chunks reproduces the scalar exactly. Yields nothing if the path is
 * missing or the value is not a string.
 */
export async function* readJsonStringScalarChunks(
  path: string,
  segments: readonly string[],
  chunkSize = 1000,
): AsyncGenerator<string, void, void> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(
      `readJsonStringScalarChunks: chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }
  const value = await readJsonStringScalar(path, segments);
  if (value === undefined) {
    return;
  }
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    yield value.slice(offset, offset + chunkSize);
  }
}

export async function appendNdjsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await ensureParentDirectory(path);
  try {
    await appendFile(path, JSON.stringify(value) + "\n", "utf8");
  } catch (error) {
    throw ioError("append", path, error);
  }
}

export async function readNdjsonFile<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf8");
    const values: T[] = [];
    let sawContent = false;

    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      sawContent = true;
      try {
        values.push(JSON.parse(line) as T);
      } catch (error) {
        throw new Error(
          `Invalid NDJSON in ${path} at line ${index + 1}: ${errorMessage(error)}`,
        );
      }
    }

    if (!sawContent && content.length > 0) {
      throw new Error(
        `NDJSON file ${path} contains only whitespace — possible truncated write`,
      );
    }
    return values;
  } catch (error) {
    if (isFileMissingError(error)) {
      throw error;
    }
    if (error instanceof Error && error.message.includes(path)) {
      throw error;
    }
    throw ioError("read", path, error);
  }
}

export async function readOptionalJsonFile<T>(
  path: string,
): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(path);
  } catch (error) {
    if (isFileMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function readOptionalNdjsonFile<T>(
  path: string,
): Promise<T[] | undefined> {
  try {
    return await readNdjsonFile<T>(path);
  } catch (error) {
    if (isFileMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeNdjsonFile(
  path: string,
  values: unknown[],
): Promise<void> {
  const content =
    values.length === 0
      ? ""
      : values.map((v) => JSON.stringify(v)).join("\n") + "\n";
  await writeFileAtomic(path, content);
}

export async function readOptionalTextFile(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) {
      return undefined;
    }
    throw ioError("read", path, error);
  }
}

export async function writeTextFile(
  path: string,
  value: string,
): Promise<void> {
  await writeFileAtomic(path, value);
}
