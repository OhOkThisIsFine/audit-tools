/**
 * Charter evidence-packet RETENTION.
 *
 * Packets are consumed inputs: a stale packet left in the lane-asset directory
 * would feed a later staleness-triggered re-extraction yesterday's evidence, so
 * the emitter's read path must be empty after ingest. That reason is real and is
 * preserved verbatim here — what changes is that the bytes are no longer
 * DESTROYED to achieve it.
 *
 * The packet's content was nowhere else when it was unlinked, which inverts the
 * P25-f rule stated 130 lines above the deletion site: a submission is only ever
 * destroyed once its content is somewhere else. So three independent lanes could
 * each report that the request path was absent from their packet, and the
 * orchestrator could not confirm it — a glob against the deleted names matched
 * nothing and produced a confident, meaningless "0 of 3".
 *
 * A HASH ALONE WOULD NOT ANSWER THE QUESTION. `materializeCharterPacket` reads
 * the audited repository from disk, so a packet is a function of bundle + WORKING
 * TREE. Once the audited tree moves the packet is not regenerable and a hash
 * becomes unfalsifiable — it answers "did this lane get the tool's packet", never
 * "what exactly did this lane read". Retain the bytes; carry the hash as identity.
 *
 * ARCHIVE-THEN-UNLINK, never unlink-then-hope. The archived bytes are re-read and
 * re-hashed BEFORE the source is removed; a failed or unverifiable archive leaves
 * the source in place and records `archived: false` with a reason.
 *
 * IT NEVER THROWS. This runs after `runAuditStepUnlocked` has applied the
 * submission and after the lane files are marked applied — the RECORD arm of
 * `514cd31c`, not the throw arm. A throw here would abort a fold whose ingest had
 * already succeeded, which is strictly worse than a stated retention failure.
 *
 * `charter-packets/` is a retained-evidence directory with no `ARTIFACT_DEFINITIONS`
 * row and no dependency-map node — the precedent `design-review-snapshots/` set.
 * Nothing reads it as input, so it adds no DAG edge and cannot re-stale anything.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareCodeUnits,
  hashContent,
  laneAssetsDir,
  readOptionalJsonFile,
  type CharterKind,
} from "audit-tools/shared";
import { charterExtractionPacketFilename } from "../cli/laneSubmissions.js";

/** The retained-evidence directory, beside `design-review-snapshots/`. */
export const CHARTER_PACKET_ARCHIVE_DIRNAME = "charter-packets";

/** Characters of the content digest that name an archived packet file. */
const ARCHIVE_NAME_DIGEST_CHARS = 12;

/**
 * One retention record. `archived: false` is a STATED failure, never a silent
 * one: the source packet is still in the lane-asset directory, and the reason
 * says why the archive could not be trusted.
 */
export interface CharterPacketArchiveRow {
  kind: CharterKind;
  /** Full sha256 of the packet bytes — the identity, even when `archived` is false. */
  sha256: string;
  byte_length: number;
  archived_at: string;
  /** The lane-asset filename the packet was read from. */
  source_filename: string;
  archived: boolean;
  /** Present only on `archived: false`. */
  reason?: string;
}

export function charterPacketArchiveDir(artifactsDir: string): string {
  return join(artifactsDir, CHARTER_PACKET_ARCHIVE_DIRNAME);
}

export function charterPacketIndexPath(artifactsDir: string): string {
  return join(charterPacketArchiveDir(artifactsDir), "index.json");
}

/**
 * The archived packet's filename: `<kind>-<first 12 of sha256>.md`. Keyed by
 * CONTENT, so a re-extraction that produced identical evidence reuses the same
 * file (one copy of one packet) while a re-extraction that produced DIFFERENT
 * evidence lands beside it instead of overwriting the record of what an earlier
 * lane actually read.
 */
export function charterPacketArchiveFilename(
  kind: CharterKind,
  sha256: string,
): string {
  return `${kind}-${sha256.slice(0, ARCHIVE_NAME_DIGEST_CHARS)}.md`;
}

/**
 * Read the retention index. An ABSENT file, and a payload that is not an array,
 * read as no rows. Anything else — a malformed body, a directory in its place,
 * a permission failure — THROWS, deliberately: the caller that overwrites this
 * file must be able to tell "there was nothing to accumulate" from "the record
 * could not be read", and only the second must stop it from clobbering.
 */
export async function readCharterPacketIndex(
  artifactsDir: string,
): Promise<CharterPacketArchiveRow[]> {
  const rows = await readOptionalJsonFile<CharterPacketArchiveRow[]>(
    charterPacketIndexPath(artifactsDir),
  );
  return Array.isArray(rows) ? rows : [];
}

/** Stable order: kind, then content digest. Never insertion or IO-completion order. */
function sortRows(rows: CharterPacketArchiveRow[]): CharterPacketArchiveRow[] {
  return [...rows].sort(
    (a, b) =>
      compareCodeUnits(a.kind, b.kind) ||
      compareCodeUnits(a.sha256, b.sha256) ||
      (a.archived === b.archived ? 0 : a.archived ? 1 : -1),
  );
}

/**
 * Archive each kind's evidence packet, then remove it from the emitter's read
 * path. Returns the rows written for this pass (the index on disk accumulates
 * across re-extractions). Absent packets are skipped: nothing was delivered, so
 * there is nothing to retain and nothing to report.
 */
export async function archiveCharterPackets(params: {
  artifactsDir: string;
  kinds: readonly CharterKind[];
  /** Injectable so a test pins the record rather than the clock. */
  now?: () => string;
}): Promise<CharterPacketArchiveRow[]> {
  const now = params.now ?? (() => new Date().toISOString());
  const archiveDir = charterPacketArchiveDir(params.artifactsDir);
  const written: CharterPacketArchiveRow[] = [];

  for (const kind of params.kinds) {
    const sourceFilename = charterExtractionPacketFilename(kind);
    const sourcePath = join(laneAssetsDir(params.artifactsDir), sourceFilename);
    let bytes: Buffer;
    try {
      bytes = await readFile(sourcePath);
    } catch {
      continue; // No packet on disk — nothing was delivered to retain.
    }
    const digest = hashContent(bytes);
    const row: CharterPacketArchiveRow = {
      kind,
      sha256: digest,
      byte_length: bytes.byteLength,
      archived_at: now(),
      source_filename: sourceFilename,
      archived: false,
    };

    try {
      await mkdir(archiveDir, { recursive: true });
      const archivePath = join(
        archiveDir,
        charterPacketArchiveFilename(kind, digest),
      );
      await writeFile(archivePath, bytes);
      // Re-read and re-hash BEFORE unlinking: a write that reported success over
      // truncated or unflushed bytes must not be paid for with the only copy.
      const readBack = await readFile(archivePath);
      if (hashContent(readBack) !== digest) {
        row.reason = "archived bytes did not re-hash to the packet's digest";
      } else {
        row.archived = true;
      }
    } catch (error) {
      row.reason = `archive write failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (row.archived) {
      // Only now is the content somewhere else (P25-f). A failed unlink leaves a
      // verified archive plus a live source — recorded, never reported as clean.
      try {
        await unlink(sourcePath);
      } catch (error) {
        row.archived = false;
        row.reason = `packet archived but the lane-asset copy survived: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    written.push(row);
  }

  if (written.length === 0) return written;

  // The WHOLE index phase — read, merge, write — is inside one guard. The READ
  // was outside it, and that broke the never-throw contract on one platform
  // only: `readCharterPacketIndex` wraps its own IO failure (`Failed to read
  // <path>`) for anything it cannot classify as absent, and "absent" is decided
  // by an ENOENT test, while a path that traverses a FILE reports ENOENT on
  // win32 and ENOTDIR on POSIX. So the identical filesystem state read as an
  // empty index here and as a rejected promise in Linux CI. A directory in
  // place of the index file (EISDIR on both) escaped everywhere, as did a
  // malformed index, whose parse error is not an absence either.
  try {
    // The index ACCUMULATES — a re-extraction adds what it retained and never
    // overwrites the record of what an earlier lane read. Identical (kind,
    // digest, outcome) rows collapse: same bytes, same packet, already recorded.
    const existing = await readCharterPacketIndex(params.artifactsDir);
    const seen = new Set(
      existing.map((r) => `${r.kind}|${r.sha256}|${r.archived}`),
    );
    const merged = [...existing];
    for (const row of written) {
      const key = `${row.kind}|${row.sha256}|${row.archived}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      charterPacketIndexPath(params.artifactsDir),
      `${JSON.stringify(sortRows(merged), null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The index is a convenience over the archived files themselves; failing to
    // write it must not abort a fold whose ingest already succeeded. Nothing is
    // written when the existing rows could not be READ either — the write is
    // reached only through a successful read, so a failed read can never
    // overwrite the accumulated record this index exists to keep.
  }
  return written;
}
