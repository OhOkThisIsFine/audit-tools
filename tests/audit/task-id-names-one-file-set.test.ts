import { test, expect } from "vitest";
import type { AuditTask, CoverageFileRecord, CoverageMatrix } from "../../src/audit/types.js";

const { buildChunkedAuditTasks } = await import("../../src/audit/orchestrator/taskBuilder.js");

// A task id names exactly ONE file set, in every plan. Accepted host results are
// re-validated against the CURRENT audit_tasks each time the run moves on
// (executeAdvance, src/audit/cli/auditStep.ts): an id that is gone is a tolerated orphan, but an id
// that survives a re-plan naming OTHER files fails validation and stops the run.
// A re-plan re-chunks the pending files, so an id derived from a chunk's POSITION
// (part-N) or from its scope alone was reused for a different file set — the
// 2026-10-05 dogfood run stopped on 306 such errors.

function file(path: string, completed: string[] = []): CoverageFileRecord {
  return {
    path,
    classification_status: "classified",
    audit_status: "pending",
    required_lenses: ["correctness"],
    completed_lenses: completed,
    unit_ids: ["unit-1"],
  };
}

function plan(files: CoverageFileRecord[], lineIndex: Record<string, number>): AuditTask[] {
  const coverage: CoverageMatrix = { files };
  return buildChunkedAuditTasks(coverage, lineIndex, {}).filter((t) => t.lens === "correctness");
}

function expectNoIdNamesTwoFileSets(before: AuditTask[], after: AuditTask[]): void {
  const filesById = new Map(before.map((task) => [task.task_id, [...task.file_paths].sort()]));
  for (const task of after) {
    const earlier = filesById.get(task.task_id);
    if (earlier === undefined) continue;
    expect(
      [...task.file_paths].sort(),
      `task id '${task.task_id}' names a different file set after the re-plan`,
    ).toEqual(earlier);
  }
}

test("a budget-split re-plan never reuses a part id for a different file set", () => {
  // Five 1000-line files against the 3000-line default budget split into parts.
  const paths = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`);
  const lineIndex = Object.fromEntries(paths.map((p) => [p, 1000]));
  const before = plan(paths.map((p) => file(p)), lineIndex);
  expect(before.length, "the fixture must split").toBeGreaterThan(1);

  // The first file completes; the re-plan re-chunks the four that remain.
  const after = plan(
    paths.map((p, i) => file(p, i === 0 ? ["correctness"] : [])),
    lineIndex,
  );
  expectNoIdNamesTwoFileSets(before, after);
});

test("a single-chunk re-plan never reuses the scope id for a grown file set", () => {
  const lineIndex: Record<string, number> = { "src/a.ts": 10, "src/b.ts": 10, "src/c.ts": 10 };
  const before = plan([file("src/a.ts"), file("src/b.ts")], lineIndex);
  expect(before.length).toBe(1);

  // A third file of the same unit becomes pending (for example, a new file).
  const after = plan([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")], lineIndex);
  expectNoIdNamesTwoFileSets(before, after);
});

test("an unchanged pending set keeps its task ids across a re-plan", () => {
  const paths = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`);
  const lineIndex = Object.fromEntries(paths.map((p) => [p, 1000]));
  const first = plan(paths.map((p) => file(p)), lineIndex).map((t) => t.task_id);
  const second = plan(paths.map((p) => file(p)), lineIndex).map((t) => t.task_id);
  expect(second).toEqual(first);
});
