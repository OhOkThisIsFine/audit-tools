import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "../../src/remediate/steps/contractPipelinePrompts.js";
import { contractPipelineDir } from "../../src/remediate/contractPipeline/artifactStore.js";

const FAKE_ARTIFACTS_DIR = "/project/.audit-tools/remediation";
const FAKE_REPO_ROOT = "/project";

function cpPath(name: string): string {
  return join(contractPipelineDir(FAKE_ARTIFACTS_DIR), `${name}.json`);
}

const ALL_PATHS = {
  goal_spec: cpPath("goal_spec"),
  context_bundle: cpPath("context_bundle"),
  module_decomposition: cpPath("module_decomposition"),
  module_contracts: cpPath("module_contracts"),
  seam_reconciliation_report: cpPath("seam_reconciliation_report"),
  finalized_module_contracts: cpPath("finalized_module_contracts"),
  conceptual_design_critique: cpPath("conceptual_design_critique"),
  obligation_ledger: cpPath("obligation_ledger"),
  cyclic_seam_resolution: cpPath("cyclic_seam_resolution"),
  test_validator_plan: cpPath("test_validator_plan"),
  contract_assessment_report: cpPath("contract_assessment_report"),
  counterexample: cpPath("counterexample"),
  judge_report: cpPath("judge_report"),
  implementation_dag: cpPath("implementation_dag"),
  verification_report: cpPath("verification_report"),
} as const;

describe("contract pipeline prompt renderer — all roles", () => {
  const EXPECTED_ROLES = [
    "goal_normalization",
    "context_collection",
    "decomposition",
    "module_contract_drafting",
    "seam_reconciliation",
    "contract_finalization",
    "critique",
    "obligation_ledger",
    "cyclic_seam_resolution",
    "test_validator_plan",
    "assessment",
    "critic",
    "judge",
    "implementation_planning",
    "closing",
  ];

  it("phase order covers all expected roles", () => {
    for (const role of EXPECTED_ROLES) {
      expect(CONTRACT_PIPELINE_PHASE_ORDER).toContain(role);
    }
  });

  for (const role of EXPECTED_ROLES) {
    describe(`role: ${role}`, () => {
      it("renders a prompt that includes the role title", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt.length).toBeGreaterThan(0);
        // Title should appear in the prompt.
        expect(result.prompt).toMatch(/^#\s/m);
      });

      it("prompt includes the exact output path", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt).toContain(result.outputPath);
      });

      it("prompt includes required artifact paths", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        // Each role has either no required inputs or they appear in the prompt.
        expect(result.prompt).toContain("Required Inputs");
      });

      it("prompt includes stop-after-writing instructions", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt.toLowerCase()).toMatch(/stop after writing/);
      });

      it("prompt includes the expected JSON schema or contract shape", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        // Contract version string should appear in the prompt.
        expect(result.prompt).toContain("contract_version");
      });

      it("includes the repo root workdir note", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt).toContain(FAKE_REPO_ROOT);
      });
    });
  }
});

describe("contract pipeline prompt renderer — missing required artifacts", () => {
  it("throws a descriptive error when a required artifact path is missing", () => {
    // context_collection requires goal_spec.
    expect(() =>
      renderContractPipelinePrompt({
        role: "context_collection",
        artifactPaths: {
          // goal_spec deliberately omitted
          context_bundle: cpPath("context_bundle"),
        },
      }),
    ).toThrow(/goal_spec/);
  });

  it("throws a descriptive error when the output path is missing", () => {
    // goal_normalization has no required inputs but does need an output path.
    expect(() =>
      renderContractPipelinePrompt({
        role: "goal_normalization",
        artifactPaths: {
          // goal_spec (output) deliberately omitted
          context_bundle: cpPath("context_bundle"),
        },
      }),
    ).toThrow(/goal_spec/);
  });

  it("throws for an unknown role name", () => {
    expect(() =>
      renderContractPipelinePrompt({
        role: "does_not_exist",
        artifactPaths: ALL_PATHS,
      }),
    ).toThrow(/does_not_exist/);
  });
});

describe("adversarial critic and judge roles", () => {
  it("critic consumes the assessment and produces the counterexample report", () => {
    const result = renderContractPipelinePrompt({
      role: "critic",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.outputPath).toBe(ALL_PATHS.counterexample);
    expect(result.prompt).toMatch(/counterexample/i);
    expect(result.prompt).toContain(ALL_PATHS.contract_assessment_report);
  });

  it("judge consumes the counterexample report and emits the classification taxonomy", () => {
    const result = renderContractPipelinePrompt({
      role: "judge",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.outputPath).toBe(ALL_PATHS.judge_report);
    expect(result.prompt).toContain(ALL_PATHS.counterexample);
    expect(result.prompt).toMatch(/accepted \| out_of_scope \| duplicate \| invalid \| residual_risk/);
    expect(result.prompt).toMatch(/repair_directive/);
  });

  it("implementation_planning requires the judge report and states the traceability rule", () => {
    expect(() =>
      renderContractPipelinePrompt({
        role: "implementation_planning",
        artifactPaths: { ...ALL_PATHS, judge_report: undefined },
        repoRoot: FAKE_REPO_ROOT,
      }),
    ).toThrow(/judge_report/);

    const result = renderContractPipelinePrompt({
      role: "implementation_planning",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toMatch(/addresses_counterexamples/);
    expect(result.prompt).toMatch(/Traceability is mandatory/);
  });

  it("phase order runs critic then judge between assessment and implementation planning", () => {
    const order = CONTRACT_PIPELINE_PHASE_ORDER;
    expect(order.indexOf("critic")).toBeGreaterThan(order.indexOf("assessment"));
    expect(order.indexOf("judge")).toBe(order.indexOf("critic") + 1);
    expect(order.indexOf("implementation_planning")).toBe(order.indexOf("judge") + 1);
  });
});

describe("test_validator_plan role", () => {
  it("renders a valid prompt for test_validator_plan", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.outputPath).toBe(ALL_PATHS.test_validator_plan);
  });

  it("prompt includes test_validator_plan output path", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain(ALL_PATHS.test_validator_plan);
  });

  it("prompt includes goal_spec and obligation_ledger as required inputs", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain(ALL_PATHS.goal_spec);
    expect(result.prompt).toContain(ALL_PATHS.obligation_ledger);
  });

  it("prompt contains obligation_id field description", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain("obligation_id");
  });

  it("prompt contains inapplicable_claim description requiring ledger citation", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain("inapplicable_claim");
  });

  it("prompt contains contract_version schema shape", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain("contract_version");
  });

  it("prompt matches stop after writing instruction", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt.toLowerCase()).toMatch(/stop after writing/i);
  });

  it("CONTRACT_PIPELINE_PHASE_ORDER places test_validator_plan correctly", () => {
    const order = CONTRACT_PIPELINE_PHASE_ORDER;
    const tvpIdx = order.indexOf("test_validator_plan");
    const critiqueIdx = order.indexOf("critique");
    const assessmentIdx = order.indexOf("assessment");
    expect(tvpIdx).toBeGreaterThan(-1);
    expect(assessmentIdx).toBeGreaterThan(tvpIdx);
    expect(tvpIdx).toBeGreaterThan(critiqueIdx);
  });

  it("throws when obligation_ledger path missing for test_validator_plan", () => {
    expect(() =>
      renderContractPipelinePrompt({
        role: "test_validator_plan",
        artifactPaths: { ...ALL_PATHS, obligation_ledger: undefined },
        repoRoot: FAKE_REPO_ROOT,
      }),
    ).toThrow(/obligation_ledger/);
  });
});

describe("contract repair prompt", () => {
  it("renders a full-rewrite prompt for each repair target", () => {
    for (const target of [
      "finalized_module_contracts",
      "obligation_ledger",
      "contract_assessment_report",
    ] as const) {
      const result = renderContractRepairPrompt({
        target,
        instruction: "Address the accepted counterexamples.",
        artifactPaths: ALL_PATHS,
        repoRoot: FAKE_REPO_ROOT,
      });
      expect(result.outputPath).toBe(ALL_PATHS[target]);
      expect(result.prompt).toContain(`Contract Repair: ${target}`);
      expect(result.prompt).toContain("Address the accepted counterexamples.");
      expect(result.prompt).toContain(ALL_PATHS.judge_report);
      expect(result.prompt).toContain("contract_version");
      expect(result.prompt).toContain(FAKE_REPO_ROOT);
    }
  });

  it("throws when the target artifact path is missing", () => {
    expect(() =>
      renderContractRepairPrompt({
        target: "finalized_module_contracts",
        instruction: "Fix.",
        artifactPaths: { ...ALL_PATHS, finalized_module_contracts: undefined },
      }),
    ).toThrow(/finalized_module_contracts/);
  });

  it("throws when contract_assessment_report path is absent (TST-5ddb69b9)", () => {
    // renderContractRepairPrompt validates all requiredInputs before emitting the prompt.
    // contract_assessment_report is one of those required inputs regardless of target.
    expect(() =>
      renderContractRepairPrompt({
        target: "finalized_module_contracts",
        instruction: "Fix contract.",
        artifactPaths: { ...ALL_PATHS, contract_assessment_report: undefined },
      }),
    ).toThrow(/contract_assessment_report/);
  });
});

describe("contract pipeline prompt renderer — isolation", () => {
  it("does not include unrelated artifact paths from other roles", () => {
    // goal_normalization requires no inputs; its prompt should not embed
    // context_bundle or finalized_module_contracts paths in the input section.
    const result = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: ALL_PATHS,
    });
    // The output section will reference goal_spec (the output).
    // The required inputs section should say "No artifact inputs required".
    expect(result.prompt).toContain("No artifact inputs required");
  });

  it("source paths are not included when not provided", () => {
    const result = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: ALL_PATHS,
    });
    expect(result.prompt).not.toContain("Source Inputs");
  });

  it("source paths appear when provided", () => {
    const result = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: ALL_PATHS,
      sourcePaths: ["/project/.audit-tools/remediation/intake/remediation-brief.md"],
    });
    expect(result.prompt).toContain("Source Inputs");
    expect(result.prompt).toContain("remediation-brief.md");
  });
});

describe("contract pipeline — mandatory independent critic (paired positive/negative)", () => {
  // Adversarial review phases keyed strictly off phase identity. The judge
  // adjudicates the critic's counterexamples, so it too must be independent of
  // the design author (memory: delegate the judge too).
  for (const role of ["critique", "critic", "judge"] as const) {
    it(`POSITIVE: ${role} MANDATES an independent sub-agent when host can dispatch`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
        hostCanDispatchSubagents: true,
      });
      expect(result.prompt).toContain("Independent Review — MANDATORY");
      expect(result.prompt).toContain("MUST dispatch");
      expect(result.prompt).toContain("independent sub-agent");
      // Must NOT render the degrade-to-inline path.
      expect(result.prompt).not.toContain("degraded to inline self-review");
    });

    it(`NEGATIVE: ${role} degrades to inline (no hard mandate) when host cannot dispatch`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
        hostCanDispatchSubagents: false,
      });
      expect(result.prompt).toContain("degraded to inline self-review");
      expect(result.prompt).not.toContain("Independent Review — MANDATORY");
      expect(result.prompt).not.toContain("MUST dispatch");
    });

    it(`FAIL-SAFE: ${role} defaults to MANDATE when the flag is missing`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
      });
      expect(result.prompt).toContain("Independent Review — MANDATORY");
      expect(result.prompt).not.toContain("degraded to inline self-review");
    });
  }

  // The assessment phase is the author's OWN coverage self-assessment, not an
  // adversarial review of someone else's work, so it must NOT carry the
  // independent-critic mandate regardless of dispatch capability.
  for (const role of ["assessment"] as const) {
    it(`${role} carries no independent-critic directive (true)`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
        hostCanDispatchSubagents: true,
      });
      expect(result.prompt).not.toContain("Independent Review — MANDATORY");
      expect(result.prompt).not.toContain("degraded to inline self-review");
    });
    it(`${role} carries no independent-critic directive (false)`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
        hostCanDispatchSubagents: false,
      });
      expect(result.prompt).not.toContain("Independent Review — MANDATORY");
      expect(result.prompt).not.toContain("degraded to inline self-review");
    });
  }
});
