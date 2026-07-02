import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { withTempDir } from "./helpers/withTempDir.mjs";

test("withTempDir creates a temp directory, passes it to the callback, and removes it on success", async () => {
  let capturedDir;
  await withTempDir("audit-code-withTempDir-test-", async (dir) => {
    capturedDir = dir;
    // The directory exists inside the callback.
    await access(dir);
    // The directory name starts with the given prefix.
    expect(dir.includes("audit-code-withTempDir-test-"), `expected dir to contain prefix, got: ${dir}`).toBeTruthy();
  });
  // The directory is removed after the callback returns.
  await assert.rejects(
    () => access(capturedDir),
    (err) => err.code === "ENOENT",
    "directory should be removed after callback returns",
  );
});

test("withTempDir removes the temp directory even when the callback throws", async () => {
  let capturedDir;
  const boom = new Error("intentional test error");
  await assert.rejects(
    () =>
      withTempDir("audit-code-withTempDir-test-", async (dir) => {
        capturedDir = dir;
        throw boom;
      }),
    (err) => err === boom,
    "original error should be re-thrown",
  );
  // The directory is removed despite the callback throwing.
  await assert.rejects(
    () => access(capturedDir),
    (err) => err.code === "ENOENT",
    "directory should be removed even when callback throws",
  );
});
