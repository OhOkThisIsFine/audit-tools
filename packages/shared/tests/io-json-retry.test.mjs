import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { isTransientFsError, withFsRetry, writeJsonFile, readJsonFile } =
  await import("../dist/io/json.js");

function fsError(code) {
  return Object.assign(new Error(code), { code });
}

test("isTransientFsError flags Windows lock codes only", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES", "EEXIST"]) {
    assert.equal(isTransientFsError(fsError(code)), true, code);
  }
  assert.equal(isTransientFsError(fsError("ENOENT")), false);
  assert.equal(isTransientFsError(new Error("no code")), false);
  assert.equal(isTransientFsError(null), false);
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
  assert.equal(result, "ok");
  assert.equal(calls, 3);
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
  assert.equal(calls, 1);
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
  assert.equal(calls, 4);
});

test("writeJsonFile round-trips and survives concurrent writers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-json-"));
  try {
    const path = join(dir, "out.json");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => writeJsonFile(path, { i })),
    );
    const parsed = await readJsonFile(path);
    assert.equal(typeof parsed.i, "number");
    const raw = await readFile(path, "utf8");
    assert.match(raw, /\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
