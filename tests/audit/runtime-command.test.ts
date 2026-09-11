import { test, expect } from "vitest";

const {
  runCommand,
  BoundedOutputTail,
  EVIDENCE_TAIL_LINES,
  EVIDENCE_TAIL_MAX_CHARS,
  EVIDENCE_TAIL_MAX_LINE_CHARS,
} = await import("../../src/audit/orchestrator/runtimeCommand.js");

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

// ---------------------------------------------------------------------------
// Bounded output accumulation
//
// The runner used to accumulate `stdout += String(chunk)` for the WHOLE stream
// and slice the last ten lines only at the end, so a chatty command made the
// drain's memory the command's choice — at the ceiling, a string-length
// `RangeError` thrown from inside the runner. These pin the bound at both ends:
// the retained window (the class) and what a real child can push through it.
// ---------------------------------------------------------------------------

test("BoundedOutputTail: retains only the trailing window while counting the whole stream", () => {
  const tail = new BoundedOutputTail();
  const TOTAL = 100_000;
  for (let line = 1; line <= TOTAL; line += 1) {
    tail.push(`line-${String(line)}\n`);
  }

  const { text, totalLines, clippedChars } = tail.read();
  const retained = text.split("\n");

  // The count is the WHOLE stream — a truncated tail that reported only what it
  // kept would make "showing last 10 of 11" out of a million-line run.
  expect(totalLines, "the true total line count must survive the bound").toBe(TOTAL);
  expect(clippedChars, "whole lines were dropped, nothing was clipped mid-line").toBe(0);
  expect(
    retained.length <= EVIDENCE_TAIL_LINES + 1,
    `retained ${String(retained.length)} lines — the window is ${String(EVIDENCE_TAIL_LINES)}`,
  ).toBeTruthy();
  // The retained text is the TAIL: the last line is the last line written.
  expect(retained[retained.length - 1]).toBe(`line-${String(TOTAL)}`);
  expect(text.length, "the retained buffer is bounded in characters too").toBeLessThanOrEqual(
    EVIDENCE_TAIL_MAX_CHARS,
  );
});

test("BoundedOutputTail: one enormous line cannot spend the whole window", () => {
  const tail = new BoundedOutputTail();
  tail.push("y".repeat(EVIDENCE_TAIL_MAX_LINE_CHARS * 4));

  const { text, totalLines, clippedChars } = tail.read();

  expect(totalLines, "an unterminated line is still one line").toBe(1);
  expect(
    text.length <= EVIDENCE_TAIL_MAX_LINE_CHARS,
    `clipped line must fit the per-line ceiling, got ${String(text.length)} chars`,
  ).toBeTruthy();
  expect(
    clippedChars,
    "a silent clip would report a fragment as if it were the whole line",
  ).toBeGreaterThan(0);
});

test("BoundedOutputTail: the per-line cap holds for EVERY retained segment, the live one included", () => {
  const tail = new BoundedOutputTail();
  // Seed with terminated lines first, so the live segment is NOT the head: that
  // is the shape the head-only clip missed. Clipping `segments[0]` left a chunk
  // that extended the in-progress line unbounded — it is neither the head nor
  // droppable — until the next push happened to arrive and re-run the trim.
  for (let index = 0; index < 3; index += 1) {
    tail.push(`seed-${String(index)}\n`);
  }
  for (let index = 0; index < 4; index += 1) {
    tail.push("w".repeat(EVIDENCE_TAIL_MAX_LINE_CHARS));
  }

  const { text, clippedChars } = tail.read();
  for (const line of text.split("\n")) {
    expect(
      line.length,
      `a retained line exceeded the per-line cap: ${String(line.length)} chars`,
    ).toBeLessThanOrEqual(EVIDENCE_TAIL_MAX_LINE_CHARS);
  }
  expect(
    clippedChars,
    "a silent clip would report a fragment as if it were the whole line",
  ).toBeGreaterThan(0);
});

test("BoundedOutputTail: 40 lines plus one 64 KiB newline-free push stays within both ceilings", () => {
  const tail = new BoundedOutputTail();
  for (let line = 1; line <= 40; line += 1) {
    tail.push(`line-${String(line)}\n`);
  }
  tail.push("z".repeat(EVIDENCE_TAIL_MAX_CHARS));

  const { text, totalLines } = tail.read();
  expect(totalLines, "the true stream count survives the clipping").toBe(41);
  expect(text.length, "the retained text is bounded in characters").toBeLessThanOrEqual(
    EVIDENCE_TAIL_MAX_CHARS,
  );
  for (const line of text.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(EVIDENCE_TAIL_MAX_LINE_CHARS);
  }

  // A blast larger than the TOTAL ceiling is the case the char accounting has to
  // answer on its own: the line window cannot drop the live segment, so nothing
  // but the cap keeps the buffer bounded.
  const huge = new BoundedOutputTail();
  huge.push("q".repeat(EVIDENCE_TAIL_MAX_CHARS * 2));
  const hugeRead = huge.read();
  expect(
    hugeRead.text.length,
    "a push larger than the whole character ceiling must still be clipped to it",
  ).toBeLessThanOrEqual(EVIDENCE_TAIL_MAX_CHARS);
  expect(hugeRead.clippedChars).toBeGreaterThan(0);
});

test("runCommand: the truncated marker reports the TRUE line count, whitespace-only line included", async () => {
  // The composition used to be counted AFTER `.trim()`, which deletes a
  // whitespace-only line at either boundary of the composed text — so a stream
  // that opened with a blank line reported one line fewer than it printed, in
  // the very marker whose only job is to state the true total. The stream here
  // is two lines: a whitespace-only one, then one long enough to be clipped
  // (so the marker is emitted at all, rather than the retained window being
  // handed back bare).
  const NL = String.fromCharCode(10);
  const script = [
    `process.stdout.write('   ' + ${JSON.stringify(NL)} + 'z'.repeat(${String(EVIDENCE_TAIL_MAX_LINE_CHARS * 2)}));`,
  ].join(" ");
  const result = await runCommand(["node", "-e", script], process.cwd());

  expect(result.status).toBe("confirmed");
  expect(
    result.evidence[0],
    // Slice the message: the retained line is itself 8 KiB, and a failure
    // report nobody can read is one more way the count stays hidden.
    `the blank line was printed, so the count must include it — got: ${String(result.evidence[0]).slice(0, 80)}`,
  ).toContain("showing last 2 of 2 lines");
});

test("runCommand: a command emitting one enormous line is clipped, never buffered whole", async () => {
  // 4 MiB on a SINGLE line: the shape the old accumulator could not bound at
  // all (line-count truncation never fires on one line, so the whole thing
  // landed in `evidence`).
  const bytes = 4 * 1024 * 1024;
  const script = `process.stdout.write('z'.repeat(${String(bytes)})); process.exit(0);`;
  const result = await runCommand(["node", "-e", script], process.cwd());

  expect(result.status).toBe("confirmed");
  const total = result.evidence.join("\n").length;
  expect(
    total <= EVIDENCE_TAIL_MAX_LINE_CHARS + 4_096,
    `evidence retained ${String(total)} chars of a single line — the bound did not hold`,
  ).toBeTruthy();
  expect(
    result.evidence[0].startsWith("[... truncated:"),
    `a clipped stream must say so, got: ${result.evidence[0].slice(0, 120)}`,
  ).toBeTruthy();
});
