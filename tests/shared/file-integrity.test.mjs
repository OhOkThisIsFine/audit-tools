import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkFileIntegrityRecords } = await import(
  "../../src/shared/fileIntegrity.ts"
);

/**
 * Covers the generic classify-and-bucket loop behind audit-code's
 * checkFileIntegrity and remediate-code's checkAffectedFileIntegrity — both now
 * thin adapters over this shared core (Tier B extraction A).
 */

test("checkFileIntegrityRecords: unchanged file yields no buckets and is_clean=true", async () => {
  const root = await mkdtemp(join(tmpdir(), "fi-"));
  try {
    const filePath = "a.txt";
    await writeFile(join(root, filePath), "hello");
    const { existsSync } = await import("node:fs");

    const buckets = await checkFileIntegrityRecords({
      records: [{ path: filePath, hash: "same-hash" }],
      getPath: (r) => r.path,
      getExpectedHash: (r) => r.hash,
      resolveAbsolute: (p) => join(root, p),
      exists: existsSync,
      hash: async () => ({ kind: "ok", hash: "same-hash" }),
    });

    expect(buckets.changed).toEqual([]);
    expect(buckets.missing).toEqual([]);
    expect(buckets.ioErrors).toEqual([]);
    expect(buckets.isClean).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkFileIntegrityRecords: mismatched hash buckets into changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "fi-"));
  try {
    const filePath = "a.txt";
    await writeFile(join(root, filePath), "hello");
    const { existsSync } = await import("node:fs");

    const buckets = await checkFileIntegrityRecords({
      records: [{ path: filePath, hash: "old-hash" }],
      getPath: (r) => r.path,
      getExpectedHash: (r) => r.hash,
      resolveAbsolute: (p) => join(root, p),
      exists: existsSync,
      hash: async () => ({ kind: "ok", hash: "new-hash" }),
    });

    expect(buckets.changed).toEqual([filePath]);
    expect(buckets.isClean).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkFileIntegrityRecords: absent path (exists=false) buckets into missing without calling hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "fi-"));
  try {
    let hashCalled = false;
    const buckets = await checkFileIntegrityRecords({
      records: [{ path: "missing.txt", hash: "h" }],
      getPath: (r) => r.path,
      getExpectedHash: (r) => r.hash,
      resolveAbsolute: (p) => join(root, p),
      exists: () => false,
      hash: async () => {
        hashCalled = true;
        return { kind: "ok", hash: "h" };
      },
    });

    expect(buckets.missing).toEqual(["missing.txt"]);
    expect(hashCalled, "hash() must not be called once exists() says no").toBe(false);
    expect(buckets.isClean).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkFileIntegrityRecords: hash() reporting 'missing' (race after exists check) buckets into missing", async () => {
  const buckets = await checkFileIntegrityRecords({
    records: [{ path: "raced.txt", hash: "h" }],
    getPath: (r) => r.path,
    getExpectedHash: (r) => r.hash,
    resolveAbsolute: (p) => p,
    exists: () => true,
    hash: async () => ({ kind: "missing" }),
  });

  expect(buckets.missing).toEqual(["raced.txt"]);
  expect(buckets.changed).toEqual([]);
  expect(buckets.ioErrors).toEqual([]);
});

test("checkFileIntegrityRecords: hash() reporting 'io_error' buckets into ioErrors distinctly from missing", async () => {
  const buckets = await checkFileIntegrityRecords({
    records: [{ path: "locked.txt", hash: "h" }],
    getPath: (r) => r.path,
    getExpectedHash: (r) => r.hash,
    resolveAbsolute: (p) => p,
    exists: () => true,
    hash: async () => ({ kind: "io_error" }),
  });

  expect(buckets.ioErrors).toEqual(["locked.txt"]);
  expect(buckets.missing).toEqual([]);
  expect(buckets.isClean).toBe(false);
});

test("checkFileIntegrityRecords: records with no expected hash are skipped entirely", async () => {
  let hashCalled = false;
  const buckets = await checkFileIntegrityRecords({
    records: [{ path: "unhashed.txt", hash: undefined }],
    getPath: (r) => r.path,
    getExpectedHash: (r) => r.hash,
    resolveAbsolute: (p) => p,
    exists: () => true,
    hash: async () => {
      hashCalled = true;
      return { kind: "ok", hash: "x" };
    },
  });

  expect(hashCalled).toBe(false);
  expect(buckets.changed).toEqual([]);
  expect(buckets.missing).toEqual([]);
  expect(buckets.ioErrors).toEqual([]);
  expect(buckets.isClean).toBe(true);
});

test("checkFileIntegrityRecords: mixed records yield independent buckets, order-preserving", async () => {
  const buckets = await checkFileIntegrityRecords({
    records: [
      { path: "unchanged.txt", hash: "h1" },
      { path: "changed.txt", hash: "h2" },
      { path: "gone.txt", hash: "h3" },
      { path: "broken.txt", hash: "h4" },
    ],
    getPath: (r) => r.path,
    getExpectedHash: (r) => r.hash,
    resolveAbsolute: (p) => p,
    exists: (p) => p !== "gone.txt",
    hash: async (absolute) => {
      if (absolute === "broken.txt") return { kind: "io_error" };
      if (absolute === "changed.txt") return { kind: "ok", hash: "different" };
      return { kind: "ok", hash: absolute === "unchanged.txt" ? "h1" : "unused" };
    },
  });

  expect(buckets.changed).toEqual(["changed.txt"]);
  expect(buckets.missing).toEqual(["gone.txt"]);
  expect(buckets.ioErrors).toEqual(["broken.txt"]);
  expect(buckets.isClean).toBe(false);
});
