import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole } from "./helpers/captureConsole.mjs";

test("captureConsole restores console and exitCode after successful call", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  const result = await captureConsole(() => {
    console.log("hello stdout");
    console.error("hello stderr");
    process.exitCode = 42;
  });

  assert.equal(console.log, originalLog, "console.log must be restored");
  assert.equal(console.error, originalError, "console.error must be restored");
  assert.equal(process.exitCode, originalExitCode, "process.exitCode must be restored");

  assert.match(result.stdout, /hello stdout/);
  assert.match(result.stderr, /hello stderr/);
  assert.equal(result.code, 42, "returned code should reflect exitCode set during fn()");
});

test("captureConsole restores console and exitCode even when fn throws", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  const boom = new Error("test error");
  await assert.rejects(
    () =>
      captureConsole(() => {
        console.log("before throw");
        throw boom;
      }),
    (error) => error === boom,
  );

  assert.equal(console.log, originalLog, "console.log must be restored after throw");
  assert.equal(console.error, originalError, "console.error must be restored after throw");
  assert.equal(process.exitCode, originalExitCode, "process.exitCode must be restored after throw");
});
