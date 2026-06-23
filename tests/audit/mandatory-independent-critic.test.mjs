// Parity with the remediate contract pipeline: the audit-side adversarial
// design-review prompt MANDATES dispatch to an independent sub-agent reviewer
// when the host can dispatch one, and degrades to an explicit inline self-review
// instruction when it cannot. Fail-safe: mandate when the flag is missing.
import test from "node:test";
import assert from "node:assert/strict";

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
  assert.match(p, /Independent review — MANDATORY/);
  assert.match(p, /MUST dispatch/);
  assert.match(p, /independent sub-agent/);
  assert.doesNotMatch(p, /degraded to inline self-review/);
});

test("NEGATIVE: design review degrades to inline (no hard mandate) when host cannot dispatch", () => {
  const p = renderDesignReviewPrompt(minimalBundle(), { hostCanDispatchSubagents: false });
  assert.match(p, /degraded to inline self-review/);
  assert.doesNotMatch(p, /Independent review — MANDATORY/);
  assert.doesNotMatch(p, /MUST dispatch/);
});

test("FAIL-SAFE: design review defaults to MANDATE when the flag is missing", () => {
  const p = renderDesignReviewPrompt(minimalBundle());
  assert.match(p, /Independent review — MANDATORY/);
  assert.doesNotMatch(p, /degraded to inline self-review/);
});
