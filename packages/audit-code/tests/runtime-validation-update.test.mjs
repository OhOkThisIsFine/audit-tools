import test from "node:test";
import assert from "node:assert/strict";

const { updateRuntimeValidationReport } = await import(
  "../src/orchestrator/runtimeValidationUpdate.ts"
);

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

  assert.ok(ids.includes("task-a"), "task-a should be in output");
  assert.ok(ids.includes("task-b"), "task-b should be in output");
  assert.ok(!ids.includes("task-c"), "task-c (stale) must not appear in output");
  assert.equal(report.results.length, 2);
});

// ---------------------------------------------------------------------------
// 2. Pending-stub insertion for tasks absent from both existing and updates
// ---------------------------------------------------------------------------
test("inserts a pending stub for tasks present in the manifest but absent from both existing and updates", () => {
  const manifest = makeManifest("task-a", "task-b");
  const existing = makeReport();
  const updates = makeReport();

  const report = updateRuntimeValidationReport(manifest, existing, updates);

  assert.equal(report.results.length, 2);

  for (const r of report.results) {
    assert.equal(r.status, "pending", `${r.task_id} should be pending`);
    assert.ok(
      typeof r.summary === "string" && r.summary.includes(r.task_id),
      "pending stub summary should mention the task_id",
    );
    assert.deepEqual(r.evidence, [], `${r.task_id} evidence should be empty`);
    assert.deepEqual(r.notes, [], `${r.task_id} notes should be empty`);
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

  assert.ok(result, "merged result for task-a must exist");

  // status and summary come from the update
  assert.equal(result.status, "confirmed", "merged status should be the update's status");
  assert.equal(result.summary, "summary for task-a", "merged summary should be the update's summary");

  // evidence: union, no duplicates, preserves all unique entries
  const evidence = result.evidence ?? [];
  assert.ok(evidence.includes("e1"), "e1 must be in merged evidence");
  assert.ok(evidence.includes("e2"), "e2 must be in merged evidence");
  assert.ok(evidence.includes("e3"), "e3 must be in merged evidence");
  assert.equal(evidence.length, 3, "no duplicate evidence entries");

  // notes: union, no duplicates
  const notes = result.notes ?? [];
  assert.ok(notes.includes("n1"), "n1 must be in merged notes");
  assert.ok(notes.includes("n2"), "n2 must be in merged notes");
  assert.equal(notes.length, 2, "no duplicate note entries");
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

  assert.ok(result, "result for task-a must exist");

  const evidence = result.evidence ?? [];
  assert.ok(evidence.includes("dup"), "'dup' should appear once");
  assert.ok(evidence.includes("unique"), "'unique' should appear");
  assert.equal(evidence.length, 2, "duplicate 'dup' must be removed");

  const notes = result.notes ?? [];
  assert.ok(notes.includes("x"), "'x' should appear once");
  assert.equal(notes.length, 1, "duplicate 'x' must be removed");
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

  assert.ok(a, "task-a must be present");
  assert.equal(a.status, "pending", "task-a should be a pending stub");

  assert.ok(b, "task-b must be present");
  assert.equal(b.status, "not_confirmed", "task-b should receive the update result, not a stub");
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

  assert.equal(warnMessages.length, 1, "console.warn should be called exactly once");
  assert.ok(
    warnMessages[0].join(" ").includes("stale-x"),
    "warning should include the stale task_id",
  );
  assert.ok(!ids.includes("stale-x"), "stale result must not appear in output");
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

  assert.equal(warnMessages.length, 1, "console.warn should be called exactly once");
  assert.ok(
    warnMessages[0].join(" ").includes("stale-y"),
    "warning should include the stale task_id",
  );
  assert.ok(!ids.includes("stale-y"), "stale update result must not appear in output");
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

  assert.equal(warnMessages.length, 1, "console.warn should be called exactly once even with stale IDs in both sources");
  const warnText = warnMessages[0].join(" ");
  assert.ok(warnText.includes("stale-p"), "warning should include stale-p");
  assert.ok(warnText.includes("stale-q"), "warning should include stale-q");
});

test("does not warn when all task IDs are valid", () => {
  const manifest = makeManifest("task-a", "task-b");
  const existing = makeReport(makeResult("task-a", "confirmed"));
  const updates = makeReport(makeResult("task-b", "not_confirmed"));

  const warnMessages = captureWarn(() => {
    updateRuntimeValidationReport(manifest, existing, updates);
  });

  assert.equal(warnMessages.length, 0, "console.warn must not be called when all task IDs are valid");
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

  assert.deepEqual(ids, ["task-a", "task-m", "task-z"]);
});
