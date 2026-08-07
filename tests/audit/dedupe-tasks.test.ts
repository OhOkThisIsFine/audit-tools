/**
 * Unit tests for dedupeTasks function.
 * Addresses TST-69766a9a: Missing direct unit tests for dedupeTasks function.
 */

import { describe, it, expect } from "vitest";

import { dedupeTasks } from "../../src/audit/orchestrator/requeueCommand.js";

describe("dedupeTasks", () => {
  it("returns empty array for empty input", () => {
    const result = dedupeTasks([]);
    expect(result).toEqual([]);
  });

  it("returns array unchanged when no duplicates", () => {
    const tasks = [
      { task_id: "task-1", name: "First" },
      { task_id: "task-2", name: "Second" },
      { task_id: "task-3", name: "Third" },
    ];
    const result = dedupeTasks(tasks);
    expect(result).toEqual(tasks);
  });

  it("removes duplicate entries preserving first occurrence", () => {
    const tasks = [
      { task_id: "task-1", name: "First" },
      { task_id: "task-2", name: "Second" },
      { task_id: "task-1", name: "Duplicate First" },
      { task_id: "task-3", name: "Third" },
    ];
    const result = dedupeTasks(tasks);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ task_id: "task-1", name: "First" });
    expect(result[1]).toEqual({ task_id: "task-2", name: "Second" });
    expect(result[2]).toEqual({ task_id: "task-3", name: "Third" });
  });

  it("handles all entries being duplicates", () => {
    const tasks = [
      { task_id: "task-1", name: "First" },
      { task_id: "task-1", name: "Dup 1" },
      { task_id: "task-1", name: "Dup 2" },
    ];
    const result = dedupeTasks(tasks);
    expect(result).toHaveLength(1);
    expect(result[0]!.task_id).toBe("task-1");
    expect(result[0]!.name).toBe("First");
  });

  it("preserves original task data except for duplication", () => {
    interface TestTask {
      task_id: string;
      data: {
        nested: string;
      };
    }

    const tasks: TestTask[] = [
      { task_id: "a", data: { nested: "value1" } },
      { task_id: "b", data: { nested: "value2" } },
      { task_id: "a", data: { nested: "modified" } },
    ];
    const result = dedupeTasks(tasks);
    expect(result).toHaveLength(2);
    expect(result[0]!.data.nested).toBe("value1");
  });

  it("is stable: maintains order of first occurrence", () => {
    const tasks = [
      { task_id: "z", order: 1 },
      { task_id: "a", order: 2 },
      { task_id: "z", order: 3 },
      { task_id: "m", order: 4 },
      { task_id: "a", order: 5 },
    ];
    const result = dedupeTasks(tasks);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.task_id)).toEqual(["z", "a", "m"]);
  });

  it("works with generic type parameter", () => {
    // TypeScript should infer the generic type
    interface CustomTask {
      task_id: string;
      extra: number;
      nested: { value: string };
    }

    const tasks: CustomTask[] = [
      { task_id: "x", extra: 1, nested: { value: "a" } },
      { task_id: "y", extra: 2, nested: { value: "b" } },
      { task_id: "x", extra: 3, nested: { value: "c" } },
    ];
    const result: CustomTask[] = dedupeTasks(tasks);
    expect(result).toHaveLength(2);
    expect(result[0]!.extra).toBe(1);
    expect(result[1]!.extra).toBe(2);
  });
});
