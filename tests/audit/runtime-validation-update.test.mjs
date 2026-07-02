import { test, expect } from "vitest";

const { updateRuntimeValidationReport } = await import("../../src/audit/orchestrator/runtimeValidationUpdate.ts");

/**
 * Captures all console.warn calls made during fn(), restores console.warn
 * afterward (even on throw), and returns the array of argument lists.
 *
 * @param {() => void} fn  Synchronous function under test.
 * @returns {Array<any[]>}  All warn call argument lists.
 */
function captureWarn(fn) {
  const warnMessages = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnMessages.push(args);
  try {
    fn();
  } finally {
    console.warn = origWarn;
  }
  return warnMessages;
}

/**
 * Minimal helpers to build test fixtures without importing private types.
 */
function makeManifest(...ids) {
  return {
    tasks: ids.map((id) => ({
      id,
      kind: "unit-risk-check",
      target_paths: [],
      reason: "test",
      priority: "low",
    })),
  };
}

function makeReport(...results) {
  return { results };
}

function makeResult(task_id, status, evidence = [], notes = []) {
  return { task_id, status, summary: `summary for ${task_id}`, evidence, notes };
}

// ---------------------------------------------------------------------------
// 1. Stale-task pruning
// ---------------------------------------------------------------------------
test("drops existing results whose task_id is not in the manifest (stale-task pruning)", () => {
  const manifest = makeManifest("task-a", "task-b");
  const existing = makeReport(
    makeResult("task-a", "confirmed"),
    makeResult("task-b", "not_confirmed"),
    makeResult("task-c", "confirmed"),  // stale — not in manifest
  );
  const updates = makeReport();

  const report = updateRuntimeValidationReport(manifest, existing, updates);
  const ids = report.results.map((r) => r.task_id);

  expect(ids.includes("task-a"), "task-a should be in output").toBeTruthy();
  expect(ids.includes("task-b"), "task-b should be in output").toBeTruthy();
  expect(!ids.includes("task-c"), "task-c (stale) must not appear in output").toBeTruthy();
  expect(report.results.length).toBe(2);
});

// ---------------------------------------------------------------------------
// 2. Pending-stub insertion for tasks absent from both existing and updates
// ---------------------------------------------------------------------------
test("inserts a pending stub for tasks present in the manifest but absent from both existing and updates", () => {
  const manifest = makeManifest("task-a", "task-b");
  const existing = makeReport();
  const updates = makeReport();

  const report = updateRuntimeValidationReport(manifest, existing, updates);

  expect(report.results.length).toBe(2);

  for (const r of report.results) {
    expect(r.status, `${r.task_id} should be pending`).toBe("pending");
    expect(typeof r.summary === "string" && r.summary.includes(r.task_id), "pending stub summary should mention the task_id").toBeTruthy();
    expect(r.evidence, `${r.task_id} evidence should be empty`).toEqual([]);
    expect(r.notes, `${r.task_id} notes should be empty`).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// 3. Merge update into existing: dedup evidence/notes, update wins for status/summary
// ---------------------------------------------------------------------------
test("merges update into existing result, deduplicating evidence and notes, update wins for status/summary", () => {
  const manifest = makeManifest("task-a");
  const existing = makeReport(
    makeResult("task-a", "pending", ["e1", "e2"], ["n1"]),
  );
  const updates = makeReport(
    makeResult("task-a", "confirmed", ["e2", "e3"], ["n1", "n2"]),
  );

  const report = updateRuntimeValidationReport(manifest, existing, updates);
  const result = report.results.find((r) => r.task_id === "task-a");

  expect(result, "merged result for task-a must exist").toBeTruthy();

  // status and summary come from the update
  expect(result.status, "merged status should be the update's status").toBe("confirmed");
  expect(result.summary, "merged summary should be the update's summary").toBe("summary for task-a");

  // evidence: union, no duplicates, preserves all unique entries
  const evidence = result.evidence ?? [];
  expect(evidence.includes("e1"), "e1 must be in merged evidence").toBeTruthy();
  expect(evidence.includes("e2"), "e2 must be in merged evidence").toBeTruthy();
  expect(evidence.includes("e3"), "e3 must be in merged evidence").toBeTruthy();
  expect(evidence.length, "no duplicate evidence entries").toBe(3);

  // notes: union, no duplicates
  const notes = result.notes ?? [];
  expect(notes.includes("n1"), "n1 must be in merged notes").toBeTruthy();
  expect(notes.includes("n2"), "n2 must be in merged notes").toBeTruthy();
  expect(notes.length, "no duplicate note entries").toBe(2);
});

// ---------------------------------------------------------------------------
// 4. normalizeResult dedup on existing-only entries (no matching update)
// ---------------------------------------------------------------------------
test("normalizes duplicate evidence/notes in an existing result that has no matching update", () => {
  const manifest = makeManifest("task-a");
  const existing = makeReport(
    makeResult("task-a", "inconclusive", ["dup", "dup", "unique"], ["x", "x"]),
  );
  const updates = makeReport(); // no update for task-a

  const report = updateRuntimeValidationReport(manifest, existing, updates);
  const result = report.results.find((r) => r.task_id === "task-a");

  expect(result, "result for task-a must exist").toBeTruthy();

  const evidence = result.evidence ?? [];
  expect(evidence.includes("dup"), "'dup' should appear once").toBeTruthy();
  expect(evidence.includes("unique"), "'unique' should appear").toBeTruthy();
  expect(evidence.length, "duplicate 'dup' must be removed").toBe(2);

  const notes = result.notes ?? [];
  expect(notes.includes("x"), "'x' should appear once").toBeTruthy();
  expect(notes.length, "duplicate 'x' must be removed").toBe(1);
});

// ---------------------------------------------------------------------------
// 5. Mixed: update for only one manifest task → other task gets pending stub
// ---------------------------------------------------------------------------
test("inserts a pending stub for manifest tasks absent from updates when updates only cover a subset", () => {
  const manifest = makeManifest("task-a", "task-b");
  const existing = makeReport();
  const updates = makeReport(
    makeResult("task-b", "not_confirmed", [], []),
  );

  const report = updateRuntimeValidationReport(manifest, existing, updates);

  const a = report.results.find((r) => r.task_id === "task-a");
  const b = report.results.find((r) => r.task_id === "task-b");

  expect(a, "task-a must be present").toBeTruthy();
  expect(a.status, "task-a should be a pending stub").toBe("pending");

  expect(b, "task-b must be present").toBeTruthy();
  expect(b.status, "task-b should receive the update result, not a stub").toBe("not_confirmed");
});

// ---------------------------------------------------------------------------
// Stale-ID warning tests (OBS-7a6f2732)
// ---------------------------------------------------------------------------

test("warns when existing results contain stale task IDs", () => {
  const manifest = makeManifest("task-a");
  const existing = makeReport(
    makeResult("task-a", "confirmed"),
    makeResult("stale-x", "confirmed"), // stale — not in manifest
  );
  const updates = makeReport();

  let report;
  const warnMessages = captureWarn(() => {
    report = updateRuntimeValidationReport(manifest, existing, updates);
  });
  const ids = report.results.map((r) => r.task_id);

  expect(warnMessages.length, "console.warn should be called exactly once").toBe(1);
  expect(warnMessages[0].join(" ").includes("stale-x"), "warning should include the stale task_id").toBeTruthy();
  expect(!ids.includes("stale-x"), "stale result must not appear in output").toBeTruthy();
});

test("warns when update results contain stale task IDs", () => {
  const manifest = makeManifest("task-a");
  const existing = makeReport();
  const updates = makeReport(
    makeResult("task-a", "confirmed"),
    makeResult("stale-y", "confirmed"), // stale — not in manifest
  );

  let report;
  const warnMessages = captureWarn(() => {
    report = updateRuntimeValidationReport(manifest, existing, updates);
  });
  const ids = report.results.map((r) => r.task_id);

  expect(warnMessages.length, "console.warn should be called exactly once").toBe(1);
  expect(warnMessages[0].join(" ").includes("stale-y"), "warning should include the stale task_id").toBeTruthy();
  expect(!ids.includes("stale-y"), "stale update result must not appear in output").toBeTruthy();
});

test("consolidates stale IDs from both existing and updates into one warning", () => {
  const manifest = makeManifest("task-a");
  const existing = makeReport(
    makeResult("stale-p", "confirmed"), // stale in existing
  );
  const updates = makeReport(
    makeResult("task-a", "confirmed"),
    makeResult("stale-q", "confirmed"), // stale in updates
  );

  const warnMessages = captureWarn(() => {
    updateRuntimeValidationReport(manifest, existing, updates);
  });

  expect(warnMessages.length, "console.warn should be called exactly once even with stale IDs in both sources").toBe(1);
  const warnText = warnMessages[0].join(" ");
  expect(warnText.includes("stale-p"), "warning should include stale-p").toBeTruthy();
  expect(warnText.includes("stale-q"), "warning should include stale-q").toBeTruthy();
});

test("does not warn when all task IDs are valid", () => {
  const manifest = makeManifest("task-a", "task-b");
  const existing = makeReport(makeResult("task-a", "confirmed"));
  const updates = makeReport(makeResult("task-b", "not_confirmed"));

  const warnMessages = captureWarn(() => {
    updateRuntimeValidationReport(manifest, existing, updates);
  });

  expect(warnMessages.length, "console.warn must not be called when all task IDs are valid").toBe(0);
});

// ---------------------------------------------------------------------------
// 6. Output is sorted lexicographically by task_id
// ---------------------------------------------------------------------------
test("returned results are sorted lexicographically by task_id", () => {
  const manifest = makeManifest("task-z", "task-a", "task-m");
  const existing = makeReport(
    makeResult("task-z", "confirmed"),
    makeResult("task-a", "confirmed"),
    makeResult("task-m", "confirmed"),
  );
  const updates = makeReport();

  const report = updateRuntimeValidationReport(manifest, existing, updates);
  const ids = report.results.map((r) => r.task_id);

  expect(ids).toEqual(["task-a", "task-m", "task-z"]);
});
