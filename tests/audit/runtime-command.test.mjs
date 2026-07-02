import { test, expect } from "vitest";

const { runCommand } = await import("../../src/audit/orchestrator/runtimeCommand.ts");

// ---------------------------------------------------------------------------
// runCommand: captures stdout that arrives after exit event fires
// ---------------------------------------------------------------------------

test("runCommand: captures stdout that arrives after exit event fires", async () => {
  // Use a real subprocess — on both Windows and Unix, `node -e` is reliable.
  // The process writes to stdout and exits; the 'close' handler must see the
  // output even if it flushes just before/after the 'exit' event.
  const script = `process.stdout.write('hello\\nworld\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  expect(result.status).toBe("confirmed");
  // Evidence must include the written lines, not be empty.
  expect(result.evidence.length > 0, "evidence should not be empty").toBeTruthy();
  expect(result.evidence.some((line) => line === "hello" || line === "world"), `expected 'hello' or 'world' in evidence, got: ${JSON.stringify(result.evidence)}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// runCommand: status is confirmed and summary reflects success for zero exit
// ---------------------------------------------------------------------------

test("runCommand: status is confirmed and summary reflects success for zero exit", async () => {
  const result = await runCommand(["node", "-e", "process.exit(0)"], process.cwd());
  expect(result.status).toBe("confirmed");
  expect(result.summary.startsWith("Deterministic runtime command succeeded"), `unexpected summary: ${result.summary}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// runCommand: reports exit code in summary for non-zero exit
// ---------------------------------------------------------------------------

test("runCommand: reports exit code in summary for non-zero exit", async () => {
  const result = await runCommand(["node", "-e", "process.exit(1)"], process.cwd());
  expect(result.status).toBe("not_confirmed");
  expect(result.summary.includes("exit code 1"), `expected 'exit code 1' in summary, got: ${result.summary}`).toBeTruthy();
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
  expect(result.status).toBe("not_confirmed");
  expect(result.summary.includes("SIGTERM"), `expected 'SIGTERM' in summary, got: ${result.summary}`).toBeTruthy();
  expect(!result.summary.includes("exit code null"), `summary should not contain 'exit code null', got: ${result.summary}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// runCommand evidence truncation marker
// ---------------------------------------------------------------------------

test("runCommand: evidence includes truncation marker when output exceeds 10 lines", async () => {
  // Emit 15 numbered lines — more than the 10-line cap.
  const script = `for (let i = 1; i <= 15; i++) process.stdout.write('line' + i + '\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  expect(result.status).toBe("confirmed");
  expect(result.evidence.length, `expected 11 elements (marker + last 10), got ${result.evidence.length}`).toBe(11);
  expect(result.evidence[0].startsWith("[... truncated:"), `expected truncation marker as first element, got: ${result.evidence[0]}`).toBeTruthy();
  expect(result.evidence[0].includes("15"), `truncation marker should contain total line count (15), got: ${result.evidence[0]}`).toBeTruthy();
});

test("runCommand: evidence contains all lines and no truncation marker when output has exactly 10 lines", async () => {
  const script = `for (let i = 1; i <= 10; i++) process.stdout.write('line' + i + '\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  expect(result.status).toBe("confirmed");
  expect(result.evidence.length, `expected 10 elements, got ${result.evidence.length}`).toBe(10);
  expect(!result.evidence[0].startsWith("[... truncated:"), `unexpected truncation marker for 10-line output`).toBeTruthy();
});

test("runCommand: evidence contains all lines and no truncation marker when output has fewer than 10 lines", async () => {
  const script = `for (let i = 1; i <= 5; i++) process.stdout.write('line' + i + '\\n'); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());
  expect(result.status).toBe("confirmed");
  expect(result.evidence.length, `expected 5 elements, got ${result.evidence.length}`).toBe(5);
  expect(!result.evidence[0].startsWith("[... truncated:"), `unexpected truncation marker for 5-line output`).toBeTruthy();
});

test("runCommand: evidence is empty when command produces no output", async () => {
  const result = await runCommand(["node", "-e", "process.exit(0)"], process.cwd());
  expect(result.evidence.length, `expected empty evidence, got ${result.evidence.length}`).toBe(0);
});

// ---------------------------------------------------------------------------
// COR-4a8d9779: empty command array fast-fail
// ---------------------------------------------------------------------------

test("COR-4a8d9779: runCommand with empty array returns inconclusive without spawning", async () => {
  // Before the fix, [] was passed to resolveRuntimeValidationSpawnCommand which
  // returned { command: "", args: [] }, then spawn("") fired ENOENT — no fast-fail.
  // After the fix: immediate inconclusive with a descriptive summary.
  const result = await runCommand([], process.cwd());
  expect(result.status).toBe("inconclusive");
  expect(result.summary.includes("empty"), `expected 'empty' in summary, got: ${result.summary}`).toBeTruthy();
  expect(result.evidence).toEqual([]);
});

test("COR-4a8d9779: runCommand with a single empty-string element returns inconclusive", async () => {
  const result = await runCommand([""], process.cwd());
  expect(result.status).toBe("inconclusive");
  expect(result.summary.includes("empty"), `expected 'empty' in summary for [\"\"] command, got: ${result.summary}`).toBeTruthy();
});
