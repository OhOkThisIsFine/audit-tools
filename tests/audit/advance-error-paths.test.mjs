import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { RunLogger } = await import("audit-tools/shared");

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
    expect(result.progress_made, "progress_made should be false").toBe(false);

    // Run log must contain an executor_end event for the unrecognized executor.
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));

    const executorEndEvents = events.filter((e) => e.kind === "executor_end");
    expect(executorEndEvents.length > 0, "should emit at least one executor_end event").toBeTruthy();
    const endEvent = executorEndEvents[0];
    expect(endEvent.note, "executor_end note should contain the unrecognized executor name").toBe("not_a_real_executor");
    expect(typeof endEvent.duration_ms === "number", "executor_end should include a numeric duration_ms").toBeTruthy();

    // An error event should also be emitted to signal the unknown executor.
    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents.length > 0, "should emit an error event for the unrecognized executor").toBeTruthy();
    expect(errorEvents[0].note.includes("not_a_real_executor"), "error event note should include the unrecognized executor name").toBeTruthy();
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

// ── zero-dispatch path preserves the obligation log event ────────────────────

test("zero-dispatch advanceAudit (complete bundle) still emits exactly one obligation log event", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "advance-zero-dispatch-"));
  const logPath = join(logDir, "run.log.jsonl");
  try {
    const runLogger = new RunLogger(logPath);
    // A persisted-complete bundle: every drain obligation derives satisfied, so
    // the shared engine dispatches NOTHING and advanceAudit takes its
    // no-actionable-obligation reconstruction branch. The old hand-rolled loop
    // still ran runSingleAdvanceStep once here, emitting one
    // {phase:"advance", kind:"obligation"} event — that event must survive.
    const completeBundle = {
      audit_state: { status: "complete", blockers: [], obligations: [] },
    };
    const result = await advanceAudit(completeBundle, { runLogger });

    expect(result.progress_made).toBe(false);
    expect(result.selected_executor).toBe(null);
    expect(result.selected_obligation).toBe(null);
    expect(result.progress_summary).toMatch(/All known obligations are currently satisfied/);
    expect(result.artifacts_written).toEqual(["audit_state.json"]);

    const events = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const obligationEvents = events.filter((e) => e.kind === "obligation");
    expect(obligationEvents.length, "exactly one obligation event on the zero-dispatch path").toBe(1);
    expect(obligationEvents[0].phase).toBe("advance");
    expect(typeof obligationEvents[0].correlationId).toBe("string");
    expect(obligationEvents[0].obligation, "no obligation selected → field omitted").toBe(undefined);
    expect(obligationEvents[0].note).toMatch(/All known obligations are currently satisfied/);
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

  expect(caught instanceof Error, "thrown value should be an Error").toBeTruthy();

  // The wrapper message matches the formatExecutorFailure pattern.
  expect(caught.message).toMatch(/advanceAudit runtime_validation_update_executor failed while resolving/);

  // The cause chain is preserved and points to the original inner error.
  expect(caught.cause instanceof Error, "error.cause should be an Error").toBeTruthy();
  expect(caught.cause.message).toMatch(/advanceAudit runtime_validation_update_executor requires runtimeValidationUpdates/);
});
