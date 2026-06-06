import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { advanceAudit } = await import("../src/orchestrator/advance.ts");
const { RunLogger } = await import("@audit-tools/shared");

// An empty bundle is sufficient to trigger the guard branches under test — the
// executors reach the requireRoot / missing-option checks before they touch any
// bundle contents.
const EMPTY_BUNDLE = {};

// ── requireRoot guards ───────────────────────────────────────────────────────

test("requireRoot throws with canonical message for intake_executor when root is absent", async () => {
  await assert.rejects(
    () => advanceAudit(EMPTY_BUNDLE, { preferredExecutor: "intake_executor" }),
    /advanceAudit intake_executor requires root/,
  );
});

test("requireRoot throws with canonical message for planning_executor when root is absent", async () => {
  await assert.rejects(
    () => advanceAudit(EMPTY_BUNDLE, { preferredExecutor: "planning_executor" }),
    /advanceAudit planning_executor requires root/,
  );
});

test("requireRoot throws with canonical message for auto_fix_executor when root is absent", async () => {
  await assert.rejects(
    () => advanceAudit(EMPTY_BUNDLE, { preferredExecutor: "auto_fix_executor" }),
    /advanceAudit auto_fix_executor requires root/,
  );
});

test("requireRoot throws with canonical message for syntax_resolution_executor when root is absent", async () => {
  await assert.rejects(
    () => advanceAudit(EMPTY_BUNDLE, { preferredExecutor: "syntax_resolution_executor" }),
    /advanceAudit syntax_resolution_executor requires root/,
  );
});

test("requireRoot throws with canonical message for runtime_validation_executor when root is absent", async () => {
  await assert.rejects(
    () => advanceAudit(EMPTY_BUNDLE, { preferredExecutor: "runtime_validation_executor" }),
    /advanceAudit runtime_validation_executor requires root/,
  );
});

// ── missing required option guards ───────────────────────────────────────────

test("runtime_validation_update_executor throws when runtimeValidationUpdates is missing", async () => {
  await assert.rejects(
    () =>
      advanceAudit(EMPTY_BUNDLE, {
        preferredExecutor: "runtime_validation_update_executor",
      }),
    /advanceAudit runtime_validation_update_executor requires runtimeValidationUpdates/,
  );
});

test("external_analyzer_import_executor throws when externalAnalyzerResults is missing", async () => {
  await assert.rejects(
    () =>
      advanceAudit(EMPTY_BUNDLE, {
        preferredExecutor: "external_analyzer_import_executor",
      }),
    /advanceAudit external_analyzer_import_executor requires externalAnalyzerResults/,
  );
});

// ── default executor branch emits balanced log events ────────────────────────

test("default executor branch emits executor_end log event and returns progress_made:false", async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), "advance-default-exec-"));
  const logPath = join(logDir, "run.log.jsonl");
  try {
    const runLogger = new RunLogger(logPath);
    const result = await advanceAudit(EMPTY_BUNDLE, {
      preferredExecutor: "not_a_real_executor",
      runLogger,
    });

    // Return value should indicate no progress was made.
    assert.equal(result.progress_made, false, "progress_made should be false");

    // Run log must contain an executor_end event for the unrecognized executor.
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));

    const executorEndEvents = events.filter((e) => e.kind === "executor_end");
    assert.ok(
      executorEndEvents.length > 0,
      "should emit at least one executor_end event",
    );
    const endEvent = executorEndEvents[0];
    assert.equal(
      endEvent.note,
      "not_a_real_executor",
      "executor_end note should contain the unrecognized executor name",
    );
    assert.ok(
      typeof endEvent.duration_ms === "number",
      "executor_end should include a numeric duration_ms",
    );

    // An error event should also be emitted to signal the unknown executor.
    const errorEvents = events.filter((e) => e.kind === "error");
    assert.ok(
      errorEvents.length > 0,
      "should emit an error event for the unrecognized executor",
    );
    assert.ok(
      errorEvents[0].note.includes("not_a_real_executor"),
      "error event note should include the unrecognized executor name",
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

// ── formatExecutorFailure preserves error cause chain ────────────────────────

test("formatExecutorFailure preserves error cause chain", async () => {
  // Trigger the catch block via the runtime_validation_update_executor guard
  // (no runtimeValidationUpdates supplied). The source code in advance.ts
  // catches the inner throw and re-wraps it via formatExecutorFailure, which
  // sets { cause: error }.
  let caught;
  try {
    await advanceAudit(EMPTY_BUNDLE, {
      preferredExecutor: "runtime_validation_update_executor",
    });
    assert.fail("advanceAudit should have thrown");
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof Error, "thrown value should be an Error");

  // The wrapper message matches the formatExecutorFailure pattern.
  assert.match(
    caught.message,
    /advanceAudit runtime_validation_update_executor failed while resolving/,
  );

  // The cause chain is preserved and points to the original inner error.
  assert.ok(caught.cause instanceof Error, "error.cause should be an Error");
  assert.match(
    caught.cause.message,
    /advanceAudit runtime_validation_update_executor requires runtimeValidationUpdates/,
  );
});
