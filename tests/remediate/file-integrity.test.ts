import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdir, rm, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "../../src/remediate/state/types.js";
import {
  checkAffectedFileIntegrity,
  hashAffectedPath,
  hashFile,
  snapshotAffectedFileHashes,
} from "../../src/remediate/utils/fileIntegrity.js";
import { scratchDir } from "../helpers/scratch.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-file-integrity");
const OUTSIDE_A = scratchDir(".test-file-integrity-outside-a");
const OUTSIDE_B = scratchDir(".test-file-integrity-outside-b");

function mkFinding(path: string): Finding {
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

  it("snapshot preserves an existing hash rather than overwriting it", async () => {
    const rel = "x.ts";
    await writeFile(join(TEST_DIR, rel), "v1", "utf8");
    const findings = [mkFinding(rel)];

    snapshotAffectedFileHashes(TEST_DIR, findings);
    const h1 = findings[0].affected_files[0].hash_at_plan_time;
    expect(h1).toBeTruthy();

    await writeFile(join(TEST_DIR, rel), "v2", "utf8");
    snapshotAffectedFileHashes(TEST_DIR, findings); // must NOT overwrite an existing hash
    expect(findings[0].affected_files[0].hash_at_plan_time).toBe(h1);
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

  it("reports a directory digest mismatch as changed, not missing or io_errors", async () => {
    const rel = "as-a-dir";
    await mkdir(join(TEST_DIR, rel), { recursive: true });
    await writeFile(join(TEST_DIR, rel, "nested.ts"), "original", "utf8");
    const findings = [mkFinding(rel)];
    findings[0].affected_files[0].hash_at_plan_time = "deadbeef";

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.changed).toContain(rel);
    expect(result.missing).not.toContain(rel);
    expect(result.io_errors).not.toContain(rel);
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

  it("snapshotAffectedFileHashes records a directory digest that runtime integrity accepts", async () => {
    const rel = "dir-path";
    await mkdir(join(TEST_DIR, rel, "nested"), { recursive: true });
    await writeFile(join(TEST_DIR, rel, "nested", "a.ts"), "a", "utf8");
    const findings = [mkFinding(rel)];

    snapshotAffectedFileHashes(TEST_DIR, findings);

    expect(findings[0].affected_files[0].hash_at_plan_time).toBe(
      await hashAffectedPath(TEST_DIR, rel),
    );
    expect(await checkAffectedFileIntegrity(TEST_DIR, findings)).toEqual({
      changed: [],
      missing: [],
      io_errors: [],
      is_clean: true,
    });
  });

  it("refuses a top-level directory symlink as a trusted affected path", async () => {
    const target = join(TEST_DIR, "directory-target");
    const link = join(TEST_DIR, "directory-link");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "a.ts"), "a", "utf8");
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => snapshotAffectedFileHashes(TEST_DIR, [mkFinding("directory-link")])).toThrow(
      /top-level symlinks cannot become trusted affected paths/u,
    );
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

describe("directory affected_files hashing", () => {
  beforeEach(async () => {
    await Promise.all(
      [TEST_DIR, OUTSIDE_A, OUTSIDE_B].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await Promise.all(
      [TEST_DIR, OUTSIDE_A, OUTSIDE_B].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  it("detects nested file changes under a directory affected_files path", async () => {
    const rel = "src";
    await mkdir(join(TEST_DIR, rel), { recursive: true });
    await writeFile(join(TEST_DIR, rel, "a.ts"), "a1", "utf8");
    const findings = [mkFinding(rel)];

    findings[0].affected_files[0].hash_at_plan_time = await hashAffectedPath(TEST_DIR, rel);
    await writeFile(join(TEST_DIR, rel, "a.ts"), "a2", "utf8");

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(result.changed).toContain(rel);
    expect(result.missing).toEqual([]);
    expect(result.io_errors).toEqual([]);
  });

  it("detects nested file additions and removals under a directory affected_files path", async () => {
    const rel = "lib";
    await mkdir(join(TEST_DIR, rel), { recursive: true });
    await writeFile(join(TEST_DIR, rel, "a.ts"), "a", "utf8");
    const findings = [mkFinding(rel)];

    findings[0].affected_files[0].hash_at_plan_time = await hashAffectedPath(TEST_DIR, rel);
    await writeFile(join(TEST_DIR, rel, "b.ts"), "b", "utf8");
    expect((await checkAffectedFileIntegrity(TEST_DIR, findings)).changed).toContain(rel);

    findings[0].affected_files[0].hash_at_plan_time = await hashAffectedPath(TEST_DIR, rel);
    await rm(join(TEST_DIR, rel, "a.ts"), { force: true });
    const removed = await checkAffectedFileIntegrity(TEST_DIR, findings);
    expect(removed.changed).toContain(rel);
    expect(removed.missing).toEqual([]);
    expect(removed.io_errors).toEqual([]);
  });

  it("hashes symlink identity without reading its outside-root target", async () => {
    const rel = "links";
    const link = join(TEST_DIR, rel, "external");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await Promise.all([
      mkdir(join(TEST_DIR, rel), { recursive: true }),
      mkdir(OUTSIDE_A, { recursive: true }),
      mkdir(OUTSIDE_B, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(OUTSIDE_A, "value.txt"), "a1", "utf8"),
      writeFile(join(OUTSIDE_B, "value.txt"), "b1", "utf8"),
    ]);
    await symlink(OUTSIDE_A, link, linkType);

    const original = [mkFinding(rel)];
    snapshotAffectedFileHashes(TEST_DIR, original);
    await writeFile(join(OUTSIDE_A, "value.txt"), "a2", "utf8");
    expect((await checkAffectedFileIntegrity(TEST_DIR, original)).is_clean).toBe(
      true,
    );

    await unlink(link);
    await symlink(OUTSIDE_B, link, linkType);
    expect((await checkAffectedFileIntegrity(TEST_DIR, original)).changed).toEqual([
      rel,
    ]);

    const retargeted = [mkFinding(rel)];
    snapshotAffectedFileHashes(TEST_DIR, retargeted);
    await unlink(link);
    expect(
      (await checkAffectedFileIntegrity(TEST_DIR, retargeted)).changed,
    ).toEqual([rel]);

    const absent = [mkFinding(rel)];
    snapshotAffectedFileHashes(TEST_DIR, absent);
    await symlink(OUTSIDE_A, link, linkType);
    expect((await checkAffectedFileIntegrity(TEST_DIR, absent)).changed).toEqual([
      rel,
    ]);
  });

  it("rejects a directory replaced by an identical outside-root junction before traversal", async () => {
    const rel = "replaceable";
    const affectedDirectory = join(TEST_DIR, rel);
    await mkdir(affectedDirectory, { recursive: true });
    await writeFile(join(affectedDirectory, "value.txt"), "same", "utf8");
    const findings = [mkFinding(rel)];
    snapshotAffectedFileHashes(TEST_DIR, findings);

    await rm(affectedDirectory, { recursive: true, force: true });
    await mkdir(OUTSIDE_A, { recursive: true });
    await writeFile(join(OUTSIDE_A, "value.txt"), "same", "utf8");
    await symlink(
      OUTSIDE_A,
      affectedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    vi.mocked(readdir).mockClear();

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);

    expect(result).toEqual({
      changed: [],
      missing: [],
      io_errors: [rel],
      is_clean: false,
    });
    expect(readdir).not.toHaveBeenCalled();
  });

  it("rejects an ancestor replaced by an identical outside-root junction before traversal", async () => {
    const rel = "parent/replaceable";
    const parentDirectory = join(TEST_DIR, "parent");
    const affectedDirectory = join(TEST_DIR, rel);
    await mkdir(affectedDirectory, { recursive: true });
    await writeFile(join(affectedDirectory, "value.txt"), "same", "utf8");
    const findings = [mkFinding(rel)];
    snapshotAffectedFileHashes(TEST_DIR, findings);

    await rm(parentDirectory, { recursive: true, force: true });
    await mkdir(join(OUTSIDE_A, "replaceable"), { recursive: true });
    await writeFile(
      join(OUTSIDE_A, "replaceable", "value.txt"),
      "same",
      "utf8",
    );
    await symlink(
      OUTSIDE_A,
      parentDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    vi.mocked(readdir).mockClear();

    const result = await checkAffectedFileIntegrity(TEST_DIR, findings);

    expect(result).toEqual({
      changed: [],
      missing: [],
      io_errors: [rel],
      is_clean: false,
    });
    expect(readdir).not.toHaveBeenCalled();
  });

  it("preserves planning/runtime digest parity through an in-root ancestor junction", async () => {
    const targetParent = join(TEST_DIR, "target-parent");
    const affectedTarget = join(targetParent, "affected");
    const aliasParent = join(TEST_DIR, "alias-parent");
    await mkdir(affectedTarget, { recursive: true });
    await writeFile(join(affectedTarget, "value.txt"), "same", "utf8");
    await symlink(
      targetParent,
      aliasParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    const findings = [mkFinding("alias-parent/affected")];

    snapshotAffectedFileHashes(TEST_DIR, findings);

    expect(await checkAffectedFileIntegrity(TEST_DIR, findings)).toEqual({
      changed: [],
      missing: [],
      io_errors: [],
      is_clean: true,
    });
  });

});

describe("hashFile on a missing path", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns undefined for a non-existent path (existsSync-false branch)", async () => {
    const missing = join(TEST_DIR, "does-not-exist.ts");
    expect(await hashFile(missing)).toBeUndefined();
  });
});

describe("reportHashIoError structured JSON stderr (OBS-05407856)", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("emits a structured JSON line to stderr for direct hashFile non-ENOENT errors (EACCES via EISDIR)", async () => {
    // Use a directory path so readFile throws a non-ENOENT error (EISDIR).
    const rel = "dir-as-file";
    await mkdir(join(TEST_DIR, rel), { recursive: true });

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const spy = (...args: Parameters<typeof original>): boolean => {
      written.push(String(args[0]));
      return original(...args);
    };
    process.stderr.write = spy as typeof process.stderr.write;
    try {
      await hashFile(join(TEST_DIR, rel));
    } finally {
      process.stderr.write = original;
    }

    expect(written.length).toBeGreaterThan(0);
    const parsed = JSON.parse(written[0]);
    expect(parsed.level).toBe("warn");
    expect(parsed.event).toBe("file_integrity_io_error");
    // code is EISDIR or similar non-ENOENT
    expect(parsed.code).not.toBeNull();
    expect(parsed.code).not.toBe("ENOENT");
  });

  it("the emitted JSON includes a ts field that is a valid ISO 8601 timestamp string", async () => {
    const rel = "dir-for-ts-check";
    await mkdir(join(TEST_DIR, rel), { recursive: true });

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const spy = (...args: Parameters<typeof original>): boolean => {
      written.push(String(args[0]));
      return original(...args);
    };
    process.stderr.write = spy as typeof process.stderr.write;
    try {
      await hashFile(join(TEST_DIR, rel));
    } finally {
      process.stderr.write = original;
    }

    expect(written.length).toBeGreaterThan(0);
    const parsed = JSON.parse(written[0]);
    expect(typeof parsed.ts).toBe("string");
    expect(isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it("does NOT call process.stderr.write when the error code is ENOENT", async () => {
    // hashFile on a path that does not exist returns undefined silently (ENOENT guard).
    const missing = join(TEST_DIR, "not-here.ts");
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const spy = (...args: Parameters<typeof original>): boolean => {
      written.push(String(args[0]));
      return original(...args);
    };
    process.stderr.write = spy as typeof process.stderr.write;
    try {
      await hashFile(missing);
    } finally {
      process.stderr.write = original;
    }

    // Nothing should have been written (existsSync guard returns early before readFile)
    const ioLines = written.filter((l) => l.includes("file_integrity_io_error"));
    expect(ioLines.length).toBe(0);
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
