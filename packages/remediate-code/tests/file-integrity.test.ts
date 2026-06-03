import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkAffectedFileIntegrity,
  hashFile,
  hashFileSync,
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

describe("checkAffectedFileIntegrity I/O-error classification (OBS-005)", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("reports an unreadable-but-present file via io_errors, not missing", async () => {
    // A directory at the affected path exists on disk but cannot be hashed:
    // readFile throws a non-ENOENT error (EISDIR/EPERM). It must be surfaced in
    // io_errors, NOT folded into missing.
    const rel = "as-a-dir";
    await mkdir(join(TEST_DIR, rel), { recursive: true });
    const findings = [mkFinding(rel)];
    findings[0].affected_files[0].hash_at_plan_time = "deadbeef";

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.io_errors).toContain(rel);
    expect(result.missing).not.toContain(rel);
    expect(result.is_clean).toBe(false);
  });

  it("reports an absent file as missing, not io_errors", async () => {
    const rel = "does-not-exist.ts";
    const findings = [mkFinding(rel)];
    findings[0].affected_files[0].hash_at_plan_time = "deadbeef";

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.missing).toContain(rel);
    expect(result.io_errors).not.toContain(rel);
    expect(result.is_clean).toBe(false);
  });

  it("is_clean is false whenever io_errors is non-empty", async () => {
    const rel = "dir-path";
    await mkdir(join(TEST_DIR, rel), { recursive: true });
    const findings = [mkFinding(rel)];
    findings[0].affected_files[0].hash_at_plan_time = "deadbeef";

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.io_errors.length).toBeGreaterThan(0);
    expect(result.is_clean).toBe(false);
  });

  it("a content change is reported as changed, not missing/io_errors", async () => {
    const rel = "changed.ts";
    await writeFile(join(TEST_DIR, rel), "original", "utf8");
    const findings = [mkFinding(rel)];
    snapshotAffectedFileHashes(TEST_DIR, findings);

    await writeFile(join(TEST_DIR, rel), "modified", "utf8");
    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.changed).toContain(rel);
    expect(result.missing).not.toContain(rel);
    expect(result.io_errors).not.toContain(rel);
    expect(result.is_clean).toBe(false);
  });
});

describe("hashFile / hashFileSync on a missing path", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("both return undefined for a non-existent path (existsSync-false branch)", async () => {
    const missing = join(TEST_DIR, "does-not-exist.ts");
    expect(hashFileSync(missing)).toBeUndefined();
    expect(await hashFile(missing)).toBeUndefined();
  });
});

describe("checkAffectedFileIntegrity missing-file classification (P2-OBSERVABILITY contract)", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("classifies an absent (deleted-after-plan) file as missing with is_clean false", async () => {
    const rel = "deleted.ts";
    await writeFile(join(TEST_DIR, rel), "original", "utf8");
    const findings = [mkFinding(rel)];
    // Baseline a hash, then delete the file so it is absent at check time.
    snapshotAffectedFileHashes(TEST_DIR, findings);
    expect(findings[0].affected_files[0].hash_at_plan_time).toBeTruthy();
    await rm(join(TEST_DIR, rel), { force: true });

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.missing).toContain(rel);
    expect(result.changed).not.toContain(rel);
    expect(result.is_clean).toBe(false);
  });

  it("ignores affected files that have no hash_at_plan_time", async () => {
    const rel = "unbaselined.ts";
    // The file exists but its finding never captured a plan-time hash, so the
    // integrity check must skip it entirely (clean result).
    const findings = [mkFinding(rel)];
    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.missing).not.toContain(rel);
    expect(result.changed).not.toContain(rel);
    expect(result.io_errors).not.toContain(rel);
    expect(result.is_clean).toBe(true);
  });
});
