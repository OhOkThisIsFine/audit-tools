/**
 * Tests for the parallel design-review split (N-A05):
 *   - deriveAuditState obligation derivation
 *   - renderContractReviewPrompt / renderConceptualReviewPrompt
 *   - renderSharedStructuralContext shared prefix
 *   - PRIORITY chain ordering
 */
import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { DesignAssessment } from "../../src/audit/types/designAssessment.js";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");
const {
  renderContractReviewPrompt,
  renderConceptualReviewPrompt,
  renderSharedStructuralContext,
} = await import("../../src/audit/orchestrator/designReviewPrompt.js");
const { PRIORITY } = await import("../../src/audit/orchestrator/nextStep.js");

// ── Minimal bundle factory ────────────────────────────────────────────────────

/**
 * A pre-split `design_assessment.json` as it exists ON DISK — the combined
 * `reviewed` flag and nothing else. Cast because the field is deliberately gone
 * from the type: the shape has exactly one legitimate producer left (an artifact
 * written by the previous release), so the cast IS the point.
 */
function preSplitDesignAssessment(): DesignAssessment {
  return {
    generated_at: "2026-01-01T00:00:00Z",
    findings: [],
    reviewed: true,
  } as unknown as DesignAssessment;
}

function minimalBundle(
  designAssessmentOverrides: Partial<DesignAssessment> = {},
): ArtifactBundle {
  return {
    repo_manifest: {
      generated_at: "2026-01-01T00:00:00Z",
      repository: { name: "test-repo" },
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      ...designAssessmentOverrides,
    },
  };
}

function requireDefined<T>(
  value: T,
  label: string,
): asserts value is NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`${label} is missing`);
  }
}

// ── state.ts: design_review_contract_completed ────────────────────────────────

test("state.ts: design_review_contract_completed is missing when contract_reviewed is falsy", () => {
  const bundle = minimalBundle({ contract_reviewed: false });
  const state = deriveAuditState(bundle);
  const obl = state.obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  expect(obl, "obligation should exist").toBeTruthy();
  requireDefined(obl, "contract obligation");
  expect(obl.state).toBe("missing");
});

test("state.ts: design_review_conceptual_completed is satisfied when conceptual_reviewed is true", () => {
  const bundle = minimalBundle({ contract_reviewed: true, conceptual_reviewed: true });
  const state = deriveAuditState(bundle);
  const obl = state.obligations.find(
    (o) => o.id === "design_review_conceptual_completed",
  );
  expect(obl, "obligation should exist").toBeTruthy();
  requireDefined(obl, "conceptual obligation");
  expect(obl.state).toBe("satisfied");
});

test("state.ts: both design_review obligations satisfied when both flags are true", () => {
  const bundle = minimalBundle({ contract_reviewed: true, conceptual_reviewed: true });
  const state = deriveAuditState(bundle);
  const contract = state.obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  const conceptual = state.obligations.find(
    (o) => o.id === "design_review_conceptual_completed",
  );
  expect(contract && contract.state === "satisfied").toBeTruthy();
  expect(conceptual && conceptual.state === "satisfied").toBeTruthy();
});

// The pre-split artifact is INVALIDATED AT LOAD, never translated. It carries
// only the combined `reviewed` flag — ONE pass that answered a different
// question ("was the design assessed?") from the two the tool now runs ("was
// THIS pass reviewed against THIS round?"). Reading it as both would satisfy two
// obligations whose reviews never happened under the current vocabulary, and the
// operator would have no way to tell. So both stay `missing` and the run is
// re-asked for each pass in its current shape.
test("state.ts: a pre-split reviewed:true satisfies NEITHER modern obligation — it is invalidated, not translated", () => {
  const bundle = minimalBundle(preSplitDesignAssessment());
  const state = deriveAuditState(bundle);
  const contract = state.obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  const conceptual = state.obligations.find(
    (o) => o.id === "design_review_conceptual_completed",
  );
  expect(
    contract && contract.state === "missing",
    "a pre-split combined verdict is not a contract-pass verdict",
  ).toBeTruthy();
  expect(
    conceptual && conceptual.state === "missing",
    "a pre-split combined verdict is not a conceptual-pass verdict",
  ).toBeTruthy();
});

// ── renderContractReviewPrompt ────────────────────────────────────────────────

test("renderContractReviewPrompt: contains only contract-assessment categories in output instructions", () => {
  const bundle = minimalBundle();
  const prompt = renderContractReviewPrompt(bundle);
  expect(prompt).toMatch(/inferred_contract_gap/);
  expect(prompt).toMatch(/trust_boundary_gap/);
  // Must NOT contain conceptual-only categories
  expect(prompt).not.toMatch(/tool_opportunity/);
  expect(prompt).not.toMatch(/architecture_pattern/);
  expect(prompt).not.toMatch(/missing_capability/);
});

test("renderConceptualReviewPrompt: contains only conceptual-design categories in output instructions", () => {
  const bundle = minimalBundle();
  const prompt = renderConceptualReviewPrompt(bundle);
  expect(prompt).toMatch(/tool_opportunity/);
  expect(prompt).toMatch(/architecture_pattern/);
  expect(prompt).toMatch(/missing_capability/);
  // Must NOT contain contract-only categories
  expect(prompt).not.toMatch(/inferred_contract_gap/);
  expect(prompt).not.toMatch(/trust_boundary_gap/);
});

// ── renderSharedStructuralContext: both prompts share identical leading block ─

test("renderSharedStructuralContext: contract and conceptual prompts both start with the same structural context prefix", () => {
  const bundle = minimalBundle();
  const maxUnits = 5;
  const sharedCtx = renderSharedStructuralContext(bundle, maxUnits);
  const contractPrompt = renderContractReviewPrompt(bundle, { max_units: maxUnits });
  const conceptualPrompt = renderConceptualReviewPrompt(bundle, { max_units: maxUnits });
  // Both prompts should contain the shared context verbatim
  expect(contractPrompt.includes(sharedCtx), "contract prompt should include the shared structural context").toBeTruthy();
  expect(conceptualPrompt.includes(sharedCtx), "conceptual prompt should include the shared structural context").toBeTruthy();
});

// ── PRIORITY chain ordering ───────────────────────────────────────────────────

test("PRIORITY chain: design_review_contract_completed appears before design_review_conceptual_completed", () => {
  const contractIdx = PRIORITY.indexOf("design_review_contract_completed");
  const conceptualIdx = PRIORITY.indexOf("design_review_conceptual_completed");
  expect(contractIdx >= 0, "design_review_contract_completed should be in PRIORITY").toBeTruthy();
  expect(conceptualIdx >= 0, "design_review_conceptual_completed should be in PRIORITY").toBeTruthy();
  expect(contractIdx < conceptualIdx, `contract (${contractIdx}) should come before conceptual (${conceptualIdx})`).toBeTruthy();
});

test("PRIORITY chain: does not include legacy design_review_completed", () => {
  expect(!PRIORITY.includes("design_review_completed"), "PRIORITY should not contain the legacy design_review_completed obligation").toBeTruthy();
});
