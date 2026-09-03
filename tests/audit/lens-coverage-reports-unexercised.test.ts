/**
 * A lens the operator SELECTED either produces findings attributed to it, or the
 * run states that it was never exercised.
 *
 * Measured: nine lenses were selected and two produced findings. The other seven
 * — including two custom lenses the operator added and one canonical lens the
 * host flipped from exclude to include on stated evidence — produced zero, and
 * nothing anywhere said so. `lens_breakdown` is a `countBy` over what was
 * PRODUCED, so a selected lens with zero findings has no key at all, and the
 * render suppressed the whole line on an empty map. A run therefore advertised
 * the operator's chosen scope, delivered a fraction of it, and the report could
 * not distinguish "reviewed, nothing found" from "never reviewed".
 *
 * TWO BOUNDARIES, EACH STATING WHAT IT OWNS.
 *   • PRESENCE is the synthesis boundary's: `buildAuditReportModel` receives the
 *     intent checkpoint and cannot mint a summary without `lens_coverage` when a
 *     selection resolves.
 *   • INTERNAL CONSISTENCY is the validator's. It does NOT receive the
 *     checkpoint, so it must not guess at presence — it checks only what it can
 *     establish from the report itself. That split is the abstention rule: a
 *     gate that cannot ESTABLISH its verdict abstains rather than approximating.
 *
 * AND THE PROMPT HALF IS NOT THE GUARANTEE. A prompt cannot force a model to
 * produce a finding, so P2 is shipped and never validated. But the report half
 * alone would be INERT rather than merely incomplete: a lens is only `clean`
 * when a LENS-OPEN channel was ingested, and with no channel carrying the
 * selection, every selected lens would honestly report `not_run` on every run
 * forever — true, unactionable, identical run to run.
 */
import { describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditResult, Finding } from "../../src/audit/types.js";

const { buildAuditReportModel, renderAuditReportMarkdown } = await import(
  "../../src/audit/reporting/synthesis.js"
);
const {
  renderConceptualPerspectivePrompt,
  renderConceptualJudgePrompt,
  renderContractReviewPrompt,
} = await import("../../src/audit/orchestrator/designReviewPrompt.js");

function finding(id: string, lens: string): Finding {
  return {
    id,
    title: `finding ${id}`,
    severity: "medium",
    confidence: "medium",
    lens,
    category: "architecture_pattern",
    summary: "a finding",
    affected_files: [{ path: "src/a.ts" }],
  } as unknown as Finding;
}

/** A design assessment whose conceptual pass COMPLETED — a lens-open ingest. */
function reviewedAssessment(findings: readonly Finding[]) {
  return {
    generated_at: "2026-09-03T00:00:00Z",
    findings: [...findings],
    conceptual_reviewed: true,
  };
}

const CHECKPOINT = {
  schema_version: "intent-checkpoint/v1",
  confirmed_at: "2026-09-03T00:00:00Z",
  confirmed_by: "host",
  scope_summary: "scope",
  intent_summary: "full-audit",
  lens_selection: {
    include: ["architecture", "performance", "provenance_labelling"],
    exclude: [],
  },
} as unknown as NonNullable<ArtifactBundle["intent_checkpoint"]>;

function modelWithSelection() {
  return buildAuditReportModel({
    results: [] as AuditResult[],
    designAssessment: reviewedAssessment([finding("DR-001", "architecture")]),
    intentCheckpoint: CHECKPOINT,
  });
}

describe("lens coverage states what a selected lens delivered", () => {
  it("carries an entry for EVERY selected lens, exercised or not", () => {
    const coverage = modelWithSelection().summary.lens_coverage;
    expect(coverage, "a run that carried a selection states its coverage").toBeDefined();
    const byLens = new Map(coverage!.map((entry) => [entry.lens, entry]));

    expect(byLens.get("architecture")).toEqual({
      lens: "architecture",
      selected: true,
      findings_count: 1,
      outcome: "findings",
    });
    // Asked through a lens-open channel that was ingested, and it found nothing.
    // "Reviewed, nothing found" — NOT the same statement as "never reviewed".
    expect(byLens.get("performance")).toEqual({
      lens: "performance",
      selected: true,
      findings_count: 0,
      outcome: "clean",
    });
    // A custom (non-canonical) lens the operator invented is reported exactly
    // like a canonical one — `resolveEffectiveLenses` appends it verbatim, so
    // dropping it here would silently void half the operator's own choice.
    expect(byLens.get("provenance_labelling")?.outcome).toBe("clean");
    // The mandatory base lenses are re-unioned by the resolver, so they are
    // part of the selection and must be stated too.
    expect(byLens.has("security")).toBe(true);
  });

  it("reports every selected lens not_run when NO lens-open channel was ingested", () => {
    // No audit results and no completed design-review pass: nothing in this run
    // was ever asked through the operator's lenses, so `clean` would be a lie.
    const model = buildAuditReportModel({
      results: [] as AuditResult[],
      intentCheckpoint: CHECKPOINT,
    });
    expect(
      model.summary.lens_coverage?.every((entry) => entry.outcome === "not_run"),
    ).toBe(true);
  });

  it("abstains entirely when the operator expressed no lens limit", () => {
    const model = buildAuditReportModel({
      results: [] as AuditResult[],
      designAssessment: reviewedAssessment([finding("DR-001", "architecture")]),
    });
    expect(
      model.summary.lens_coverage,
      "no selection resolved, so there is no coverage claim to make",
    ).toBeUndefined();
  });

  it("names the un-exercised lenses in the rendered report", () => {
    const markdown = renderAuditReportMarkdown(modelWithSelection());
    expect(markdown).toContain("Lenses not exercised");
    expect(markdown).toContain("performance");
    expect(markdown).toContain("provenance_labelling");
  });
});

describe("the selection reaches the lens-open prompts", () => {
  const lenses = ["performance", "tests"];

  it("states the operator's lenses in a perspective prompt", () => {
    const prompt = renderConceptualPerspectivePrompt(
      {} as ArtifactBundle,
      { name: "Adversary", lens: "what breaks" },
      0,
      2,
      { lenses },
    );
    expect(prompt).toContain("performance");
    expect(prompt).toContain("tests");
  });

  it("states them in the contract-review prompt and in the JUDGE's", () => {
    expect(
      renderContractReviewPrompt({} as ArtifactBundle, { lenses }),
    ).toContain("performance");
    // The judge PRODUCES the ingested conceptual submission and is told to add
    // what the perspectives missed, so a judge that never learns the selection
    // is the one lane whose omission the report cannot route around.
    expect(
      renderConceptualJudgePrompt(
        {} as ArtifactBundle,
        [{ name: "P", path: "/p.json", contributor_id: "p1" }],
        "round",
        { lenses },
      ),
    ).toContain("performance");
  });

  it("stops hard-coding `architecture` in the output example", () => {
    // The one lens literal a lane actually saw was the example's, and the
    // delivered distribution was exactly the set of literals in the producers.
    const prompt = renderConceptualPerspectivePrompt(
      {} as ArtifactBundle,
      { name: "Adversary", lens: "what breaks" },
      0,
      2,
      { lenses },
    );
    expect(prompt).not.toContain('"lens": "architecture"');
  });
});
