/**
 * T1 slice 3 — adversarial-depth dial.
 *
 * The critique / critic phases scale their adversarial depth from the intake
 * risk signal: low tier → a lightweight inline self-check; medium/high → the
 * full independent-review mandate. Floor is `light`, never off — and the depth
 * only affects the adversarial phases, never the rest of the pipeline.
 */
import { describe, it, expect } from "vitest";
import { adversarialDepthForTier } from "../../src/remediate/riskSignal.js";
import { renderContractPipelinePrompt } from "../../src/remediate/steps/contractPipelinePrompts.js";

const ARTIFACT_PATHS = {
  goal_spec: "/tmp/goal_spec.json",
  finalized_module_contracts: "/tmp/finalized_module_contracts.json",
  obligation_ledger: "/tmp/obligation_ledger.json",
  contract_assessment_report: "/tmp/contract_assessment_report.json",
  // Output-key paths the renderer also requires per role.
  conceptual_design_critique: "/tmp/conceptual_design_critique.json",
  counterexample: "/tmp/counterexample.json",
} as const;

function renderPrompt(role: string, adversarialDepth?: "light" | "full"): string {
  return renderContractPipelinePrompt({
    role,
    artifactPaths: ARTIFACT_PATHS,
    adversarialDepth,
  }).prompt;
}

const LIGHT_MARKER = "light inline self-check";
const MANDATE_MARKER = "Independent Review — MANDATORY";

describe("adversarialDepthForTier", () => {
  it("maps only low → light; medium/high → full", () => {
    expect(adversarialDepthForTier("low")).toBe("light");
    expect(adversarialDepthForTier("medium")).toBe("full");
    expect(adversarialDepthForTier("high")).toBe("full");
  });

  it("fails safe toward full for an absent tier", () => {
    expect(adversarialDepthForTier(undefined)).toBe("full");
  });
});

describe("depth dial in the adversarial phase prompts", () => {
  for (const role of ["critique", "critic"]) {
    it(`${role}: light depth renders the inline self-check, not the mandate`, () => {
      const prompt = renderPrompt(role, "light");
      expect(prompt).toContain(LIGHT_MARKER);
      expect(prompt).not.toContain(MANDATE_MARKER);
    });

    it(`${role}: full depth renders the independent mandate`, () => {
      const prompt = renderPrompt(role, "full");
      expect(prompt).toContain(MANDATE_MARKER);
      expect(prompt).not.toContain(LIGHT_MARKER);
    });

    it(`${role}: undefined depth defaults to the mandate (fail-safe)`, () => {
      const prompt = renderPrompt(role, undefined);
      expect(prompt).toContain(MANDATE_MARKER);
      expect(prompt).not.toContain(LIGHT_MARKER);
    });
  }

  it("light depth still emits a non-empty adversarial directive (floor, never off)", () => {
    const prompt = renderPrompt("critic", "light");
    // The floor: a low-risk run is NOT zero-scrutiny — it still carries an
    // explicit adversarial-pass instruction and an escalate-on-evidence hook.
    expect(prompt).toContain("never skipped");
    expect(prompt).toContain("escalate to a full independent review");
  });

  it("a non-adversarial phase is unaffected by depth", () => {
    const light = renderPrompt("assessment", "light");
    const full = renderPrompt("assessment", "full");
    expect(light).toBe(full);
    expect(light).not.toContain(LIGHT_MARKER);
    expect(light).not.toContain(MANDATE_MARKER);
  });
});
