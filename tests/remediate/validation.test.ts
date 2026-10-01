import { canonicalPlanFixture, canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";
import { describe, it, expect } from "vitest";
import {
  validateFinding,
  validateRemediationPlan,
  validateExecutionUnit,
  validateTriageResolution,
} from "../../src/remediate/validation/remediationState.js";
import {
  createValidationIssue,
  describeValue,
  formatValidationIssues,
  prefixValidationIssues,
  pushValidationIssue,
  requireKeys,
} from "audit-tools/shared";

const validFinding = {
  id: "F-001",
  title: "Test finding",
  category: "security",
  severity: "high" as const,
  confidence: "high" as const,
  lens: "security",
  summary: "A test finding.",
  affected_files: [{ path: "src/foo.ts" }],
  evidence: ["Line 1: bad thing"],
};

describe("validateFinding", () => {
  it("passes a valid finding with no issues", () => {
    const issues = validateFinding(validFinding);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when lens is missing", () => {
    const { lens: _, ...noLens } = validFinding;
    const issues = validateFinding(noLens);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("lens"))).toBe(true);
  });

  it("errors when category is missing", () => {
    const { category: _, ...noCategory } = validFinding;
    const issues = validateFinding(noCategory);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("category"))).toBe(true);
  });

  it("errors when evidence is missing (not just a warning)", () => {
    const { evidence: _, ...noEvidence } = validFinding;
    const issues = validateFinding(noEvidence);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(
        (e) =>
          e.message.toLowerCase().includes("evidence") ||
          e.path.includes("evidence"),
      ),
    ).toBe(true);
  });

  it("errors when evidence is not an array", () => {
    const issues = validateFinding({
      ...validFinding,
      evidence: "not-an-array",
    });
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.path.includes("evidence"))).toBe(true);
  });

  it("errors when severity is invalid", () => {
    const issues = validateFinding({
      ...validFinding,
      severity: "critical-high",
    });
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });

  it("errors when affected_files is missing", () => {
    const { affected_files: _, ...noFiles } = validFinding;
    const issues = validateFinding(noFiles);
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });

  it("errors when value is not an object", () => {
    const issues = validateFinding("a string");
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });
});

describe("validateRemediationPlan", () => {
  it("passes a valid plan with no issues", () => {
    const unit = canonicalUnitFixture("B-001", { source_finding_ids: [validFinding.id] });
    const plan = canonicalPlanFixture({ findings: [validFinding], units: [unit], requirements: [{ id: unit.requirement_ids[0]!, description: "Preserve behavior", source_finding_ids: [validFinding.id], change_kind: "structural", assertions: [] }] });
    const issues = validateRemediationPlan(plan);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when plan_id is missing", () => {
    const issues = validateRemediationPlan({
      findings: [],
      blocks: [],
      project_type: "ts",
    });
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });

  it("errors when candidate_closing_actions is missing", () => {
    const issues = validateRemediationPlan({
      plan_id: "plan-1",
      findings: [],
      blocks: [],
      project_type: "ts",
    });
    const errors = issues.filter((i) => i.severity === "error");
    expect(
      errors.some((e) => e.path.includes("candidate_closing_actions")),
    ).toBe(true);
  });
});

describe("validateExecutionUnit", () => {
  it("accepts a complete unit and explicit empty write scope", () => {
    expect(validateExecutionUnit(canonicalUnitFixture("U-one"))).toEqual([]);
    expect(validateExecutionUnit(canonicalUnitFixture("U-one", { allowed_files: [] }))).toEqual([]);
  });
  it("requires explicit read, write, test and dependency fields", () => {
    for (const field of ["allowed_files", "read_paths", "required_tests", "dependencies", "requirement_ids"]) {
      const value: Record<string, unknown> = { ...canonicalUnitFixture("U-one") }; delete value[field];
      expect(validateExecutionUnit(value).some(issue => issue.path.includes(field))).toBe(true);
    }
  });
  it("rejects malformed scope and dependency values", () => {
    for (const field of ["allowed_files", "read_paths", "dependencies"]) {
      expect(validateExecutionUnit({ ...canonicalUnitFixture("U-one"), [field]: "not-an-array" }).some(issue => issue.path.includes(field))).toBe(true);
    }
  });
  it("rejects retired block authority instead of inferring executable intent", () => {
    expect(validateExecutionUnit({ block_id: "B-one", items: ["F-one"], touched_files: [], parallel_safe: true }).length).toBeGreaterThan(0);
  });
});

describe("validateTriageResolution", () => {
  it("passes a valid resolution", () => {
    const res = { items: [{ unit_id: "F-001", action: "retry" }] };
    const issues = validateTriageResolution(res);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors for invalid action", () => {
    const issues = validateTriageResolution({
      items: [{ unit_id: "F-001", action: "delete" }],
    });
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });
});

describe("basic validation helpers", () => {
  it("describes primitive and structural values", () => {
    expect(describeValue([])).toBe("array");
    expect(describeValue(null)).toBe("null");
    expect(describeValue("x")).toBe("string");
  });

  it("creates, pushes, prefixes, and formats validation issues", () => {
    const issues = [createValidationIssue("field", "bad", "warning")];
    pushValidationIssue(issues, "other", "missing");
    const prefixed = prefixValidationIssues("root", issues);
    expect(prefixed.map((i) => i.path)).toEqual(["root.field", "root.other"]);
    expect(formatValidationIssues(prefixed)).toContain("[warning] root.field");
  });

  it("does not double-prefix paths that already include the prefix", () => {
    const prefixed = prefixValidationIssues("root", [
      createValidationIssue("root.field", "bad"),
      createValidationIssue("", "bad"),
    ]);
    expect(prefixed.map((i) => i.path)).toEqual(["root.field", "root"]);
  });

  it("requireKeys reports non-objects and missing keys", () => {
    expect(requireKeys(null, "value", ["a"])[0].message).toContain("null");
    const issues = requireKeys({ a: 1 }, "value", ["a", "b"]);
    expect(issues.some((i) => i.message.includes("b"))).toBe(true);
  });
});

import { ExecutableChangePlanSchema, ExecutionRequirementSchema } from "../../src/shared/types/executionPlan.js";

describe("executable plan acceptance assertions", () => {
  it("requires positive and negative assertions for behavior changes", () => {
    expect(ExecutionRequirementSchema.safeParse({id:"REQ-x",description:"Changed behavior",source_finding_ids:[],change_kind:"behavior_change",assertions:[{kind:"positive",description:"Works",scope_paths:["src/foo.ts"]}]}).success).toBe(false);
  });
  it("preserves explicit scoped positive and negative evidence", () => {
    expect(ExecutionRequirementSchema.safeParse({id:"REQ-x",description:"Changed behavior",source_finding_ids:[],change_kind:"behavior_change",assertions:[{kind:"positive",description:"Works",scope_paths:["src/foo.ts"]},{kind:"negative",description:"Rejects invalid input",scope_paths:["src/foo.ts"]}]}).success).toBe(true);
  });
  it("does not require invented work for an explicitly empty plan", () => {
    expect(ExecutableChangePlanSchema.safeParse({plan_id:"P",objective:"No approved work",non_goals:[],requirements:[],units:[],source_dispositions:[]}).success).toBe(true);
  });
});
