// Parity with the remediate contract pipeline: the audit-side adversarial
// design-review prompt carries the LANE-CLASS-conditional independence mandate
// (design resolution 2, gate-resolved 2026-08-05) — one capability-neutral text
// with the independent-subagent requirement AND the explicitly-degraded
// no-subagent fallback, rendered identically on every host. The old
// capability-conditional branch (mandate vs degraded text keyed on
// hostCanDispatchSubagents) is deleted; author self-review is never licensed at
// full strength on any host.
import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { renderDesignReviewPrompt } = await import(
  "../../src/audit/orchestrator/designReviewPrompt.js"
);

function minimalBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "r" },
      generated_at: "now",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 0 }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "now", findings: [] },
  };
}

test("design review carries the capability-neutral independence MANDATE", () => {
  const p = renderDesignReviewPrompt(minimalBundle());
  expect(p).toMatch(/Independent Review — MANDATORY/);
  expect(p).toMatch(/MUST be executed by an agent that did not author/);
  expect(p).toMatch(/independent sub-agent/);
});

test("the same text carries the explicitly-degraded no-subagent fallback (never a separate render)", () => {
  const p = renderDesignReviewPrompt(minimalBundle());
  expect(p).toMatch(/no sub-agent facility exists/);
  expect(p).toMatch(/explicitly-degraded fallback/);
  // The retired capability-branch wording must not resurface as a second form.
  expect(p).not.toMatch(/degraded to inline self-review/);
  expect(p).not.toMatch(/This host reported it cannot dispatch/);
});
