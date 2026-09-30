import { expect, describe, it } from "vitest";
import { ExecutableChangePlanSchema, ExecutionRequirementSchema, executionPlanReferenceIssues } from "../../src/shared/types/executionPlan.js";
import { executionPlanForGraph } from "./executionPlanGraphFixture.js";

describe("shared executable plan contract", () => {
  it("roundtrips the actual reviewed unit and stable requirement identities", () => {
    const plan = executionPlanForGraph([["A", []], ["B", ["A"]]]);
    const copy = ExecutableChangePlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(copy).toEqual(plan);
    expect(copy.units[1]?.requirement_ids).toEqual(["REQ-B"]);
    expect(copy.units[1]?.dependencies).toEqual(["A"]);
    expect(executionPlanReferenceIssues(copy, [])).toEqual([]);
  });
  it("requires scoped positive and negative assertions for behavior changes", () => {
    const requirement = { id: "REQ-1", description: "Keep retry safe", source_finding_ids: [], change_kind: "behavior_change", assertions: [] };
    expect(ExecutionRequirementSchema.safeParse(requirement).success).toBe(false);
    expect(ExecutionRequirementSchema.safeParse({ ...requirement, assertions: [
      { kind: "positive", description: "Retry preserves one write", scope_paths: ["src/a.ts"] },
      { kind: "negative", description: "Duplicate retry cannot duplicate the write", scope_paths: ["src/a.ts"] },
    ] }).success).toBe(true);
  });
  it("rejects dangling requirement and original source references", () => {
    const plan = executionPlanForGraph([["A", []]]);
    plan.units[0]!.requirement_ids = ["missing"];
    plan.units[0]!.source_finding_ids = ["unapproved"];
    expect(executionPlanReferenceIssues(plan, []).join("\n")).toMatch(/unknown requirement/);
    expect(executionPlanReferenceIssues(plan, []).join("\n")).toMatch(/unknown source finding/);
  });
});
