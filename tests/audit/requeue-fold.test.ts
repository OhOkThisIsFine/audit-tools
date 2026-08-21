import { test, expect } from "vitest";

import { foldPendingRequeueTasks } from "../../src/audit/orchestrator/requeueFold.js";
import { UNMEASURED_LINE_COUNT } from "../../src/audit/cli/lineIndex.js";
import type { AuditTask } from "../../src/audit/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requeueTask(overrides: Partial<AuditTask>): AuditTask {
  return {
    task_id: `requeue:${overrides.lens ?? "security"}:${(overrides.file_paths ?? ["src/a.ts"])[0]}`,
    unit_id: "unit-1",
    pass_id: "pass-1",
    lens: "security",
    file_paths: ["src/a.ts"],
    rationale: "requeue fallback",
    status: "pending",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Fold behavior: a genuinely-uncovered pending requeue task survives the
// fold and is enriched with line_line counts; a fully-covered one is dropped
// (this is selectUncoveredRequeueTasks, folded together with enrichment).
// ---------------------------------------------------------------------------

test("foldPendingRequeueTasks keeps an uncovered pending requeue task, enriched with line counts", () => {
  const requeueTasks: AuditTask[] = [
    requeueTask({
      task_id: "requeue:security:src/uncovered.ts",
      lens: "security",
      file_paths: ["src/uncovered.ts"],
    }),
  ];
  const auditTasks: AuditTask[] = []; // nothing covers src/uncovered.ts yet

  const result = foldPendingRequeueTasks({
    requeueTasks,
    auditTasks,
    lineIndex: { "src/uncovered.ts": 42 },
  });

  expect(result).toHaveLength(1);
  expect(result[0].task_id).toBe("requeue:security:src/uncovered.ts");
  expect(result[0].file_line_counts).toEqual({ "src/uncovered.ts": 42 });
});

test("foldPendingRequeueTasks drops a requeue task whose paths are already covered by the same lens", () => {
  const requeueTasks: AuditTask[] = [
    requeueTask({
      task_id: "requeue:security:src/covered.ts",
      lens: "security",
      file_paths: ["src/covered.ts"],
    }),
  ];
  const auditTasks: AuditTask[] = [
    {
      task_id: "unit-1:security",
      unit_id: "unit-1",
      pass_id: "pass-1",
      lens: "security",
      file_paths: ["src/covered.ts"],
      rationale: "planned coverage",
    },
  ];

  const result = foldPendingRequeueTasks({
    requeueTasks,
    auditTasks,
    lineIndex: { "src/covered.ts": 10 },
  });

  expect(result).toEqual([]);
});

// ---------------------------------------------------------------------------
// (2) The unmeasured-line-count filter: an absent index key, a null-ish value,
// and the UNMEASURED_LINE_COUNT (NaN) sentinel must all be OMITTED from
// file_line_counts rather than pollute it — the exact defect the fix commit
// (63fcc0ea) named: inlining `!isUnmeasuredLineCount` back out produces a
// serialized `null` in file_line_counts (fail-2 in that commit's red-green log).
// ---------------------------------------------------------------------------

test("foldPendingRequeueTasks' measured-line-counts filter omits an unmeasured sentinel entry", () => {
  const requeueTasks: AuditTask[] = [
    requeueTask({
      task_id: "requeue:security:src/mixed.ts",
      lens: "security",
      file_paths: ["src/measured.ts", "src/unmeasured.ts", "src/absent.ts"],
    }),
  ];

  const result = foldPendingRequeueTasks({
    requeueTasks,
    auditTasks: [],
    lineIndex: {
      "src/measured.ts": 7,
      "src/unmeasured.ts": UNMEASURED_LINE_COUNT,
      // "src/absent.ts" deliberately has no entry in the index at all
    },
  });

  expect(result).toHaveLength(1);
  const { file_line_counts } = result[0];
  expect(file_line_counts).toEqual({ "src/measured.ts": 7 });
  expect(file_line_counts).not.toHaveProperty("src/unmeasured.ts");
  expect(file_line_counts).not.toHaveProperty("src/absent.ts");
  // Every surviving value must be a real finite number — never NaN/null leaking
  // through as a JSON-serialized null.
  for (const value of Object.values(file_line_counts ?? {})) {
    expect(Number.isFinite(value)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Additional coverage: operator lens exclusion and non-pending status still
// gate the fold, folded together with the same call.
// ---------------------------------------------------------------------------

test("foldPendingRequeueTasks excludes a lens the operator did not select", () => {
  const requeueTasks: AuditTask[] = [
    requeueTask({
      task_id: "requeue:performance:src/perf.ts",
      lens: "performance",
      file_paths: ["src/perf.ts"],
    }),
  ];

  const result = foldPendingRequeueTasks({
    requeueTasks,
    auditTasks: [],
    lineIndex: { "src/perf.ts": 5 },
    effectiveLenses: ["security"],
  });

  expect(result).toEqual([]);
});

test("foldPendingRequeueTasks excludes a non-pending requeue task", () => {
  const requeueTasks: AuditTask[] = [
    requeueTask({
      task_id: "requeue:security:src/done.ts",
      lens: "security",
      file_paths: ["src/done.ts"],
      status: "complete",
    }),
  ];

  const result = foldPendingRequeueTasks({
    requeueTasks,
    auditTasks: [],
    lineIndex: { "src/done.ts": 5 },
  });

  expect(result).toEqual([]);
});
