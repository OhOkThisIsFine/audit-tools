import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  renderContractPipelinePrompt,
  listContractPipelineRoles,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "../src/steps/contractPipelinePrompts.js";
import { contractPipelineDir } from "../src/contractPipeline/artifactStore.js";

const FAKE_ARTIFACTS_DIR = "/project/.audit-tools/remediation";
const FAKE_REPO_ROOT = "/project";

function cpPath(name: string): string {
  return join(contractPipelineDir(FAKE_ARTIFACTS_DIR), `${name}.json`);
}

const ALL_PATHS = {
  goal_spec: cpPath("goal_spec"),
  context_bundle: cpPath("context_bundle"),
  design_spec: cpPath("design_spec"),
  conceptual_design_critique: cpPath("conceptual_design_critique"),
  obligation_ledger: cpPath("obligation_ledger"),
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
    "design",
    "critique",
    "assessment",
    "implementation_planning",
    "closing",
  ];

  it("supports all expected role names", () => {
    const roles = listContractPipelineRoles();
    for (const role of EXPECTED_ROLES) {
      expect(roles).toContain(role);
    }
  });

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

describe("contract pipeline prompt renderer — isolation", () => {
  it("does not include unrelated artifact paths from other roles", () => {
    // goal_normalization requires no inputs; its prompt should not embed
    // context_bundle or design_spec paths in the input section.
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
