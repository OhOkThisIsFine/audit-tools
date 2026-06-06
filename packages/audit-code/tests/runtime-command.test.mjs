import test from "node:test";
import assert from "node:assert/strict";

const { runCommand } = await import("../src/orchestrator/runtimeCommand.ts");

// ---------------------------------------------------------------------------
// runCommand: captures stdout that arrives after exit event fires
// ---------------------------------------------------------------------------

test("runCommand: captures stdout that arrives after exit event fires", async () => {
  // Use a real subprocess — on both Windows and Unix, `node -e` is reliable.
  // The process writes to stdout and exits; the 'close' handler must see the
  // output even if it flushes just before/after the 'exit' event.
  const script = `process.stdout.write('hello\\nworld\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  assert.strictEqual(result.status, "confirmed");
  // Evidence must include the written lines, not be empty.
  assert.ok(result.evidence.length > 0, "evidence should not be empty");
  assert.ok(
    result.evidence.some((line) => line === "hello" || line === "world"),
    `expected 'hello' or 'world' in evidence, got: ${JSON.stringify(result.evidence)}`,
  );
});

// ---------------------------------------------------------------------------
// runCommand: status is confirmed and summary reflects success for zero exit
// ---------------------------------------------------------------------------

test("runCommand: status is confirmed and summary reflects success for zero exit", async () => {
  const result = await runCommand(["node", "-e", "process.exit(0)"], process.cwd());
  assert.strictEqual(result.status, "confirmed");
  assert.ok(
    result.summary.startsWith("Deterministic runtime command succeeded"),
    `unexpected summary: ${result.summary}`,
  );
});

// ---------------------------------------------------------------------------
// runCommand: reports exit code in summary for non-zero exit
// ---------------------------------------------------------------------------

test("runCommand: reports exit code in summary for non-zero exit", async () => {
  const result = await runCommand(["node", "-e", "process.exit(1)"], process.cwd());
  assert.strictEqual(result.status, "not_confirmed");
  assert.ok(
    result.summary.includes("exit code 1"),
    `expected 'exit code 1' in summary, got: ${result.summary}`,
  );
});

// ---------------------------------------------------------------------------
// runCommand: reports signal name when process is killed by signal
// Note: signal delivery only works on non-Windows. Skip on win32.
// ---------------------------------------------------------------------------

test("runCommand: reports signal name when process is killed by signal", { skip: process.platform === "win32" }, async () => {
  // Spawn a long-running process, then kill it from outside.
  // We use a script that sends SIGTERM to itself after a brief delay so the
  // test is self-contained without needing a separate kill call.
  const script = `setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  assert.strictEqual(result.status, "not_confirmed");
  assert.ok(
    result.summary.includes("SIGTERM"),
    `expected 'SIGTERM' in summary, got: ${result.summary}`,
  );
  assert.ok(
    !result.summary.includes("exit code null"),
    `summary should not contain 'exit code null', got: ${result.summary}`,
  );
});

// ---------------------------------------------------------------------------
// runCommand evidence truncation marker
// ---------------------------------------------------------------------------

test("runCommand: evidence includes truncation marker when output exceeds 10 lines", async () => {
  // Emit 15 numbered lines — more than the 10-line cap.
  const script = `for (let i = 1; i <= 15; i++) process.stdout.write('line' + i + '\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  assert.strictEqual(result.status, "confirmed");
  assert.strictEqual(result.evidence.length, 11, `expected 11 elements (marker + last 10), got ${result.evidence.length}`);
  assert.ok(
    result.evidence[0].startsWith("[... truncated:"),
    `expected truncation marker as first element, got: ${result.evidence[0]}`,
  );
  assert.ok(
    result.evidence[0].includes("15"),
    `truncation marker should contain total line count (15), got: ${result.evidence[0]}`,
  );
});

test("runCommand: evidence contains all lines and no truncation marker when output has exactly 10 lines", async () => {
  const script = `for (let i = 1; i <= 10; i++) process.stdout.write('line' + i + '\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  assert.strictEqual(result.status, "confirmed");
  assert.strictEqual(result.evidence.length, 10, `expected 10 elements, got ${result.evidence.length}`);
  assert.ok(
    !result.evidence[0].startsWith("[... truncated:"),
    `unexpected truncation marker for 10-line output`,
  );
});

test("runCommand: evidence contains all lines and no truncation marker when output has fewer than 10 lines", async () => {
  const script = `for (let i = 1; i <= 5; i++) process.stdout.write('line' + i + '\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  assert.strictEqual(result.status, "confirmed");
  assert.strictEqual(result.evidence.length, 5, `expected 5 elements, got ${result.evidence.length}`);
  assert.ok(
    !result.evidence[0].startsWith("[... truncated:"),
    `unexpected truncation marker for 5-line output`,
  );
});

test("runCommand: evidence is empty when command produces no output", async () => {
  const result = await runCommand(["node", "-e", "process.exit(0)"], process.cwd());
  assert.strictEqual(result.evidence.length, 0, `expected empty evidence, got ${result.evidence.length}`);
});
