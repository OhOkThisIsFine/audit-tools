import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkAffectedFileIntegrity,
  snapshotAffectedFileHashes,
  resnapshotAffectedFileHashes,
} from "../src/utils/fileIntegrity.js";

const TEST_DIR = join(__dirname, ".test-file-integrity");

function mkFinding(path: string): any {
  return {
    id: "F-1",
    title: "t",
    category: "c",
    severity: "low",
    confidence: "low",
    lens: "correctness",
    summary: "s",
    affected_files: [{ path }],
    evidence: ["e"],
  };
}

describe("fileIntegrity re-snapshot", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("detects a changed file, then re-snapshot re-baselines so integrity is clean", async () => {
    const rel = "src.ts";
    await writeFile(join(TEST_DIR, rel), "original", "utf8");
    const findings = [mkFinding(rel)];

    // initial baseline
    snapshotAffectedFileHashes(TEST_DIR, findings);
    expect((await checkAffectedFileIntegrity(TEST_DIR, findings)).is_clean).toBe(true);

    // the implement phase legitimately rewrites the file
    await writeFile(join(TEST_DIR, rel), "rewritten by implement", "utf8");
    expect((await checkAffectedFileIntegrity(TEST_DIR, findings)).is_clean).toBe(false);

    // re-baseline (what mergeImplementResults now does) -> integrity clean again
    resnapshotAffectedFileHashes(TEST_DIR, findings);
    expect((await checkAffectedFileIntegrity(TEST_DIR, findings)).is_clean).toBe(true);
  });

  it("snapshot preserves an existing hash, but resnapshot forces an update", async () => {
    const rel = "x.ts";
    await writeFile(join(TEST_DIR, rel), "v1", "utf8");
    const findings = [mkFinding(rel)];

    snapshotAffectedFileHashes(TEST_DIR, findings);
    const h1 = findings[0].affected_files[0].hash_at_plan_time;
    expect(h1).toBeTruthy();

    await writeFile(join(TEST_DIR, rel), "v2", "utf8");
    snapshotAffectedFileHashes(TEST_DIR, findings); // must NOT overwrite an existing hash
    expect(findings[0].affected_files[0].hash_at_plan_time).toBe(h1);

    resnapshotAffectedFileHashes(TEST_DIR, findings); // forces re-baseline to current
    expect(findings[0].affected_files[0].hash_at_plan_time).not.toBe(h1);
  });
});
