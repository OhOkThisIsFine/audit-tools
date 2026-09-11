import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolingManifest } from "../types/toolingManifest.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { isFileMissingError } from "audit-tools/shared";

// dist/audit/io/toolingManifest.js → repo root is three levels up
// (io → audit → dist → repo root).
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export const TOOLING_INPUTS = [
  "audit-code.mjs",
  "wrapper/audit-code-wrapper-lib.mjs",
  "package.json",
  "dist",
  "schemas",
  "skills/audit-code",
] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What `collectFiles` returns for an entry that vanished mid-walk, so the caller
 * records the skip IN the hash input instead of silently hashing a smaller tree.
 *
 * A path can never equal this: it is bracketed by NUL, which no filesystem path
 * contains. Spelled through `String.fromCharCode` rather than as a literal — a
 * raw control byte in this file would make git treat it as binary and every
 * search over it silently return nothing, which is the same trap the byte gate
 * exists to catch, one level up.
 */
const NUL = String.fromCharCode(0);
const VANISHED_ENTRY_PREFIX = `${NUL}vanished-during-walk${NUL}`;

function vanishedEntry(path: string): string {
  return VANISHED_ENTRY_PREFIX + path;
}

/**
 * The path behind a {@link collectFiles} sentinel, or `undefined` for a real
 * entry — the decode and the predicate in one, so the encoding has exactly one
 * reader and a caller can never test for a sentinel without being able to read
 * which path it stands for.
 */
function vanishedEntryPath(entry: string): string | undefined {
  return entry.startsWith(VANISHED_ENTRY_PREFIX)
    ? entry.slice(VANISHED_ENTRY_PREFIX.length)
    : undefined;
}

/**
 * The marker written into the hash input for an entry that was expected and was
 * not there — used BOTH for a walk entry `collectFiles` could not examine and
 * for a listed file that was gone by read time ({@link hashFileIfPresent}).
 *
 * One marker for the two, because they are one event seen at two moments: the
 * tree changed under the walk. What must not happen is a silent drop — a digest
 * over a different file set would then equal the digest over the set it lost,
 * which is the only thing the hash exists to tell apart.
 */
const ABSENT_DURING_WALK = "absent-during-walk";

/** Hash `path`'s relative name plus the marker that nothing was read for it. */
function recordAbsentEntry(
  hash: ReturnType<typeof createHash>,
  packageRoot: string,
  path: string,
): void {
  hash.update(relative(packageRoot, path).replace(/\\/g, "/"));
  hash.update("\n");
  hash.update(ABSENT_DURING_WALK);
  hash.update("\n");
}

/**
 * Every file at or under `path`, in stable name order, plus one sentinel per
 * entry that disappeared between being listed and being examined.
 *
 * BOTH halves of the walk are exposed to the same race — `scripts/shared/
 * clean-dist.mjs` removes `dist/` on every build, and a build can run while a
 * fold is reading the manifest — so tolerating only the READ half
 * (`hashFileIfPresent`) left the other half fatal: a subtree removed between the
 * parent's `readdir` and the recursive `stat` (or between that `stat` and the
 * `readdir` one level down) threw a bare ENOENT out through `loadArtifactBundle`,
 * pointing at the manifest hasher instead of at the rebuild that caused it.
 *
 * Only the ROOT keeps `pathExists` semantics, and it is checked by the caller
 * before we get here: a missing root means "this input is not present" and
 * contributes nothing. Anywhere deeper, a miss is the concurrent-rebuild race
 * and is RECORDED as a skip — never an entry that silently drops out of the
 * hash, which would make two different file sets produce one digest.
 *
 * The recording is the caller's half: a sentinel returned here is hashed as a
 * path that was listed and held nothing ({@link recordAbsentEntry}), so the
 * tolerance and the record stay in one place per half of the walk.
 *
 * A permission error or any other IO failure still throws: those are not a
 * concurrent rebuild, and swallowing them would hide a real defect.
 */
async function collectFiles(path: string): Promise<string[]> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    return [vanishedEntry(path)];
  }
  if (info.isFile()) {
    return [path];
  }
  if (!info.isDirectory()) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    return [vanishedEntry(path)];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    files.push(...(await collectFiles(join(path, entry.name))));
  }
  return files;
}

/**
 * Read `version` from the package.json under `packageRoot`, or `null` when the
 * file is absent, unreadable, malformed, or carries a non-string version — a
 * missing tooling version must never abort manifest construction.
 *
 * Exported and root-parameterized so its failure branch is reachable from a
 * test against a temp directory: the regression it guards (a parse failure that
 * reports to stderr and degrades to `null`) is only actually guarded by a test
 * that runs THIS function, not a copy of it.
 */
export async function readPackageVersion(
  packageRoot: string,
): Promise<string | null> {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch (error) {
    process.stderr.write(
      `[audit-code] readPackageVersion: failed to read/parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

/**
 * Hash one file's path and bytes into `hash`, or RECORD that it vanished.
 *
 * The walk is a list-then-hash over a tree that a concurrent `tsc` re-emit is
 * free to rewrite (`npm run build` racing a parallel vitest run, a stale
 * incremental `dist/`), so a listed file can be gone by the time it is read.
 * That race is expected and must not be fatal: an ENOENT here used to surface
 * out of `loadArtifactBundle` as a bare `ENOENT: ... .d.ts.map`, so unrelated
 * fold tests failed with a message pointing at the manifest hasher rather than
 * at the race that actually caused it.
 *
 * The skip is recorded IN THE HASH INPUT rather than silently dropped — a
 * manifest that hashed a different file set would otherwise produce the same
 * `implementation_hash` as one that did not, which is the whole thing the hash
 * exists to distinguish.
 *
 * Only the missing-file race is tolerated. A permission error, a directory
 * where a file was listed, or any other IO failure still throws: those are not
 * a concurrent rebuild and swallowing them would hide a real defect.
 */
async function hashFileIfPresent(
  hash: ReturnType<typeof createHash>,
  packageRoot: string,
  file: string,
  readBytes: (path: string) => Promise<Buffer>,
): Promise<boolean> {
  const relativePath = relative(packageRoot, file).replace(/\\/g, "/");
  hash.update(relativePath);
  hash.update("\n");
  let bytes: Buffer;
  try {
    bytes = await readBytes(file);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    hash.update(ABSENT_DURING_WALK);
    hash.update("\n");
    return false;
  }
  hash.update(bytes);
  hash.update("\n");
  return true;
}

/**
 * Walk `inputs` under `packageRoot` and hash them into one digest.
 *
 * Root- and reader-parameterized so BOTH branches of the vanish-during-walk
 * race are reachable from a test against a temp directory: the regression this
 * guards is a listed file that is gone by read time, which no test of the
 * fixed-root `buildToolingManifest` can produce deterministically — and a
 * guard whose failure branch no test can reach is not a guard. Same reason
 * `readPackageVersion` takes a root and `killRuntimeCommandTree` takes a
 * platform.
 */
export async function hashToolingInputs(
  packageRoot: string,
  inputs: readonly string[],
  readBytes: (path: string) => Promise<Buffer> = readFile,
): Promise<{ implementation_hash: string; inputs: string[] }> {
  const hash = createHash("sha256");
  const existingInputs: string[] = [];

  for (const input of inputs) {
    const absolute = join(packageRoot, input);
    if (!(await pathExists(absolute))) {
      continue;
    }
    existingInputs.push(input);
    const files = await collectFiles(absolute);
    for (const file of files.sort((a, b) => compareCodeUnits(a, b))) {
      // A sentinel never reaches the reader: it stands for a path that was
      // listed and had nothing behind it. Hashed as an absence it loses its NUL
      // bracketing — a path cannot contain one, but the DIGEST is compared
      // across runs and machines, and a raw NUL in the input is a byte no
      // reader of this file can see or search for.
      const vanished = vanishedEntryPath(file);
      if (vanished !== undefined) {
        recordAbsentEntry(hash, packageRoot, vanished);
        continue;
      }
      await hashFileIfPresent(hash, packageRoot, file, readBytes);
    }
  }

  return { implementation_hash: hash.digest("hex"), inputs: existingInputs };
}

export async function buildToolingManifest(): Promise<ToolingManifest> {
  const { implementation_hash, inputs } = await hashToolingInputs(
    PACKAGE_ROOT,
    TOOLING_INPUTS,
  );
  return {
    generated_at: new Date().toISOString(),
    package_root: PACKAGE_ROOT,
    package_version: await readPackageVersion(PACKAGE_ROOT),
    implementation_hash,
    inputs,
  };
}
