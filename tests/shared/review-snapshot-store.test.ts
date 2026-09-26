import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewSnapshotStore } from "../../src/shared/reReview/reviewSnapshotStore.js";

describe("createReviewSnapshotStore (CY-07)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "review-snapshot-test-"));
    tempDirs.push(dir);
    return dir;
  }

  interface TestSnapshot {
    schema_version: string;
    id: string;
    payload: string;
    legacy_optional?: string;
  }

  const store = createReviewSnapshotStore<TestSnapshot>({
    dirPath: (artifactsDir) => join(artifactsDir, "snapshots"),
    schemaVersion: "v1.0",
    keyOf: (snapshot) => snapshot.id,
  });

  it("resolves directory and file paths correctly", async () => {
    const artifactsDir = await makeTempDir();
    expect(store.dir(artifactsDir)).toBe(join(artifactsDir, "snapshots"));
    expect(store.path(artifactsDir, "phaseA")).toBe(
      join(artifactsDir, "snapshots", "phaseA.json"),
    );
  });

  it("writes and reads back a snapshot record", async () => {
    const artifactsDir = await makeTempDir();
    const record: TestSnapshot = {
      schema_version: "v1.0",
      id: "phaseA",
      payload: "verdict-1",
    };
    await store.write(artifactsDir, record);
    const read = await store.read(artifactsDir, "phaseA");
    expect(read).toEqual(record);
  });

  it("returns null when reading an absent snapshot", async () => {
    const artifactsDir = await makeTempDir();
    const read = await store.read(artifactsDir, "nonexistent");
    expect(read).toBeNull();
  });

  it("discards and returns null on schema_version mismatch (regenerable state)", async () => {
    const artifactsDir = await makeTempDir();
    const record: TestSnapshot = {
      schema_version: "v0.9-stale",
      id: "phaseA",
      payload: "old-verdict",
    };
    await store.write(artifactsDir, record);
    const read = await store.read(artifactsDir, "phaseA");
    expect(read).toBeNull();
  });

  it("preserves legacy records with omitted optional fields", async () => {
    const artifactsDir = await makeTempDir();
    // Persist a record without the optional field.
    await store.write(artifactsDir, {
      schema_version: "v1.0",
      id: "legacyPhase",
      payload: "legacy-content",
    });
    const read = await store.read(artifactsDir, "legacyPhase");
    expect(read).not.toBeNull();
    expect(read?.payload).toBe("legacy-content");
    expect(read?.legacy_optional).toBeUndefined();
  });
});
