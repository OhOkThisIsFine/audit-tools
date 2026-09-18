// The lens steward's SURFACE contract (owner directive 2026-09-17,
// `docs/reviews/lens-steward-redesign-2026-09-17.md`).
//
// A lens steward checks how well one lens covered the run. It used to be handed
// a score-ranked sample of twelve files and nothing else: the rest of the lens
// surface was computed, counted into a sentence of prose, and discarded. A file
// count measures no cost the tool cares about — twelve files of ten lines is not
// a bounded review, and twelve files of a hundred thousand lines is not one
// either — and the discard also capped what the steward may NAME in a follow-up,
// which costs nothing but a path.
//
// These tests pin the replacement: the steward is granted the whole lens
// surface, and it chooses what to review.

import { test, expect } from "vitest";
import type { AuditTask, AuditResult } from "../../src/audit/types.js";

const { buildLensVerificationTasks } = await import(
  "../../src/audit/orchestrator/selectiveDeepening/lensVerification.js"
);

const LENS = "security";

function stewardSource(
  index: number,
  filePath: string,
): { task: AuditTask; result: AuditResult } {
  const taskId = `task-${String(index).padStart(3, "0")}`;
  return {
    task: {
      task_id: taskId,
      unit_id: `unit:${taskId}`,
      pass_id: `pass:${LENS}`,
      lens: LENS,
      file_paths: [filePath],
      rationale: "test",
      priority: "high",
      tags: ["critical_flow"],
      status: "complete",
    },
    result: {
      task_id: taskId,
      unit_id: `unit:${taskId}`,
      pass_id: `pass:${LENS}`,
      lens: LENS,
      findings: [],
      file_coverage: [{ path: filePath, total_lines: 10 }],
      requires_followup: true,
    },
  };
}

/** A lens that reviewed 40 files, one per completed task. */
function lensSurface(fileCount: number): {
  tasks: AuditTask[];
  results: AuditResult[];
  paths: string[];
} {
  const tasks: AuditTask[] = [];
  const results: AuditResult[] = [];
  const paths: string[] = [];
  for (let index = 0; index < fileCount; index++) {
    const path = `src/file${String(index).padStart(3, "0")}.ts`;
    const source = stewardSource(index, path);
    tasks.push(source.task);
    results.push(source.result);
    paths.push(path);
  }
  return { tasks, results, paths };
}

test("a lens steward is granted every file its lens was applied to", () => {
  const { tasks, results, paths } = lensSurface(40);

  const stewardTasks = buildLensVerificationTasks({
    existingTasks: tasks,
    results,
  });

  expect(stewardTasks, "one steward task is built for the lens").toHaveLength(1);
  const steward = stewardTasks[0]!;

  // The whole point. A steward that holds only a ranked sample cannot judge the
  // coverage of what it was never shown, and cannot name a dropped file in a
  // follow-up — which is the one case the follow-up field exists for.
  expect(
    [...steward.file_paths].sort(),
    "the steward's granted surface is every file the lens reviewed, not a ranked sample of it",
  ).toEqual([...paths].sort());
});

test("a lens steward carries a line count for every file on its surface", () => {
  const { tasks, results, paths } = lensSurface(40);

  const steward = buildLensVerificationTasks({
    existingTasks: tasks,
    results,
  })[0]!;

  // A granted path with no line count is a path the steward cannot size before
  // it decides whether to open the file, which is exactly the judgement the
  // surface exists to support.
  for (const path of paths) {
    expect(
      steward.file_line_counts?.[path],
      `the surface states a line count for ${path}`,
    ).toBe(10);
  }
});
