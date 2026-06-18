import test from "node:test";
import assert from "node:assert/strict";

const { buildChunkedAuditTasks } = await import("../../src/audit/orchestrator/taskBuilder.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CoverageMatrix file entry that is pending (not excluded,
 * no completed lenses).
 */
function pendingFile(path, lenses = ["correctness"]) {
  return {
    path,
    audit_status: "pending",
    required_lenses: lenses,
    completed_lenses: [],
    unit_ids: ["unit-1"],
  };
}

function makeCoverage(files) {
  return { files };
}

// ---------------------------------------------------------------------------
// DEFAULT_MAX_TASK_FILES = 0 (disabled)
// ---------------------------------------------------------------------------

test("DEFAULT_MAX_TASK_FILES is 0: 20-file unit produces a single task (not split by count)", () => {
  const files = Array.from({ length: 20 }, (_, i) =>
    pendingFile(`src/file${i}.ts`, ["correctness"]),
  );
  const coverage = makeCoverage(files);
  // Give each file 10 lines so they are not trivial (isTrivialAuditPath skips 0-line files)
  const lineIndex = Object.fromEntries(files.map((f) => [f.path, 10]));
  // 20 files × 10 lines = 200 lines total, well under max_task_lines=3000, so no line-budget split
  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {});
  const corrTasks = tasks.filter((t) => t.lens === "correctness");
  assert.strictEqual(corrTasks.length, 1, "should produce exactly 1 task for 20 small-line files");
  assert.strictEqual(corrTasks[0].file_paths.length, 20);
});

test("DEFAULT_MAX_TASK_FILES=0 does not split; explicit max_task_files=5 does split", () => {
  const files = Array.from({ length: 10 }, (_, i) =>
    pendingFile(`src/file${i}.ts`, ["correctness"]),
  );
  const coverage = makeCoverage(files);
  const lineIndex = Object.fromEntries(files.map((f) => [f.path, 10]));

  // Default: no file-count split
  const defaultTasks = buildChunkedAuditTasks(coverage, lineIndex, {});
  const defaultCorr = defaultTasks.filter((t) => t.lens === "correctness");
  assert.strictEqual(defaultCorr.length, 1, "default: 10 files → 1 task");

  // Explicit cap: split by 5
  const cappedTasks = buildChunkedAuditTasks(coverage, lineIndex, { max_task_files: 5 });
  const cappedCorr = cappedTasks.filter((t) => t.lens === "correctness");
  assert.ok(cappedCorr.length >= 2, "capped: 10 files / 5 → at least 2 tasks");
});

test("buildChunkedAuditTasks still splits when max_task_lines is exceeded", () => {
  // 5 files each 1000 lines; default max_task_lines = 3000 → should split into 2 tasks
  const files = Array.from({ length: 5 }, (_, i) =>
    pendingFile(`src/file${i}.ts`, ["correctness"]),
  );
  const coverage = makeCoverage(files);
  const lineIndex = Object.fromEntries(files.map((f) => [f.path, 1000]));
  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {});
  const corrTasks = tasks.filter((t) => t.lens === "correctness");
  // 5000 total lines, 3000 budget → must produce > 1 task
  assert.ok(corrTasks.length > 1, `line-budget split should produce >1 task; got ${corrTasks.length}`);
});

// ---------------------------------------------------------------------------
// intent_priority_boost elevates task priority by one tier
// ---------------------------------------------------------------------------

test("intent_priority_boost: low lens (architecture) → medium when boosted", () => {
  const files = [pendingFile("src/a.ts", ["architecture"])];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/a.ts": 100 };

  const unboosted = buildChunkedAuditTasks(coverage, lineIndex, {});
  const archUnboosted = unboosted.filter((t) => t.lens === "architecture");
  assert.ok(archUnboosted.length > 0, "should have architecture task");
  assert.strictEqual(archUnboosted[0].priority, "low", "architecture without boost should be low");

  const boosted = buildChunkedAuditTasks(coverage, lineIndex, { intent_priority_boost: ["architecture"] });
  const archBoosted = boosted.filter((t) => t.lens === "architecture");
  assert.ok(archBoosted.length > 0, "should have architecture task after boost");
  assert.strictEqual(archBoosted[0].priority, "medium", "architecture boosted should become medium");
});

test("intent_priority_boost: medium lens (security) → high when boosted", () => {
  const files = [pendingFile("src/auth.ts", ["security"])];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/auth.ts": 100 };

  const unboosted = buildChunkedAuditTasks(coverage, lineIndex, {});
  const secUnboosted = unboosted.filter((t) => t.lens === "security");
  assert.ok(secUnboosted.length > 0, "should have security task");
  // security without external signal → medium
  assert.strictEqual(secUnboosted[0].priority, "medium", "security without signal should be medium");

  const boosted = buildChunkedAuditTasks(coverage, lineIndex, { intent_priority_boost: ["security"] });
  const secBoosted = boosted.filter((t) => t.lens === "security");
  assert.ok(secBoosted.length > 0, "should have security task after boost");
  assert.strictEqual(secBoosted[0].priority, "high", "security boosted from medium → high");
});

test("intent_priority_boost: high lens stays high (no promotion above high)", () => {
  // security with external analyzer signal → already high; boosting should keep it high
  const files = [pendingFile("src/auth.ts", ["security"])];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/auth.ts": 100 };

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, {
    intent_priority_boost: ["security"],
    external_analyzer_results: {
      tool: "semgrep",
      results: [{
        id: "r1",
        path: "src/auth.ts",
        category: "security",
        summary: "SQL injection",
        severity: "high",
      }],
    },
  });
  const secTasks = tasks.filter((t) => t.lens === "security");
  assert.ok(secTasks.length > 0, "should have security task");
  assert.strictEqual(secTasks[0].priority, "high", "already high should stay high");
});

test("intent_priority_boost: unrelated lens not in boost list is unaffected", () => {
  const files = [
    pendingFile("src/a.ts", ["architecture"]),
    pendingFile("src/b.ts", ["security"]),
  ];
  const coverage = makeCoverage(files);
  const lineIndex = { "src/a.ts": 100, "src/b.ts": 100 };

  const tasks = buildChunkedAuditTasks(coverage, lineIndex, { intent_priority_boost: ["security"] });
  const archTask = tasks.find((t) => t.lens === "architecture");
  assert.ok(archTask, "architecture task should exist");
  assert.strictEqual(archTask.priority, "low", "architecture should remain low when not in boost list");
});
