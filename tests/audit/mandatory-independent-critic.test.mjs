// Parity with the remediate contract pipeline: the audit-side adversarial
// design-review prompt MANDATES dispatch to an independent sub-agent reviewer
// when the host can dispatch one, and degrades to an explicit inline self-review
// instruction when it cannot. Fail-safe: mandate when the flag is missing.
import { test, expect } from "vitest";

const { renderDesignReviewPrompt } = await import(
  "../../src/audit/orchestrator/designReviewPrompt.ts"
);

function minimalBundle() {
  return {
    repo_manifest: { repository: { name: "r" }, files: [{ path: "src/a.ts", language: "typescript" }] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "now", findings: [] },
  };
}

test("POSITIVE: design review MANDATES an independent sub-agent when host can dispatch", () => {
  const p = renderDesignReviewPrompt(minimalBundle(), { hostCanDispatchSubagents: true });
  expect(p).toMatch(/Independent review — MANDATORY/);
  expect(p).toMatch(/MUST dispatch/);
  expect(p).toMatch(/independent sub-agent/);
  expect(p).not.toMatch(/degraded to inline self-review/);
});

test("NEGATIVE: design review degrades to inline (no hard mandate) when host cannot dispatch", () => {
  const p = renderDesignReviewPrompt(minimalBundle(), { hostCanDispatchSubagents: false });
  expect(p).toMatch(/degraded to inline self-review/);
  expect(p).not.toMatch(/Independent review — MANDATORY/);
  expect(p).not.toMatch(/MUST dispatch/);
});

test("FAIL-SAFE: design review defaults to MANDATE when the flag is missing", () => {
  const p = renderDesignReviewPrompt(minimalBundle());
  expect(p).toMatch(/Independent review — MANDATORY/);
  expect(p).not.toMatch(/degraded to inline self-review/);
});
