/**
 * docs-7 — the design review's file access is TWO rules, named apart.
 *
 * `spec/audit-workflow-design.md` described a graph-constrained soft READ grant
 * while the shipped prompt told the reviewer to roam freely; neither stated the
 * finding-target scope that the `[in scope]` / `[excluded: <reason>]`
 * annotations already imply. The owner's ruling (2026-08-25) was to keep both
 * and name them separately:
 *
 *   - an ORIENTATION grant, governing what may be READ — unbounded;
 *   - a FINDING-TARGET scope, governing what may be REPORTED — in-scope only.
 *
 * Prose in a spec cannot enforce that, so both rules are pinned here against
 * the rendered prompt. A prompt that keeps the roam grant but drops the
 * reporting bound reads as a licence to file findings about excluded files,
 * which is exactly the drift this pair exists to catch.
 */
import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const {
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  selectPerspectives,
} = await import("../../src/audit/orchestrator/designReviewPrompt.js");

function bundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [] },
  };
}

/** Both conceptual prompts share `conceptualCritiqueInstructions`. */
function renderedPrompts(): Array<{ name: string; text: string }> {
  const perspective = selectPerspectives(1)[0];
  expect(perspective, "selectPerspectives(1) must yield a perspective").toBeDefined();
  return [
    { name: "conceptual review", text: renderConceptualReviewPrompt(bundle(), { max_units: 5 }) },
    {
      name: "conceptual perspective",
      text: renderConceptualPerspectivePrompt(bundle(), perspective!, 0, 1),
    },
  ];
}

test("every conceptual prompt grants unbounded READING", () => {
  for (const { name, text } of renderedPrompts()) {
    expect(text, `${name}: the orientation grant must survive`).toContain(
      "roam the actual code freely",
    );
    expect(
      text,
      `${name}: roaming must not be re-narrowed to the highest-risk units`,
    ).toContain("Do NOT confine yourself to the highest-risk units");
  }
});

test("every conceptual prompt bounds REPORTING to in-scope units", () => {
  for (const { name, text } of renderedPrompts()) {
    expect(
      text,
      `${name}: the reading grant must be stated as NOT a reporting grant`,
    ).toContain("Roaming is a reading grant, not a reporting grant");
    expect(text, `${name}: findings must be bounded to in-scope units`).toContain(
      "produce findings only about units marked `[in scope]`",
    );
    expect(
      text,
      `${name}: an excluded unit must be admissible as evidence but never as a target`,
    ).toContain("must never itself be the target of a finding");
  }
});
