import test from "node:test";
import assert from "node:assert/strict";

const { summarizeLaunchExit, resolveHostDispatchCapability, optionalBooleanEnv } =
  await import("../src/cli/args.ts");

// ---------------------------------------------------------------------------
// summarizeLaunchExit
// ---------------------------------------------------------------------------

test("summarizeLaunchExit returns null on happy path: accepted=true, no error", () => {
  assert.strictEqual(summarizeLaunchExit({ accepted: true, exitCode: 0 }), null);
});

test("summarizeLaunchExit returns null on happy path: empty object (accepted not false, no error)", () => {
  assert.strictEqual(summarizeLaunchExit({}), null);
});

test("summarizeLaunchExit returns exit code string when accepted=false (no signal)", () => {
  const result = summarizeLaunchExit({ accepted: false, exitCode: 1 });
  assert.ok(result !== null, "expected non-null result");
  assert.ok(result.includes("exit code 1"), `expected 'exit code 1' in: ${result}`);
});

test("summarizeLaunchExit uses signal when present instead of exit code", () => {
  const result = summarizeLaunchExit({ accepted: false, signal: "SIGTERM" });
  assert.ok(result !== null, "expected non-null result");
  assert.ok(result.includes("signal SIGTERM"), `expected 'signal SIGTERM' in: ${result}`);
  assert.ok(!result.includes("exit code"), `expected no 'exit code' in: ${result}`);
});

test("summarizeLaunchExit includes error message when error is present (accepted omitted)", () => {
  const result = summarizeLaunchExit({ error: "spawn failed" });
  assert.ok(result !== null, "expected non-null result");
  assert.ok(result.includes("spawn failed"), `expected 'spawn failed' in: ${result}`);
});

test("summarizeLaunchExit includes optional command/stdoutPath/stderrPath when provided", () => {
  const result = summarizeLaunchExit({
    accepted: false,
    exitCode: 2,
    command: "node foo.js",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
  });
  assert.ok(result !== null, "expected non-null result");
  assert.ok(result.includes("command: node foo.js"), `expected command in: ${result}`);
  assert.ok(result.includes("stdout: /tmp/out.log"), `expected stdout in: ${result}`);
  assert.ok(result.includes("stderr: /tmp/err.log"), `expected stderr in: ${result}`);
});

test("summarizeLaunchExit omits optional fields when absent", () => {
  const result = summarizeLaunchExit({ accepted: false, exitCode: 1 });
  assert.ok(result !== null, "expected non-null result");
  assert.ok(!result.includes("command:"), `unexpected 'command:' in: ${result}`);
  assert.ok(!result.includes("stdout:"), `unexpected 'stdout:' in: ${result}`);
  assert.ok(!result.includes("stderr:"), `unexpected 'stderr:' in: ${result}`);
});

// ---------------------------------------------------------------------------
// resolveHostDispatchCapability
// ---------------------------------------------------------------------------

test("resolveHostDispatchCapability: explicit=true wins over sessionConfig false and env false", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      explicit: true,
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: false }),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "false" },
    }),
    true,
  );
});

test("resolveHostDispatchCapability: explicit=false wins over sessionConfig true and env true", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      explicit: false,
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: true }),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" },
    }),
    false,
  );
});

test("resolveHostDispatchCapability: sessionConfig false wins when explicit is undefined", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: false }),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" },
    }),
    false,
  );
});

test("resolveHostDispatchCapability: sessionConfig true wins when explicit is undefined", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: true }),
    }),
    true,
  );
});

test("resolveHostDispatchCapability: env AUDIT_CODE_HOST_CAN_DISPATCH=false used when explicit and sessionConfig both absent", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "false" },
    }),
    false,
  );
});

test("resolveHostDispatchCapability: env AUDIT_CODE_HOST_CAN_DISPATCH=true used when explicit and sessionConfig both absent", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" },
    }),
    true,
  );
});

test("resolveHostDispatchCapability: defaults to true when all inputs absent", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: {},
    }),
    true,
  );
});

test("resolveHostDispatchCapability: garbage env var value falls back to default true", () => {
  assert.strictEqual(
    resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "yes" },
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// optionalBooleanEnv
// ---------------------------------------------------------------------------

test("optionalBooleanEnv: 'true' → true", () => {
  assert.strictEqual(optionalBooleanEnv("true"), true);
});

test("optionalBooleanEnv: 'false' → false", () => {
  assert.strictEqual(optionalBooleanEnv("false"), false);
});

test("optionalBooleanEnv: undefined → undefined", () => {
  assert.strictEqual(optionalBooleanEnv(undefined), undefined);
});

test("optionalBooleanEnv: empty string → undefined", () => {
  assert.strictEqual(optionalBooleanEnv(""), undefined);
});

test("optionalBooleanEnv: '1' → undefined", () => {
  assert.strictEqual(optionalBooleanEnv("1"), undefined);
});

test("optionalBooleanEnv: 'yes' → undefined", () => {
  assert.strictEqual(optionalBooleanEnv("yes"), undefined);
});

test("optionalBooleanEnv: 'TRUE' (uppercase) → undefined", () => {
  assert.strictEqual(optionalBooleanEnv("TRUE"), undefined);
});
