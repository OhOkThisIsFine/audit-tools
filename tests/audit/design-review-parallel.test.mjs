/**
 * Tests for the parallel design-review split (N-A05):
 *   - deriveAuditState obligation derivation
 *   - renderContractReviewPrompt / renderConceptualReviewPrompt
 *   - renderSharedStructuralContext shared prefix
 *   - runDesignReviewAutoComplete per-pass behavior
 *   - PRIORITY chain ordering
 */
import { test, expect } from "vitest";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const {
  renderContractReviewPrompt,
  renderConceptualReviewPrompt,
  renderSharedStructuralContext,
} = await import("../../src/audit/orchestrator/designReviewPrompt.ts");
const { runDesignReviewAutoComplete } = await import("../../src/audit/orchestrator/structureExecutors.ts");
const { PRIORITY } = await import("../../src/audit/orchestrator/nextStep.ts");

// ── Minimal bundle factory ────────────────────────────────────────────────────

function minimalBundle(designAssessmentOverrides = {}) {
  return {
    provider_confirmation: { confirmed: true },
    repo_manifest: {
      repository: { name: "test-repo" },
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    file_disposition: { files: [] },
    auto_fixes_applied: { executed_tools: [] },
    syntax_resolution_status: { completed_at: "2026-01-01T00:00:00Z" },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: {},
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "full",
      intent_summary: "full-audit",
    },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      ...designAssessmentOverrides,
    },
  };
}

// ── state.ts: design_review_contract_completed ────────────────────────────────

test("state.ts: design_review_contract_completed is missing when contract_reviewed is falsy", () => {
  const bundle = minimalBundle({ contract_reviewed: false });
  const state = deriveAuditState(bundle);
  const obl = state.obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  expect(obl, "obligation should exist").toBeTruthy();
  expect(obl.state).toBe("missing");
});

test("state.ts: design_review_conceptual_completed is satisfied when conceptual_reviewed is true", () => {
  const bundle = minimalBundle({ contract_reviewed: true, conceptual_reviewed: true });
  const state = deriveAuditState(bundle);
  const obl = state.obligations.find(
    (o) => o.id === "design_review_conceptual_completed",
  );
  expect(obl, "obligation should exist").toBeTruthy();
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

test("state.ts: backward-compat — legacy reviewed:true satisfies both obligations", () => {
  const bundle = minimalBundle({ reviewed: true });
  const state = deriveAuditState(bundle);
  const contract = state.obligations.find(
    (o) => o.id === "design_review_contract_completed",
  );
  const conceptual = state.obligations.find(
    (o) => o.id === "design_review_conceptual_completed",
  );
  expect(contract && contract.state === "satisfied", "contract should be satisfied via legacy").toBeTruthy();
  expect(conceptual && conceptual.state === "satisfied", "conceptual should be satisfied via legacy").toBeTruthy();
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

// ── runDesignReviewAutoComplete per-pass ──────────────────────────────────────

test("runDesignReviewAutoComplete (contract pass): sets contract_reviewed=true, conceptual stays false", () => {
  const bundle = minimalBundle({ contract_reviewed: false, conceptual_reviewed: false });
  const result = runDesignReviewAutoComplete(bundle, "contract");
  const da = result.updated.design_assessment;
  expect(da.contract_reviewed).toBe(true);
  expect(!da.conceptual_reviewed, "conceptual_reviewed should not be set").toBeTruthy();
  expect(Array.isArray(da.contract_findings)).toBeTruthy();
});

test("runDesignReviewAutoComplete (conceptual pass): sets conceptual_reviewed=true, contract stays false", () => {
  const bundle = minimalBundle({ contract_reviewed: false, conceptual_reviewed: false });
  const result = runDesignReviewAutoComplete(bundle, "conceptual");
  const da = result.updated.design_assessment;
  expect(da.conceptual_reviewed).toBe(true);
  expect(!da.contract_reviewed, "contract_reviewed should not be set").toBeTruthy();
  expect(Array.isArray(da.conceptual_findings)).toBeTruthy();
});

test("runDesignReviewAutoComplete (both): sets contract_reviewed and conceptual_reviewed to true with empty findings arrays", () => {
  const bundle = minimalBundle();
  const result = runDesignReviewAutoComplete(bundle, "both");
  const da = result.updated.design_assessment;
  expect(da.contract_reviewed).toBe(true);
  expect(da.conceptual_reviewed).toBe(true);
  expect(Array.isArray(da.contract_findings)).toBeTruthy();
  expect(Array.isArray(da.conceptual_findings)).toBeTruthy();
});

test("runDesignReviewAutoComplete (default = both): sets both flags", () => {
  const bundle = minimalBundle();
  const result = runDesignReviewAutoComplete(bundle);
  const da = result.updated.design_assessment;
  expect(da.contract_reviewed).toBe(true);
  expect(da.conceptual_reviewed).toBe(true);
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
