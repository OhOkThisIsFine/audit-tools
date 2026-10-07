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

test("a file shared by two critical flows keeps its flow owner as work completes", () => {
  // F1 has three paths and F2 two, so F1 owns the shared src/d.ts. When src/b.ts
  // and src/c.ts complete, F1 has fewer PENDING paths than F2; a claim over the
  // pending set would move src/d.ts to F2 and rename its task under a re-plan.
  const lineIndex: Record<string, number> = { "src/a.ts": 1500, "src/b.ts": 2000, "src/c.ts": 1000, "src/d.ts": 1500 };
  const critical_flows = { flows: [
    { id: "f1", name: "F1", entrypoints: ["src/b.ts"], paths: ["src/b.ts", "src/c.ts", "src/d.ts"], concerns: ["correctness"] },
    { id: "f2", name: "F2", entrypoints: ["src/a.ts"], paths: ["src/a.ts", "src/d.ts"], concerns: ["correctness"] },
  ] };
  const flowPlan = (completed: string[]) => buildChunkedAuditTasks(
    { files: Object.keys(lineIndex).map((p) => file(p, completed.includes(p) ? ["correctness"] : [])) },
    lineIndex,
    { critical_flows },
  ).filter((t) => t.lens === "correctness");
  const ownerOfD = (tasks: AuditTask[]) => tasks.filter((t) => t.file_paths.includes("src/d.ts")).map((t) => t.unit_id);
  const before = flowPlan([]);
  expect(ownerOfD(before)).toEqual(["flow:f1"]);
  const after = flowPlan(["src/b.ts", "src/c.ts"]);
  expect(ownerOfD(after)).toEqual(["flow:f1"]);
  expect(after.find((t) => t.file_paths.includes("src/d.ts"))!.task_id).toBe(before.find((t) => t.file_paths.includes("src/d.ts"))!.task_id);
  expectNoIdNamesTwoFileSets(before, after);
});
