import { describe, it, expect } from "vitest";
import {
  validateFinding,
  validateRemediationPlan,
  validateRemediationBlock,
  validateItemSpec,
  validateClarificationRequest,
  validateDocumentResponse,
  validateTriageResolution,
} from "../src/validation/remediationState.js";
import {
  createValidationIssue,
  describeValue,
  formatValidationIssues,
  prefixValidationIssues,
  pushValidationIssue,
  requireKeys,
} from "@audit-tools/shared";

const validFinding = {
  id: "F-001",
  title: "Test finding",
  category: "security",
  severity: "high",
  confidence: "high",
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
    const plan = {
      plan_id: "plan-1",
      findings: [validFinding],
      blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
      project_type: "typescript-node",
      candidate_closing_actions: ["commit"],
    };
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

describe("validateRemediationBlock", () => {
  it("passes a valid remediation block", () => {
    const issues = validateRemediationBlock({
      block_id: "B-001",
      items: ["F-001"],
      parallel_safe: true,
    });
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when required block fields are malformed", () => {
    const issues = validateRemediationBlock({
      block_id: "B-001",
      items: "F-001",
      parallel_safe: "yes",
    });
    expect(issues.some((i) => i.path.includes("items"))).toBe(true);
    expect(issues.some((i) => i.path.includes("parallel_safe"))).toBe(true);
  });
});

describe("validateItemSpec", () => {
  it("passes a valid item_spec", () => {
    const spec = {
      finding_id: "F-001",
      concrete_change: "Fix it.",
      tests_to_write: [{ name: "Test A", assertions: ["assert 1"] }],
      not_applicable_steps: [],
    };
    const issues = validateItemSpec(spec);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when finding_id is missing", () => {
    const issues = validateItemSpec({
      concrete_change: "x",
      tests_to_write: [],
      not_applicable_steps: [],
    });
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });
});

describe("validateClarificationRequest", () => {
  it("passes a valid clarification request", () => {
    const req = {
      finding_id: "F-001",
      category: "scope_of_fix",
      description: "What scope?",
    };
    const issues = validateClarificationRequest(req);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors for an invalid category", () => {
    const issues = validateClarificationRequest({
      finding_id: "F-001",
      category: "made_up",
      description: "x",
    });
    expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(
      0,
    );
  });
});

describe("validateDocumentResponse", () => {
  it("passes an item_spec response", () => {
    const issues = validateDocumentResponse({
      type: "item_spec",
      item_spec: {
        finding_id: "F-001",
        concrete_change: "Fix it.",
        tests_to_write: [],
        not_applicable_steps: [],
      },
    });
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("passes a clarification_request response", () => {
    const issues = validateDocumentResponse({
      type: "clarification_request",
      clarifications: [
        {
          finding_id: "F-001",
          category: "scope_of_fix",
          description: "Clarify scope",
        },
      ],
    });
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when a response omits the payload required by its type", () => {
    const issues = validateDocumentResponse({ type: "item_spec" });
    expect(issues.some((i) => i.path.includes("item_spec"))).toBe(true);
  });
});

describe("validateTriageResolution", () => {
  it("passes a valid resolution", () => {
    const res = { items: [{ finding_id: "F-001", action: "retry" }] };
    const issues = validateTriageResolution(res);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors for invalid action", () => {
    const issues = validateTriageResolution({
      items: [{ finding_id: "F-001", action: "delete" }],
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
