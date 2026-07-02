import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { isTransientFsError, withFsRetry, writeJsonFile, readJsonFile } =
  await import("../../src/shared/io/json.ts");

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

test("isTransientFsError flags Windows lock codes only", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES", "EEXIST"]) {
    expect(isTransientFsError(fsError(code)), code).toBe(true);
  }
  expect(isTransientFsError(fsError("ENOENT"))).toBe(false);
  expect(isTransientFsError(new Error("no code"))).toBe(false);
  expect(isTransientFsError(null)).toBe(false);
});

test("withFsRetry retries transient errors then succeeds", async () => {
  let calls = 0;
  const result = await withFsRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw fsError("EPERM");
      return "ok";
    },
    { sleep: async () => {} },
  );
  expect(result).toBe("ok");
  expect(calls).toBe(3);
});

test("withFsRetry rethrows non-transient errors immediately", async () => {
  let calls = 0;
  await assert.rejects(
    withFsRetry(
      async () => {
        calls += 1;
        throw fsError("ENOENT");
      },
      { sleep: async () => {} },
    ),
    /ENOENT/,
  );
  expect(calls).toBe(1);
});

test("withFsRetry gives up after the attempt budget", async () => {
  let calls = 0;
  await assert.rejects(
    withFsRetry(
      async () => {
        calls += 1;
        throw fsError("EBUSY");
      },
      { attempts: 4, sleep: async () => {} },
    ),
    /EBUSY/,
  );
  expect(calls).toBe(4);
});

test("writeJsonFile round-trips and survives concurrent writers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-json-"));
  try {
    const path = join(dir, "out.json");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => writeJsonFile(path, { i })),
    );
    const parsed = await readJsonFile(path);
    expect(typeof parsed.i).toBe("number");
    const raw = await readFile(path, "utf8");
    expect(raw).toMatch(/\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Single-source guarantee: writeJsonFile (the ONLY atomic JSON writer) must clean
// up its temp file even when the durable rename fails. Both orchestrators' state
// stores / ledgers depend on this — they hold the lock and delegate the write
// here, carrying no temp/rename of their own. Forcing the rename to fail by
// pointing the destination at an existing directory.
test("writeJsonFile removes its temp file when the durable write fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-json-fail-"));
  try {
    // Make the destination path an existing directory so the temp→dest rename
    // cannot succeed (EISDIR/EPERM/ENOTEMPTY across platforms).
    const path = join(dir, "occupied");
    await mkdir(path, { recursive: true });

    await assert.rejects(writeJsonFile(path, { a: 1 }), /Failed to write/);

    // No `.tmp` residue may linger in the temp's parent directory.
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers, `writeJsonFile must clean up its temp file on failure; found: ${leftovers.join(", ")}`).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
