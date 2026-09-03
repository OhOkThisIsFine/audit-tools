/**
 * A degraded language analyzer must reach a READER, or the measurement is the
 * same defect one level down.
 *
 * `analyzer_capability.json` recorded honest per-analyzer rows — `resolution:
 * "absent"` with the install error — and had exactly ONE consumer in the tree
 * (`state.ts`, asking only whether the file exists). The record's single
 * summary field was a roll-up over a PARTIAL set (`applied = analyzersUsed.length
 * > 0`), so it said `applied` while two operator-requested analyzers had failed
 * and the weaker regex floor stood in. Nothing else in the repo ever opened the
 * file. This is the class `submission-reporting-reaches-a-reader.test.ts` was
 * written to prevent — "three reporting surfaces and none of them wired".
 *
 * Two readers, each stating the boundary it owns:
 *   1. the report's *Audit Limitations* section names each degraded analyzer
 *      with its own note, for the human reading the deliverable;
 *   2. `renderSharedStructuralContext` — the block EVERY design-review,
 *      contract, conceptual, perspective AND judge prompt renders through —
 *      tells the lane that parser-grade extraction was off, so a lane reasoning
 *      over the graph is not silently reasoning over the regex floor.
 */
import { describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AnalyzerCapabilityRecord } from "../../src/audit/types/analyzerCapability.js";
import type { RenderableAuditReport } from "../../src/audit/reporting/synthesis.js";

const { renderAuditReportMarkdown } = await import(
  "../../src/audit/reporting/synthesis.js"
);
const {
  renderSharedStructuralContext,
  renderConceptualJudgePrompt,
  renderConceptualPerspectivePrompt,
} = await import("../../src/audit/orchestrator/designReviewPrompt.js");
const { analyzerCapabilityCoverage, degradedAnalyzerEntries } = await import(
  "../../src/audit/types/analyzerCapability.js"
);

const DEGRADED: AnalyzerCapabilityRecord = {
  coverage: "degraded",
  analyzers: [
    { id: "typescript", resolution: "repo", setting: "auto", edges_added: 1932, routes_added: 0 },
    {
      id: "html",
      resolution: "absent",
      setting: "ephemeral",
      edges_added: 0,
      routes_added: 0,
      note: "Install of 'web-tree-sitter' failed: installToCache requires an explicit version (name@version).",
    },
    { id: "sql", resolution: "not_applicable", setting: "auto", edges_added: 0, routes_added: 0 },
  ],
};

function bundleWith(record: AnalyzerCapabilityRecord): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-09-03T00:00:00Z",
      files: [{ path: "src/a.ts", language: "ts", size_bytes: 10 }],
    },
    analyzer_capability: record,
  } as ArtifactBundle;
}

const EMPTY_REPORT: RenderableAuditReport = {
  contract_version: "audit-findings/v1alpha1",
  summary: {
    finding_count: 0,
    work_block_count: 0,
    severity_breakdown: {},
    audited_file_count: 0,
    excluded_file_count: 0,
    runtime_validation_status_breakdown: {},
  },
  findings: [],
  coherence_trace: { normalized_items: [], components: [] },
  work_blocks: [],
  work_block_seams: [],
} as unknown as RenderableAuditReport;

describe("the capability record states what ran", () => {
  it("rolls up an ASKED-FOR analyzer that could not run as degraded, not applied", () => {
    // The old roll-up answered "did ANY analyzer contribute edges" and read
    // `applied` on exactly this shape.
    expect(analyzerCapabilityCoverage(DEGRADED.analyzers)).toBe("degraded");
  });

  it("does not let an operator DECLINE outrank a productive run", () => {
    // `skip` is the operator's own choice, so nothing was owed for it — rolling
    // it up over 1932 delivered edges would report `not_run` for a channel that
    // plainly ran, which is the diagnosed defect inverted.
    expect(
      analyzerCapabilityCoverage([
        { id: "typescript", resolution: "repo", setting: "auto", edges_added: 1932, routes_added: 0 },
        { id: "html", resolution: "skip", setting: "skip", edges_added: 0, routes_added: 0 },
      ]),
    ).toBe("findings");
    // A registry where nothing at all was asked for is `not_applicable`.
    expect(
      analyzerCapabilityCoverage([
        { id: "sql", resolution: "not_applicable", setting: "auto", edges_added: 0, routes_added: 0 },
        { id: "html", resolution: "skip", setting: "skip", edges_added: 0, routes_added: 0 },
      ]),
    ).toBe("not_applicable");
    // Ran, contributed nothing: `clean` — asked, and there was nothing there.
    expect(
      analyzerCapabilityCoverage([
        { id: "typescript", resolution: "repo", setting: "auto", edges_added: 0, routes_added: 0 },
      ]),
    ).toBe("clean");
  });

  it("names the degraded entries, so a reader never has to re-derive them", () => {
    expect(degradedAnalyzerEntries(DEGRADED).map((entry) => entry.id)).toEqual([
      "html",
    ]);
  });
});

describe("degradation reaches both readers", () => {
  it("names the degraded analyzer and its note in the report's Audit Limitations", () => {
    const markdown = renderAuditReportMarkdown(EMPTY_REPORT, {
      analyzer_capability: DEGRADED,
    });
    expect(markdown).toContain("## Audit Limitations");
    expect(markdown).toContain("html");
    expect(markdown).toContain("web-tree-sitter");
    // The analyzer that legitimately had nothing to do is NOT a limitation.
    expect(markdown).not.toContain("sql");
  });

  it("renders no limitations section when nothing degraded", () => {
    const markdown = renderAuditReportMarkdown(EMPTY_REPORT, {
      analyzer_capability: {
        coverage: "findings",
        analyzers: [
          { id: "typescript", resolution: "repo", setting: "auto", edges_added: 12, routes_added: 0 },
        ],
      },
    });
    expect(markdown).not.toContain("## Audit Limitations");
  });

  it("tells every graph-reading lane that parser-grade extraction was off", () => {
    const context = renderSharedStructuralContext(bundleWith(DEGRADED), 5);
    expect(context).toContain("html");
    expect(context).toContain("regex");
  });

  it("says nothing about provenance when the graph was not degraded", () => {
    const context = renderSharedStructuralContext(
      bundleWith({
        coverage: "findings",
        analyzers: [
          { id: "typescript", resolution: "repo", setting: "auto", edges_added: 12, routes_added: 0 },
        ],
      }),
      5,
    );
    expect(context).not.toContain("regex floor");
  });

  it("reaches the JUDGE — the one conceptual lane whose submission the tool ingests", () => {
    // `renderConceptualJudgePrompt` took no bundle and never rendered the
    // shared structural context, so the deep pass's INGESTED lane was the one
    // lane the provenance block could not reach.
    const judge = renderConceptualJudgePrompt(
      bundleWith(DEGRADED),
      [{ name: "Adversary", path: "/p1.json", contributor_id: "p1" }],
      "round-token",
    );
    expect(judge).toContain("## Project context");
    expect(judge).toContain("html");
    expect(judge).toContain("regex");
  });

  it("reaches a perspective lane too", () => {
    const perspective = renderConceptualPerspectivePrompt(
      bundleWith(DEGRADED),
      { name: "Adversary", lens: "what breaks" },
      0,
      2,
    );
    expect(perspective).toContain("html");
    expect(perspective).toContain("regex");
  });
});
