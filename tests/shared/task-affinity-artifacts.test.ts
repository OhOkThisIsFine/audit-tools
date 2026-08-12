import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  writeCoreArtifacts,
  type ArtifactBundle,
} from "../../src/audit/io/artifacts.js";
import { runResultIngestionExecutor } from "../../src/audit/orchestrator/ingestionExecutors.js";
import { runPlanningExecutor } from "../../src/audit/orchestrator/planningExecutors.js";
import {
  buildTaskAffinityGraph,
  filterTaskAffinityGraph,
  TaskAffinityGraphSchema,
  type TaskAffinityEdge,
  type TaskAffinityGraph,
} from "../../src/audit/orchestrator/taskAffinityGraph.js";
import type { AuditTask } from "../../src/audit/types.js";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { stableStringify } from "../../src/shared/stableStringify.js";

const RED_SIGNATURE =
  "contract:stable-task-affinity-artifacts:not-yet-satisfied";
const missingProjectRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "__missing_task_affinity_project__",
);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEdges(left: TaskAffinityEdge, right: TaskAffinityEdge): number {
  for (const [leftValue, rightValue] of [
    [left.from, right.from],
    [left.to, right.to],
    [left.kind, right.kind],
    [left.reason ?? "", right.reason ?? ""],
  ] as const) {
    const compared = compareCodeUnits(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  return left.weight - right.weight;
}

function compareRanges(
  left: NonNullable<AuditTask["line_ranges"]>[number],
  right: NonNullable<AuditTask["line_ranges"]>[number],
): number {
  const path = compareCodeUnits(left.path, right.path);
  if (path !== 0) return path;
  const start = left.start - right.start;
  return start !== 0 ? start : left.end - right.end;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function makeTasks(reverse: boolean): AuditTask[] {
  const tasks: AuditTask[] = [
    {
      task_id: "task-Z",
      unit_id: "unit-shared",
      pass_id: "pass-security",
      lens: "security",
      file_paths: ["src/shared.ts", "src/z.ts"],
      file_line_counts: { "src/shared.ts": 40, "src/z.ts": 20 },
      line_ranges: [
        { path: "src/shared.ts", start: 1, end: 40 },
        { path: "src/z.ts", start: 1, end: 20 },
      ],
      inputs: { validation_command: "npm test" },
      rationale: "security review",
      priority: "high",
      token_estimate: 120,
      risk_estimate: 0.8,
      tags: ["alpha", "critical_flow:checkout"],
      status: "pending",
    },
    {
      task_id: "task-a",
      unit_id: "unit-shared",
      pass_id: "pass-correctness",
      lens: "correctness",
      file_paths: ["src/a.ts", "src/shared.ts"],
      file_line_counts: { "src/a.ts": 30, "src/shared.ts": 40 },
      line_ranges: [
        { path: "src/a.ts", start: 1, end: 30 },
        { path: "src/shared.ts", start: 1, end: 40 },
      ],
      inputs: { validation_command: "npm test" },
      rationale: "correctness review",
      priority: "medium",
      token_estimate: 140,
      risk_estimate: 0.6,
      tags: ["beta", "critical_flow:checkout"],
      status: "pending",
    },
    {
      task_id: "task-z",
      unit_id: "unit-leaf",
      pass_id: "pass-security-leaf",
      lens: "security",
      file_paths: ["src/leaf.ts"],
      file_line_counts: { "src/leaf.ts": 10 },
      line_ranges: [{ path: "src/leaf.ts", start: 1, end: 10 }],
      inputs: { validation_command: "npm test" },
      rationale: "leaf review",
      priority: "low",
      token_estimate: 30,
      risk_estimate: 0.2,
      tags: ["gamma", "critical_flow:checkout"],
      status: "pending",
    },
  ];

  if (!reverse) return tasks;
  return tasks.reverse().map((task) => ({
    ...task,
    file_paths: [...task.file_paths].reverse(),
    line_ranges: task.line_ranges
      ? [...task.line_ranges].reverse().map((range) => ({ ...range }))
      : undefined,
    tags: task.tags ? [...task.tags].reverse() : undefined,
  }));
}

function expectCanonicalTasks(tasks: readonly AuditTask[]): void {
  expect(tasks.map((task) => task.task_id)).toEqual(
    sortedUnique(tasks.map((task) => task.task_id)),
  );
  for (const task of tasks) {
    expect(task.file_paths).toEqual(sortedUnique(task.file_paths));
    if (task.tags) expect(task.tags).toEqual(sortedUnique(task.tags));
    if (task.line_ranges) {
      expect(task.line_ranges).toEqual([...task.line_ranges].sort(compareRanges));
    }
  }
}

function expectCanonicalGraph(graph: TaskAffinityGraph): void {
  expect(graph.nodes.map((node) => node.task_id)).toEqual(
    sortedUnique(graph.nodes.map((node) => node.task_id)),
  );
  for (const node of graph.nodes) {
    expect(node.file_paths).toEqual(sortedUnique(node.file_paths));
  }
  for (const edge of graph.edges) {
    expect(compareCodeUnits(edge.from, edge.to)).toBeLessThan(0);
  }
  expect(graph.edges).toEqual([...graph.edges].sort(compareEdges));
}

function normalizeEdge(edge: TaskAffinityEdge): TaskAffinityEdge {
  const [from, to] =
    compareCodeUnits(edge.from, edge.to) <= 0
      ? [edge.from, edge.to]
      : [edge.to, edge.from];
  return { ...edge, from, to };
}

function requireTasks(bundle: ArtifactBundle): AuditTask[] {
  expect(bundle.audit_tasks).toBeDefined();
  return bundle.audit_tasks ?? [];
}

function requireGraph(bundle: ArtifactBundle): TaskAffinityGraph {
  expect(bundle.task_affinity_graph).toBeDefined();
  return bundle.task_affinity_graph ?? {
    schema_version: "task-affinity-graph/v1",
    nodes: [],
    edges: [],
  };
}

async function persistedAffinityBytes(bundle: ArtifactBundle): Promise<{
  readonly tasks: string;
  readonly graph: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "audit-tools-affinity-"));
  try {
    await writeCoreArtifacts(root, {
      audit_tasks: bundle.audit_tasks,
      task_affinity_graph: bundle.task_affinity_graph,
    });
    return {
      tasks: await readFile(join(root, "audit_tasks.json"), "utf8"),
      graph: await readFile(join(root, "task_affinity_graph.json"), "utf8"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makePlanningBundle(reverse: boolean): ArtifactBundle {
  const paths = reverse
    ? ["src/z.ts", "src/shared.ts", "src/a.ts"]
    : ["src/a.ts", "src/shared.ts", "src/z.ts"];
  return {
    repo_manifest: {
      repository: { name: "affinity-fixture" },
      generated_at: "2026-08-11T00:00:00.000Z",
      files: paths.map((path, index) => ({
        path,
        language: "ts",
        size_bytes: 100 + index,
      })),
    },
    file_disposition: {
      files: paths.map((path) => ({ path, status: "included" as const })),
    },
    unit_manifest: {
      units: [
        {
          unit_id: "unit-shared",
          name: "shared",
          files: [...paths],
          required_lenses: ["security", "correctness"],
        },
      ],
    },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
  };
}

describe("stable task-affinity artifacts", () => {
  it("canonicalizes equivalent AuditTask permutations on copies", () => {
    const forward = deepFreeze(makeTasks(false));
    const reverse = deepFreeze(makeTasks(true));
    const forwardBefore = stableStringify(forward);
    const reverseBefore = stableStringify(reverse);

    const forwardGraph = buildTaskAffinityGraph(forward);
    const reverseGraph = buildTaskAffinityGraph(reverse);

    expect(stableStringify(reverseGraph), RED_SIGNATURE).toBe(
      stableStringify(forwardGraph),
    );
    expectCanonicalGraph(forwardGraph);
    expectCanonicalGraph(reverseGraph);
    expect(stableStringify(forward)).toBe(forwardBefore);
    expect(stableStringify(reverse)).toBe(reverseBefore);

    for (const task of forward) {
      const node = forwardGraph.nodes.find(
        (candidate) => candidate.task_id === task.task_id,
      );
      expect(node).toBeDefined();
      expect(node).not.toBe(task);
      expect(node?.file_paths).not.toBe(task.file_paths);
    }
  });

  it("canonicalizes filtered nodes and full edge tuples without aliasing", () => {
    const input = deepFreeze<TaskAffinityGraph>({
      schema_version: "task-affinity-graph/v1",
      nodes: [
        {
          task_id: "task-z",
          unit_id: "unit-leaf",
          lens: "security",
          file_paths: ["src/z.ts", "src/a.ts"],
          token_estimate: 30,
          risk_estimate: 0.2,
        },
        {
          task_id: "task-a",
          unit_id: "unit-shared",
          lens: "correctness",
          file_paths: ["src/shared.ts", "src/a.ts"],
          token_estimate: 140,
          risk_estimate: 0.6,
        },
        {
          task_id: "task-Z",
          unit_id: "unit-shared",
          lens: "security",
          file_paths: ["src/z.ts", "src/shared.ts"],
          token_estimate: 120,
          risk_estimate: 0.8,
        },
      ],
      edges: [
        {
          from: "task-a",
          to: "task-Z",
          kind: "same_unit",
          reason: "z-reason",
          weight: 0.55,
        },
        {
          from: "task-z",
          to: "task-a",
          kind: "same_flow",
          weight: 0.6,
        },
        {
          from: "task-a",
          to: "task-Z",
          kind: "same_dir",
          reason: "a-reason",
          weight: 0.35,
        },
        {
          from: "task-Z",
          to: "task-a",
          kind: "same_dir",
          weight: 0.3,
        },
      ],
    });
    const before = stableStringify(input);
    const filtered = filterTaskAffinityGraph(
      input,
      new Set(["task-z", "task-a", "task-Z"]),
    );

    expectCanonicalGraph(filtered);
    expect(filtered.edges).toEqual(
      input.edges.map(normalizeEdge).sort(compareEdges),
    );
    expect(stableStringify(input)).toBe(before);
    for (const node of filtered.nodes) {
      const source = input.nodes.find(
        (candidate) => candidate.task_id === node.task_id,
      );
      expect(node).not.toBe(source);
      expect(node.file_paths).not.toBe(source?.file_paths);
    }

    const pair = filterTaskAffinityGraph(
      input,
      new Set(["task-Z", "task-a"]),
    );
    expect(pair.nodes.map((node) => node.task_id)).toEqual(["task-Z", "task-a"]);
    expect(pair.edges.every((edge) =>
      pair.nodes.some((node) => node.task_id === edge.from) &&
      pair.nodes.some((node) => node.task_id === edge.to),
    )).toBe(true);
    expect(filterTaskAffinityGraph(input, new Set(["task-a"])).edges).toEqual([]);
    expect(filterTaskAffinityGraph(input, new Set())).toEqual({
      schema_version: "task-affinity-graph/v1",
      nodes: [],
      edges: [],
    });
  });

  it("rejects duplicate task ids plus self and dangling graph endpoints", () => {
    const tasks = makeTasks(false);
    expect(() =>
      buildTaskAffinityGraph([
        tasks[0],
        { ...tasks[0], rationale: "duplicate id" },
      ]),
    ).toThrow();

    const valid = buildTaskAffinityGraph(tasks);
    const firstNode = valid.nodes[0];
    const secondNode = valid.nodes[1];
    expect(firstNode).toBeDefined();
    expect(secondNode).toBeDefined();
    if (!firstNode || !secondNode) throw new Error("fixture needs two nodes");

    const invalidGraphs: readonly TaskAffinityGraph[] = [
      { ...valid, nodes: [...valid.nodes, { ...firstNode }] },
      {
        ...valid,
        edges: [
          ...valid.edges,
          {
            from: firstNode.task_id,
            to: firstNode.task_id,
            kind: "same_unit",
            weight: 0.55,
          },
        ],
      },
      {
        ...valid,
        edges: [
          ...valid.edges,
          {
            from: firstNode.task_id,
            to: "task-missing",
            kind: "same_unit",
            weight: 0.55,
          },
        ],
      },
    ];

    for (const graph of invalidGraphs) {
      expect(TaskAffinityGraphSchema.safeParse(graph).success).toBe(false);
      expect(() =>
        filterTaskAffinityGraph(
          graph,
          new Set(graph.nodes.map((node) => node.task_id)),
        ),
      ).toThrow();
    }
  });

  it("keeps ingestion bytes and metadata hashes canonical for task permutations", async () => {
    const forward = deepFreeze(makeTasks(false));
    const reverse = deepFreeze(makeTasks(true));
    const forwardBefore = stableStringify(forward);
    const reverseBefore = stableStringify(reverse);
    const forwardGraph = buildTaskAffinityGraph(forward);
    const reverseGraph = buildTaskAffinityGraph(reverse);

    const forwardResult = runResultIngestionExecutor(
      {
        coverage_matrix: { files: [] },
        audit_tasks: forward,
        task_affinity_graph: forwardGraph,
      },
      [],
    );
    const reverseResult = runResultIngestionExecutor(
      {
        coverage_matrix: { files: [] },
        audit_tasks: reverse,
        task_affinity_graph: reverseGraph,
      },
      [],
    );
    const forwardTasks = requireTasks(forwardResult.updated);
    const reverseTasks = requireTasks(reverseResult.updated);
    const persistedForwardGraph = requireGraph(forwardResult.updated);
    const persistedReverseGraph = requireGraph(reverseResult.updated);

    expectCanonicalTasks(forwardTasks);
    expectCanonicalTasks(reverseTasks);
    expectCanonicalGraph(persistedForwardGraph);
    expectCanonicalGraph(persistedReverseGraph);
    expect(stableStringify(reverseTasks)).toBe(stableStringify(forwardTasks));
    expect(stableStringify(persistedReverseGraph)).toBe(
      stableStringify(persistedForwardGraph),
    );
    expect(hashArtifactValue("audit_tasks.json", reverse)).toBe(
      hashArtifactValue("audit_tasks.json", forward),
    );
    expect(hashArtifactValue("task_affinity_graph.json", reverseGraph)).toBe(
      hashArtifactValue("task_affinity_graph.json", forwardGraph),
    );
    expect(stableStringify(forward)).toBe(forwardBefore);
    expect(stableStringify(reverse)).toBe(reverseBefore);

    for (const source of forward) {
      const persisted = forwardTasks.find(
        (candidate) => candidate.task_id === source.task_id,
      );
      expect(persisted).not.toBe(source);
      expect(persisted?.file_paths).not.toBe(source.file_paths);
      expect(persisted?.line_ranges).not.toBe(source.line_ranges);
      expect(persisted?.tags).not.toBe(source.tags);
      expect(persisted?.inputs).not.toBe(source.inputs);
      expect(persisted?.file_line_counts).not.toBe(source.file_line_counts);
    }

    expect(await persistedAffinityBytes(reverseResult.updated)).toEqual(
      await persistedAffinityBytes(forwardResult.updated),
    );
  });

  it("keeps planning persistence canonical across reversed source artifacts", async () => {
    const forwardBundle = deepFreeze(makePlanningBundle(false));
    const reverseBundle = deepFreeze(makePlanningBundle(true));
    const forwardBefore = stableStringify(forwardBundle);
    const reverseBefore = stableStringify(reverseBundle);
    const lineIndex = {
      "src/a.ts": 30,
      "src/shared.ts": 40,
      "src/z.ts": 20,
    };

    const forwardResult = await runPlanningExecutor(
      forwardBundle,
      missingProjectRoot,
      lineIndex,
    );
    const reverseResult = await runPlanningExecutor(
      reverseBundle,
      missingProjectRoot,
      lineIndex,
    );
    const forwardTasks = requireTasks(forwardResult.updated);
    const reverseTasks = requireTasks(reverseResult.updated);
    const forwardGraph = requireGraph(forwardResult.updated);
    const reverseGraph = requireGraph(reverseResult.updated);

    expectCanonicalTasks(forwardTasks);
    expectCanonicalTasks(reverseTasks);
    expectCanonicalGraph(forwardGraph);
    expectCanonicalGraph(reverseGraph);
    expect(stableStringify(reverseTasks)).toBe(stableStringify(forwardTasks));
    expect(stableStringify(reverseGraph)).toBe(stableStringify(forwardGraph));
    expect(hashArtifactValue("audit_tasks.json", reverseTasks)).toBe(
      hashArtifactValue("audit_tasks.json", forwardTasks),
    );
    expect(hashArtifactValue("task_affinity_graph.json", reverseGraph)).toBe(
      hashArtifactValue("task_affinity_graph.json", forwardGraph),
    );
    expect(stableStringify(forwardBundle)).toBe(forwardBefore);
    expect(stableStringify(reverseBundle)).toBe(reverseBefore);
    expect(await persistedAffinityBytes(reverseResult.updated)).toEqual(
      await persistedAffinityBytes(forwardResult.updated),
    );
  });
});
