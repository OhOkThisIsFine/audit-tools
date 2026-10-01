import { ExecutableChangePlanSchema } from "../../src/shared/types/executionPlan.js";

/** A real semantic plan whose only variable is the execution dependency graph. */
export function executionPlanForGraph(edges: Array<[string, string[]]>) {
  return ExecutableChangePlanSchema.parse({ plan_id: "graph-plan", objective: "Verify execution dependencies", non_goals: [],
    requirements: edges.map(([id]) => ({ id: `REQ-${id}`, description: `Requirement ${id}`, source_finding_ids: [], change_kind: "structural", assertions: [] })),
    units: edges.map(([id, dependencies]) => ({ id, title: id, description: `Execute ${id}`, source_finding_ids: [], requirement_ids: [`REQ-${id}`], dependencies,
      read_paths: [`src/${id}.ts`], allowed_files: [`src/${id}.ts`], required_tests: ["npm test"], affected_interfaces: [], addresses_counterexample_ids: [] })),
    source_dispositions: [],
  });
}
