import { test, expect } from "vitest";
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

  expect(console.log, "console.log must be restored").toBe(originalLog);
  expect(console.error, "console.error must be restored").toBe(originalError);
  expect(process.exitCode, "process.exitCode must be restored").toBe(originalExitCode);

  expect(result.stdout).toMatch(/hello stdout/);
  expect(result.stderr).toMatch(/hello stderr/);
  expect(result.code, "returned code should reflect exitCode set during fn()").toBe(42);
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

  expect(console.log, "console.log must be restored after throw").toBe(originalLog);
  expect(console.error, "console.error must be restored after throw").toBe(originalError);
  expect(process.exitCode, "process.exitCode must be restored after throw").toBe(originalExitCode);
});
