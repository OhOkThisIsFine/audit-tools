import { expect, test } from "vitest";

import {
  buildTaskCoherencePartition,
} from "../../src/audit/orchestrator/partitionTaskGraph.js";
import {
  buildTaskAffinityGraph,
  type TaskAffinityGraph,
} from "../../src/audit/orchestrator/taskAffinityGraph.js";
import { buildUnitManifest } from "../../src/audit/orchestrator/unitBuilder.js";
import { buildChunkedAuditTasks } from "../../src/audit/orchestrator/taskBuilder.js";
import type { AuditTask, CoverageMatrix, RepoManifest } from "../../src/audit/types.js";

const GRAPH: TaskAffinityGraph = {
  schema_version: "task-affinity-graph/v1",
  nodes: [
    {
      task_id: "c",
      unit_id: "u2",
      lens: "security",
      file_paths: ["src/c.ts"],
      token_estimate: 30,
      risk_estimate: 0.3,
    },
    {
      task_id: "a",
      unit_id: "u1",
      lens: "security",
      file_paths: ["src/a.ts"],
      token_estimate: 10,
      risk_estimate: 0.1,
    },
    {
      task_id: "b",
      unit_id: "u1",
      lens: "reliability",
      file_paths: ["src/b.ts"],
      token_estimate: 20,
      risk_estimate: 0.2,
    },
  ],
  edges: [
    {
      from: "a",
      to: "b",
      kind: "same_unit",
      weight: 0.001,
      reason: "same_unit,same_dir",
    },
  ],
};

test("task partition projects canonical coherence components", () => {
  const result = buildTaskCoherencePartition(GRAPH);
  expect(result.coherence_trace.components).toEqual([["a", "b"], ["c"]]);
  expect(result.packets.map((packet) => packet.task_ids)).toEqual([
    ["a", "b"],
    ["c"],
  ]);
  expect(result.packets[0]).toMatchObject({
    packet_id: "packet-1",
    token_estimate: 30,
    risk_mass: 0.3,
    risk_score: 0.2,
  });
});

test("numeric weights and extra runtime arguments cannot change membership", () => {
  const changedWeight: TaskAffinityGraph = {
    ...GRAPH,
    edges: GRAPH.edges.map((edge) => ({ ...edge, weight: 1 })),
  };
  expect(buildTaskCoherencePartition(changedWeight, { arbitrary: "runtime metadata" })).toEqual(
    buildTaskCoherencePartition(GRAPH),
  );
});

test("permuted graph arrays yield byte-stable projected packets", () => {
  const reversed: TaskAffinityGraph = {
    ...GRAPH,
    nodes: [...GRAPH.nodes].reverse().map((node) => ({
      ...node,
      file_paths: [...node.file_paths].reverse(),
    })),
    edges: [...GRAPH.edges].reverse(),
  };
  expect(JSON.stringify(buildTaskCoherencePartition(reversed))).toBe(
    JSON.stringify(buildTaskCoherencePartition(GRAPH)),
  );
});

// ── The measurement behind `TASK_DRAW_COHERENCE_POLICY` ─────────────────────
//
// The eligibility policy is `weighted_score_threshold` — the disjunctive form
// the findings draw had to abandon (items whose graph union-found into ONE
// component at 3,230 findings). That divergence is deliberate and now MEASURED,
// not assumed. The claim this test pins is STRUCTURAL: a task component is
// bounded by the UNIT partition, because at task granularity the evidence
// classes that fire across unit boundaries cannot union anything.
//
// It runs the real pipeline (repo manifest → unit manifest → coverage matrix →
// chunked audit tasks → affinity graph → coherence partition) over a synthetic
// multi-unit tree, so a future change to `KIND_WEIGHT` or the eligibility rule
// that reintroduces collapse fails here rather than in a live run. The live-tree
// measurement that motivated it is recorded on `TASK_DRAW_COHERENCE_POLICY`.

/**
 * A repo manifest with `4 * unitCount` files under `src/u<k>/` — enough files
 * per unit that the task builder emits several tasks, so cross-unit union is
 * observable rather than a single-task-per-unit artefact.
 */
function multiUnitManifest(unitCount: number): RepoManifest {
  const files = [];
  for (let unit = 0; unit < unitCount; unit += 1) {
    for (let depth = 0; depth < 4; depth += 1) {
      files.push({
        path: `src/u${unit}/m${depth}/f${depth}.ts`,
        language: "typescript",
        size_bytes: 400,
      });
    }
  }
  return { repository: { name: "measured" }, generated_at: "2026-09-10T00:00:00.000Z", files };
}

function pipelineTasks(unitCount: number): AuditTask[] {
  const unitManifest = buildUnitManifest(multiUnitManifest(unitCount));
  const coverageMatrix: CoverageMatrix = {
    files: unitManifest.units.flatMap((unit) =>
      unit.files.map((path) => ({
        path,
        unit_ids: [unit.unit_id],
        classification_status: "classified" as const,
        audit_status: "pending",
        required_lenses: unit.required_lenses.length > 0 ? unit.required_lenses : ["correctness"],
        completed_lenses: [],
      })),
    ),
  };
  const lineIndex = Object.fromEntries(coverageMatrix.files.map((file) => [file.path, 40]));
  return buildChunkedAuditTasks(coverageMatrix, lineIndex);
}

test("task components are bounded by the unit partition — the disjunctive draw does not collapse", () => {
  const tasks = pipelineTasks(24);
  expect(tasks.length).toBeGreaterThan(24);

  const partition = buildTaskCoherencePartition(buildTaskAffinityGraph(tasks));
  const unitOf = new Map(tasks.map((task) => [task.task_id, task.unit_id]));
  const sizes = partition.coherence_trace.components.map((component) => component.length);

  // THE BOUND: a unit is ATOMIC — it lands whole in exactly one component, never
  // split across two. This is what actually distinguishes the task draw from the
  // findings draw: a findings item carries no unit identity, so a finding's
  // component can fragment at any granularity, while an audit task's unit is a
  // partition no eligible task-to-task relation below 80 can cross.
  const componentOfUnit = new Map<string, number>();
  partition.coherence_trace.components.forEach((component, index) => {
    for (const unit of new Set(component.map((id) => unitOf.get(id)))) {
      expect(
        componentOfUnit.has(unit!),
        `unit ${unit} is split across components ${componentOfUnit.get(unit!)} and ${index}`,
      ).toBe(false);
      componentOfUnit.set(unit!, index);
    }
  });
  expect(componentOfUnit.size).toBe(new Set(tasks.map((task) => task.unit_id)).size);

  // …and the consequence: components can never outnumber units, because each one
  // is a whole number of them. A per-lens or per-file fragmentation of the same
  // units multiplies the component count past this ceiling.
  const unitCount = new Set(tasks.map((task) => task.unit_id)).size;
  expect(sizes).toHaveLength(unitCount);
  for (const size of sizes) expect(size).toBeGreaterThan(0);

  // The largest component is a whole unit (or a small union of them), never the
  // population: with 24 units the ceiling is the biggest unit's task count.
  const largest = Math.max(...sizes);
  const largestUnit = Math.max(
    ...[...new Set(tasks.map((task) => task.unit_id))].map(
      (unit) => tasks.filter((task) => task.unit_id === unit).length,
    ),
  );
  expect(largest).toBe(largestUnit);
  expect(largest).toBeLessThan(tasks.length);
});

test("a cross-unit relation is the ONLY way a task component grows past one unit", () => {
  // The merge classes available to the task draw that could cross a unit divide
  // are `call_import_reference_adjacency` (70), `same_flow` (60) and
  // `shared_file` (100). `buildTaskAffinityGraph` derives `call_adjacent` only
  // from a supplied graph bundle and `same_flow` only from a `critical_flow:`
  // tag — both absent by construction from `pipelineTasks` — so on a repo with
  // no such signal the unit partition IS the coherence partition.
  const tasks = pipelineTasks(8);
  const partition = buildTaskCoherencePartition(buildTaskAffinityGraph(tasks));
  const unitOf = new Map(tasks.map((task) => [task.task_id, task.unit_id]));

  const unitCounts = new Map<string, number>();
  for (const task of tasks) unitCounts.set(task.unit_id, (unitCounts.get(task.unit_id) ?? 0) + 1);
  const componentSizes = partition.coherence_trace.components
    .map((component) => [...component.map((id) => unitOf.get(id))])
    .map((units) => units.length);

  // One component per unit, each exactly that unit's task count.
  expect(partition.coherence_trace.components).toHaveLength(unitCounts.size);
  expect([...componentSizes].sort()).toEqual([...unitCounts.values()].sort());
  for (const component of partition.coherence_trace.components) {
    const units = new Set(component.map((id) => unitOf.get(id)));
    expect(units.size, "a component absorbed more than one unit").toBe(1);
  }

  // Force the one admissible cross-unit merge and show the component is then
  // exactly the two units, never the whole graph.
  const graph = buildTaskAffinityGraph(tasks);
  const [firstUnit, secondUnit] = [...unitCounts.keys()];
  const firstTask = tasks.find((task) => task.unit_id === firstUnit)!;
  const secondTask = tasks.find((task) => task.unit_id === secondUnit)!;
  const joined = buildTaskCoherencePartition({
    ...graph,
    edges: [
      ...graph.edges,
      { from: firstTask.task_id, to: secondTask.task_id, kind: "same_unit", weight: 0.6, reason: "same_flow" },
    ],
  });
  const merged = joined.coherence_trace.components.find(
    (component) => component.includes(firstTask.task_id),
  )!;
  expect(new Set(merged.map((id) => unitOf.get(id)))).toEqual(new Set([firstUnit, secondUnit]));
  expect(merged.length).toBe((unitCounts.get(firstUnit) ?? 0) + (unitCounts.get(secondUnit) ?? 0));
});
