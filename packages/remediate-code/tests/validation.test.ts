import { describe, it, expect } from "vitest";
import {
  validateFinding,
  validateRemediationPlan,
  validateRemediationBlock,
  validateItemSpec,
  validateClarificationRequest,
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

  // Regression: DAT-231b69f6 — schema had 'dependencies' required but TS type
  // and runtime code treat it as optional. Schema aligned to optional; validator
  // must accept absence and reject non-array values.
  it("passes a block with explicit dependencies array (DAT-231b69f6)", () => {
    const issues = validateRemediationBlock({
      block_id: "B-002",
      items: ["F-002"],
      parallel_safe: false,
      dependencies: ["B-001"],
    });
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("passes a block without dependencies field (DAT-231b69f6)", () => {
    const issues = validateRemediationBlock({
      block_id: "B-003",
      items: ["F-003"],
      parallel_safe: true,
      // dependencies deliberately omitted — should be accepted as optional
    });
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when dependencies is present but not an array of strings (DAT-231b69f6)", () => {
    const issues = validateRemediationBlock({
      block_id: "B-004",
      items: ["F-004"],
      parallel_safe: true,
      dependencies: "B-001",
    });
    expect(
      issues.some((i) => i.severity === "error" && i.path.includes("dependencies")),
    ).toBe(true);
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

import {
  validateGoalSpec,
  validateContextBundle,
  validateDesignSpec,
  validateDesignSpecGates,
  validateConceptualDesignCritique,
  validateObligationLedger,
  validateContractAssessmentReport,
  validateCounterexample,
  validateJudgeReport,
  validateImplementationDAG,
  validateVerificationReport,
} from "../src/validation/contractPipeline.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
} from "@audit-tools/shared";

describe("contract pipeline validators", () => {
  describe("validateGoalSpec", () => {
    const valid = {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G-001",
      objective: "Improve test coverage.",
      non_goals: [],
      success_criteria: ["All tests pass."],
      source_type: "conversation",
      created_at: new Date().toISOString(),
    };

    it("accepts a well-formed GoalSpec", () => {
      expect(validateGoalSpec(valid).filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects missing required fields", () => {
      const issues = validateGoalSpec({});
      expect(issues.some((i) => i.message.includes("contract_version"))).toBe(true);
    });

    it("rejects unsupported contract_version", () => {
      const issues = validateGoalSpec({ ...valid, contract_version: "wrong/v999" });
      expect(issues.some((i) => i.path.includes("contract_version"))).toBe(true);
    });

    it("rejects invalid source_type", () => {
      const issues = validateGoalSpec({ ...valid, source_type: "invalid" });
      expect(issues.some((i) => i.path.includes("source_type"))).toBe(true);
    });
  });

  describe("validateImplementationDAG", () => {
    const validNode = {
      id: "T-001",
      title: "Write tests",
      description: "Add unit tests.",
      satisfies_obligations: [],
      depends_on: [],
      verification_obligation_ids: [],
      targeted_commands: [],
      status: "pending",
    };

    const valid = {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G-001",
      nodes: [validNode],
      edges: [],
      created_at: new Date().toISOString(),
    };

    it("accepts a well-formed ImplementationDAG", () => {
      expect(validateImplementationDAG(valid).filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects malformed nodes", () => {
      const issues = validateImplementationDAG({ ...valid, nodes: [{ id: 123 }] });
      expect(issues.some((i) => i.message.includes("title"))).toBe(true);
    });

    it("rejects malformed edges", () => {
      const issues = validateImplementationDAG({
        ...valid,
        edges: [{ from: "T-001", to: "T-002", kind: "invalid_kind" }],
      });
      expect(issues.some((i) => i.path.includes("kind"))).toBe(true);
    });

    it("rejects invalid node status", () => {
      const issues = validateImplementationDAG({
        ...valid,
        nodes: [{ ...validNode, status: "flying" }],
      });
      expect(issues.some((i) => i.path.includes("status"))).toBe(true);
    });
  });

  describe("validateCounterexample", () => {
    const valid = {
      contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id: "G-001",
      counterexamples: [
        {
          id: "CE-001",
          claim: "The design dedupes inputs.",
          reproduction_steps: ["Submit the same input twice."],
          expected: "One stored row.",
          actual: "Two stored rows.",
          violated_obligation_ids: ["O-1"],
        },
      ],
      created_at: new Date().toISOString(),
    };

    it("accepts a well-formed CounterexampleReport", () => {
      expect(validateCounterexample(valid).filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("accepts an empty counterexamples array", () => {
      const issues = validateCounterexample({ ...valid, counterexamples: [] });
      expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects malformed counterexample entries", () => {
      const issues = validateCounterexample({
        ...valid,
        counterexamples: [{ id: "CE-002" }],
      });
      expect(issues.some((i) => i.path.includes("claim"))).toBe(true);
    });
  });

  describe("validateJudgeReport", () => {
    const valid = {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G-001",
      verdict: "approved",
      classifications: [
        {
          counterexample_id: "CE-001",
          classification: "invalid",
          rationale: "Does not falsify the claim.",
        },
      ],
      created_at: new Date().toISOString(),
    };

    it("accepts well-formed JudgeReport", () => {
      expect(validateJudgeReport(valid).filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects invalid verdict", () => {
      const issues = validateJudgeReport({ ...valid, verdict: "maybe" });
      expect(issues.some((i) => i.path.includes("verdict"))).toBe(true);
    });

    it("rejects invalid classification taxonomy values", () => {
      const issues = validateJudgeReport({
        ...valid,
        classifications: [
          {
            counterexample_id: "CE-001",
            classification: "kinda_real",
            rationale: "?",
          },
        ],
      });
      expect(issues.some((i) => i.path.includes("classification"))).toBe(true);
    });

    it("requires repair_directive when verdict is needs_repair", () => {
      const issues = validateJudgeReport({ ...valid, verdict: "needs_repair" });
      expect(issues.some((i) => i.path.includes("repair_directive"))).toBe(true);
    });

    it("accepts needs_repair with a valid repair_directive (finalized_module_contracts)", () => {
      const issues = validateJudgeReport({
        ...valid,
        verdict: "needs_repair",
        repair_directive: {
          target: "finalized_module_contracts",
          instruction: "Add a dedup invariant.",
        },
      });
      expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("accepts needs_repair with legacy design_spec repair_directive for backward compat", () => {
      const issues = validateJudgeReport({
        ...valid,
        verdict: "needs_repair",
        repair_directive: {
          target: "design_spec",
          instruction: "Add a dedup invariant.",
        },
      });
      expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects a repair_directive with an unknown target", () => {
      const issues = validateJudgeReport({
        ...valid,
        verdict: "needs_repair",
        repair_directive: { target: "goal_spec", instruction: "Rewrite it." },
      });
      expect(issues.some((i) => i.path.includes("repair_directive.target"))).toBe(true);
    });
  });

  describe("validateVerificationReport", () => {
    const valid = {
      contract_version: CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
      findings: [],
      overall_status: "passed",
      created_at: new Date().toISOString(),
    };

    it("accepts well-formed VerificationReport", () => {
      expect(validateVerificationReport(valid).filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects invalid overall_status", () => {
      const issues = validateVerificationReport({ ...valid, overall_status: "unknown" });
      expect(issues.some((i) => i.path.includes("overall_status"))).toBe(true);
    });

    it("rejects missing traces array on finding", () => {
      const issues = validateVerificationReport({
        ...valid,
        findings: [{ finding_id: "F-001", traces: "not-array", overall_status: "passed" }],
      });
      expect(issues.some((i) => i.message.includes("traces"))).toBe(true);
    });

    it("rejects trace without evidence", () => {
      const issues = validateVerificationReport({
        ...valid,
        findings: [{
          finding_id: "F-001",
          traces: [{
            trace_id: "T1",
            kind: "requirement",
            label: "req",
            evidence: "not-array",
            status: "passed",
          }],
          overall_status: "passed",
        }],
      });
      expect(issues.some((i) => i.message.includes("evidence"))).toBe(true);
    });
  });

  describe("validateDesignSpec", () => {
    const validDesignSpec = {
      contract_version: CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
      goal_id: "G-001",
      design_narrative: "A clear design narrative.",
      invariants: [{ id: "INV-1", description: "No duplicate keys" }],
      affected_paths: ["src/foo.ts"],
      created_at: new Date().toISOString(),
    };

    it("accepts a well-formed DesignSpec", () => {
      expect(validateDesignSpec(validDesignSpec).filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects wrong contract_version", () => {
      const issues = validateDesignSpec({ ...validDesignSpec, contract_version: "wrong/v999" });
      expect(issues.some((i) => i.path.includes("contract_version"))).toBe(true);
    });

    it("rejects missing goal_id", () => {
      const { goal_id: _, ...noGoalId } = validDesignSpec;
      const issues = validateDesignSpec(noGoalId);
      expect(issues.some((i) => i.path.includes("goal_id"))).toBe(true);
    });

    it("rejects missing design_narrative", () => {
      const issues = validateDesignSpec({ ...validDesignSpec, design_narrative: "" });
      expect(issues.some((i) => i.path.includes("design_narrative"))).toBe(true);
    });
  });
});

describe("validateDesignSpecGates", () => {
  const minimalDesignSpec = {
    contract_version: CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
    goal_id: "G-001",
    design_narrative: "Design narrative.",
    invariants: [{ id: "INV-1", description: "No duplicate keys" }],
    affected_paths: [],
    created_at: new Date().toISOString(),
  };

  it("passes when no optional annotation fields are present", () => {
    const issues = validateDesignSpecGates(minimalDesignSpec);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when a module entry lacks inputs", () => {
    const spec = { ...minimalDesignSpec, modules: [{ id: "M-1", inputs: [], outputs: ["out"] }] };
    const issues = validateDesignSpecGates(spec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("modules[0].inputs"))).toBe(true);
    expect(errors.some((e) => e.message.toLowerCase().includes("inputs"))).toBe(true);
  });

  it("errors when a module entry lacks outputs", () => {
    const spec = { ...minimalDesignSpec, modules: [{ id: "M-1", inputs: ["in"], outputs: [] }] };
    const issues = validateDesignSpecGates(spec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("modules[0].outputs"))).toBe(true);
  });

  it("errors when a side_effect entry has no owner", () => {
    const spec = { ...minimalDesignSpec, side_effects: [{ id: "SE-1", owner: "" }] };
    const issues = validateDesignSpecGates(spec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("side_effects[0].owner"))).toBe(true);
  });

  it("errors when an external_dependency entry lacks failure_semantics", () => {
    const spec = { ...minimalDesignSpec, external_dependencies: [{ id: "DEP-1", failure_semantics: "" }] };
    const issues = validateDesignSpecGates(spec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("external_dependencies[0].failure_semantics"))).toBe(true);
  });

  it("errors when a trust_boundary entry lacks validation_ref", () => {
    const spec = {
      ...minimalDesignSpec,
      trust_boundaries: [{ id: "TB-1", untrusted_inputs: ["user_data"], validation_ref: "" }],
    };
    const issues = validateDesignSpecGates(spec);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("trust_boundaries[0].validation_ref"))).toBe(true);
  });

  describe("invariant/obligation ledger cross-check", () => {
    const ledgerWithoutInvariantObl = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G-001",
      obligations: [
        { id: "OBL-1", description: "Some behavioral obligation", kind: "behavioral", depends_on: [], status: "pending" },
      ],
      created_at: new Date().toISOString(),
    };

    const ledgerWithInvariantObl = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G-001",
      obligations: [
        { id: "OBL-INV-1", description: "Obligation covering INV-1", kind: "invariant", depends_on: [], status: "pending" },
      ],
      created_at: new Date().toISOString(),
    };

    it("errors when invariant has no corresponding obligation in ledger", () => {
      const issues = validateDesignSpecGates(minimalDesignSpec, ledgerWithoutInvariantObl);
      const errors = issues.filter((i) => i.severity === "error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("INV-1"))).toBe(true);
      expect(errors.some((e) => e.message.toLowerCase().includes("verification obligation") || e.message.toLowerCase().includes("obligation"))).toBe(true);
    });

    it("passes when invariant has a corresponding invariant-kind obligation referencing its id", () => {
      const issues = validateDesignSpecGates(minimalDesignSpec, ledgerWithInvariantObl);
      expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });
  });

  describe("circular obligation dependency detection", () => {
    const circularLedger = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G-001",
      obligations: [
        { id: "O-1", description: "Obligation 1", kind: "behavioral", depends_on: ["O-2"], status: "pending" },
        { id: "O-2", description: "Obligation 2", kind: "behavioral", depends_on: ["O-1"], status: "pending" },
      ],
      created_at: new Date().toISOString(),
    };

    it("emits a warning (not error) for circular obligation dependencies", () => {
      // minimalDesignSpec has no invariants that need ledger coverage (INV-1 — but we
      // pass a ledger that references O-1/O-2, so INV-1 is still uncovered → error).
      // Use a design_spec with no invariants for a clean circular-only test.
      const specNoInvariants = { ...minimalDesignSpec, invariants: [] };
      const issues = validateDesignSpecGates(specNoInvariants, circularLedger);
      const warnings = issues.filter((i) => i.severity === "warning");
      const errors = issues.filter((i) => i.severity === "error");
      expect(warnings.length).toBeGreaterThan(0);
      expect(errors.filter((e) => e.message.includes("Circular"))).toHaveLength(0);
    });

    it("warning message includes 'Circular interface-definition dependency' and 'N-R21'", () => {
      const specNoInvariants = { ...minimalDesignSpec, invariants: [] };
      const issues = validateDesignSpecGates(specNoInvariants, circularLedger);
      const warnings = issues.filter((i) => i.severity === "warning");
      expect(warnings.some((w) => w.message.includes("Circular interface-definition dependency"))).toBe(true);
      expect(warnings.some((w) => w.message.includes("N-R21"))).toBe(true);
    });
  });

  it("passes a fully-populated well-formed design_spec", () => {
    const ledgerFull = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G-001",
      obligations: [
        { id: "OBL-INV-1", description: "Covers INV-1", kind: "invariant", depends_on: [], status: "pending" },
        { id: "OBL-2", description: "Behavioral obligation", kind: "behavioral", depends_on: ["OBL-INV-1"], status: "pending" },
      ],
      created_at: new Date().toISOString(),
    };
    const specFull = {
      ...minimalDesignSpec,
      modules: [{ id: "M-1", inputs: ["request"], outputs: ["response"] }],
      side_effects: [{ id: "SE-1", owner: "auth-module" }],
      external_dependencies: [{ id: "DEP-1", failure_semantics: "Returns 503 on timeout." }],
      trust_boundaries: [{ id: "TB-1", untrusted_inputs: ["user_data"], validation_ref: "input-validation-schema-v1" }],
    };
    const issues = validateDesignSpecGates(specFull, ledgerFull);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});
