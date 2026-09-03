// Charter evidence-packet RETENTION (PACKETS-CONSUMED).
//
// Nothing pinned the deletion before this file: a grep across tests/ found no
// packet-existence assertion in either direction, so the packets had zero
// regression protection while being destroyed at ingest.
//
// The RED assertion is "the archive exists with the emitted bytes and the index
// row matches". The unlink is a GUARD — it already passes against the unfixed
// tree, so it cannot be the red.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneAssetsDir } from "audit-tools/shared";
import { charterExtractionPacketFilename } from "../../src/audit/cli/laneSubmissions.js";
import {
  archiveCharterPackets,
  charterPacketArchiveDir,
  charterPacketArchiveFilename,
  charterPacketIndexPath,
  readCharterPacketIndex,
  type CharterPacketArchiveRow,
} from "../../src/audit/orchestrator/charterPacketArchive.js";

const STATED_BYTES = "# stated packet\n\nComments extracted from: src/a.ts\n";
const REVEALED_BYTES = "# revealed packet\n\nComment-stripped source: src/a.ts\n";

let artifactsDir: string;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writePacket(kind: "stated" | "revealed", body: string): Promise<string> {
  const dir = laneAssetsDir(artifactsDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, charterExtractionPacketFilename(kind));
  await writeFile(path, body, "utf8");
  return path;
}

beforeEach(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), "charter-packet-retention-"));
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

describe("archiveCharterPackets — the bytes survive the ingest that consumes them", () => {
  it("retains the exact packet bytes under charter-packets/, keyed by content hash", async () => {
    await writePacket("stated", STATED_BYTES);
    const rows = await archiveCharterPackets({
      artifactsDir,
      kinds: ["stated"],
      now: () => "2026-09-03T00:00:00.000Z",
    });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.archived).toBe(true);
    expect(row.reason).toBeUndefined();

    // THE RED: the archived file exists and holds byte-identical evidence.
    const archivePath = join(
      charterPacketArchiveDir(artifactsDir),
      charterPacketArchiveFilename("stated", row.sha256),
    );
    expect(await exists(archivePath)).toBe(true);
    expect(await readFile(archivePath, "utf8")).toBe(STATED_BYTES);
    expect(row.byte_length).toBe(Buffer.byteLength(STATED_BYTES));
  });

  it("writes an index row whose digest identifies the archived bytes", async () => {
    await writePacket("stated", STATED_BYTES);
    await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });

    const index = await readCharterPacketIndex(artifactsDir);
    expect(index).toHaveLength(1);
    const row = index[0]!;
    expect(row.kind).toBe("stated");
    expect(row.source_filename).toBe(charterExtractionPacketFilename("stated"));
    expect(row.archived).toBe(true);
    const archived = await readFile(
      join(
        charterPacketArchiveDir(artifactsDir),
        charterPacketArchiveFilename("stated", row.sha256),
      ),
    );
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(archived).digest("hex")).toBe(row.sha256);
  });

  it("GUARD: the emitter's read path is empty afterwards, exactly as before", async () => {
    // Preserved verbatim: a stale packet left behind would feed a later
    // staleness-triggered re-extraction yesterday's evidence.
    const sourcePath = await writePacket("stated", STATED_BYTES);
    await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });
    expect(await exists(sourcePath)).toBe(false);
  });

  it("skips a kind whose packet is not on disk, and records nothing for it", async () => {
    await writePacket("stated", STATED_BYTES);
    const rows = await archiveCharterPackets({
      artifactsDir,
      kinds: ["stated", "revealed"],
    });
    expect(rows.map((r) => r.kind)).toEqual(["stated"]);
  });

  it("ACCUMULATES across re-extractions instead of overwriting the earlier record", async () => {
    await writePacket("stated", STATED_BYTES);
    await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });
    // A re-extraction against a moved tree produces DIFFERENT evidence.
    await writePacket("stated", `${STATED_BYTES}Doc: README.md\n`);
    await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });

    const index = await readCharterPacketIndex(artifactsDir);
    expect(index).toHaveLength(2);
    for (const row of index) {
      expect(
        await exists(
          join(
            charterPacketArchiveDir(artifactsDir),
            charterPacketArchiveFilename("stated", row.sha256),
          ),
        ),
      ).toBe(true);
    }
  });

  it("collapses an identical re-archive — the same bytes are the same packet", async () => {
    await writePacket("stated", STATED_BYTES);
    await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });
    await writePacket("stated", STATED_BYTES);
    await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });
    expect(await readCharterPacketIndex(artifactsDir)).toHaveLength(1);
  });

  it("is order-stable: kind, then digest", async () => {
    await writePacket("revealed", REVEALED_BYTES);
    await writePacket("stated", STATED_BYTES);
    await archiveCharterPackets({ artifactsDir, kinds: ["revealed", "stated"] });
    const index = await readCharterPacketIndex(artifactsDir);
    expect(index.map((r) => r.kind)).toEqual(["revealed", "stated"]);
  });
});

describe("archiveCharterPackets — a failed archive is STATED, never silent", () => {
  it("keeps the source and records archived:false when the archive cannot be written", async () => {
    const sourcePath = await writePacket("stated", STATED_BYTES);
    // Occupy the archive directory's path with a FILE, so mkdir/write fail.
    await writeFile(charterPacketArchiveDir(artifactsDir), "not a directory", "utf8");

    const rows = await archiveCharterPackets({ artifactsDir, kinds: ["stated"] });
    expect(rows).toHaveLength(1);
    const row: CharterPacketArchiveRow = rows[0]!;
    expect(row.archived).toBe(false);
    expect(row.reason).toBeTruthy();
    // The source SURVIVES — a lost archive must never cost the only copy.
    expect(await exists(sourcePath)).toBe(true);
    // ...and the digest still identifies what was not retained.
    expect(row.sha256).toHaveLength(64);
  });

  it("never throws — it runs after ingest has already applied the submission", async () => {
    await writePacket("stated", STATED_BYTES);
    await writeFile(charterPacketArchiveDir(artifactsDir), "not a directory", "utf8");
    await expect(
      archiveCharterPackets({ artifactsDir, kinds: ["stated"] }),
    ).resolves.toBeDefined();
    // The index write also fails here; that must not surface as a throw either.
    expect(await exists(charterPacketIndexPath(artifactsDir))).toBe(false);
  });
});
