import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { RunLogger } = await import("../dist/observability/runLog.js");

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
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.ts, "1970-01-01T00:00:00.000Z");
    assert.equal(first.kind, "obligation");
    assert.equal(first.obligation, "repo_manifest");
    const second = JSON.parse(lines[1]);
    assert.equal(second.duration_ms, 12);
  });
});

test("disabled logger writes nothing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.log.jsonl");
    const logger = new RunLogger(path, { enabled: false });
    logger.event({ kind: "obligation" });
    await assert.rejects(() => access(path));

    const sink = RunLogger.disabled();
    assert.equal(sink.isEnabled, false);
    sink.event({ kind: "noop" }); // must not throw
  });
});
