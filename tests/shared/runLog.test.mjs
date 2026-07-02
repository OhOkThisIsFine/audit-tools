import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { RunLogger } = await import("../../src/shared/observability/runLog.ts");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-runlog-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("appends one JSON object per event with an ISO timestamp", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "run.log.jsonl");
    const logger = new RunLogger(path, { now: () => 0 });
    logger.event({ kind: "obligation", obligation: "repo_manifest", phase: "advance" });
    logger.event({ kind: "executor_end", duration_ms: 12 });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.ts).toBe("1970-01-01T00:00:00.000Z");
    expect(first.kind).toBe("obligation");
    expect(first.obligation).toBe("repo_manifest");
    const second = JSON.parse(lines[1]);
    expect(second.duration_ms).toBe(12);
  });
});

test("disabled logger writes nothing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.log.jsonl");
    const logger = new RunLogger(path, { enabled: false });
    logger.event({ kind: "obligation" });
    await assert.rejects(() => access(path));

    const sink = RunLogger.disabled();
    expect(sink.isEnabled).toBe(false);
    // @ts-expect-error — "noop" is not a RunLogEventKind; disabled logger must still not throw
    sink.event({ kind: "noop" });
  });
});

test("non-serializable event writes minimal fallback marker", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.log.jsonl");
    const logger = new RunLogger(path);
    const circular = { kind: "obligation", self: undefined };
    circular.self = circular; // JSON.stringify throws on circular references
    logger.event(circular);

    const line = (await readFile(path, "utf8")).trim();
    const parsed = JSON.parse(line); // must not throw
    expect(parsed.kind).toBe("obligation");
    expect(parsed.note).toBe("unserializable_event");
    expect(typeof parsed.ts).toBe("string");
  });
});

test("injectable now clock is used in the non-serializable fallback path", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.log.jsonl");
    const logger = new RunLogger(path, { now: () => 0 });
    const circular = { kind: "executor_end", self: undefined };
    circular.self = circular;
    logger.event(circular);

    const line = (await readFile(path, "utf8")).trim();
    const parsed = JSON.parse(line);
    // Confirms now() was called inside the catch block, not bypassed.
    expect(parsed.ts).toBe("1970-01-01T00:00:00.000Z");
    expect(parsed.note).toBe("unserializable_event");
  });
});

test("RunLogEvent compile-time type constraints", async () => {
  // This test documents the closed-vocabulary shape of RunLogEvent.
  // All assertions are purely structural (no runtime assertion library needed):
  // the @ts-expect-error lines confirm tsc rejects unknown/invalid fields, while
  // the well-typed literal below confirms valid fields compile without error.

  /** @type {import("../../src/shared/observability/runLog.ts").RunLogEvent} */
  const validEvent = {
    kind: "executor_end",
    phase: "advance",
    obligation: "repo_manifest",
    artifact: "repo_manifest.json",
    provider: "claude-code",
    tokens_est: 100,
    duration_ms: 42,
    note: "done",
  };
  // Ensure the valid event is used (prevents unused-variable lint noise).
  expect(typeof validEvent.kind).toBe("string");

  // @ts-expect-error — unknown field (misspelled "durtion_ms") must be a compile-time error
  const _bad1 = /** @type {import("../../src/shared/observability/runLog.ts").RunLogEvent} */ ({ kind: "executor_end", durtion_ms: 5 });
  void _bad1;

  // @ts-expect-error — "noop" is not in RunLogEventKind
  const _bad2 = /** @type {import("../../src/shared/observability/runLog.ts").RunLogEvent} */ ({ kind: "noop" });
  void _bad2;
});

test("a BigInt payload triggers the unserializable_event fallback marker", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.log.jsonl");
    const logger = new RunLogger(path, { now: () => 0 });
    // JSON.stringify throws on BigInt, exercising the same catch as the circular
    // case but via a different unserializable value.
    // @ts-expect-error — BigInt is not assignable to number; the logger must handle it gracefully
    logger.event({ kind: "outcome", tokens_est: 5n });

    const line = (await readFile(path, "utf8")).trim();
    const parsed = JSON.parse(line); // must not throw
    expect(parsed).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      kind: "outcome",
      note: "unserializable_event",
    });
    expect(typeof parsed.ts).toBe("string");
  });
});
