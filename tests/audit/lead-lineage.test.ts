/**
 * Deterministic graph heuristics are LEADS with lineage, not approved findings
 * (backlog 2026-08-03): "deterministic graph output is a generation/provenance-
 * bound lead, not an approved finding, until semantic confirmation; report
 * promotion must preserve producer, source hash, and evidence lineage."
 *
 * Each deterministic producer (`detectSeams` / `detectHiddenCoupling` in
 * `designAssessment`, `detectNonColocalization` in `decompose/findings`) must
 * stamp its output, the stamp must be content-derived, and the stamp must
 * survive the promotion path into the design-review projection.
 */
import { test, expect } from "vitest";
import { buildDesignAssessment } from "../../src/audit/extractors/designAssessment.js";
import { detectNonColocalization } from "../../src/audit/decompose/findings.js";
import { projectDesignReviewInput } from "../../src/audit/orchestrator/designReviewProjection.js";
import type { DesignReviewBundle } from "../../src/audit/orchestrator/designReviewProjection.js";
import { groundDesignFindings } from "../../src/shared/validation/designFindingGrounding.js";
import type { GraphBundle } from "audit-tools/shared";

/** A two-node graph whose only link is a bridge (a cut-edge) → one seam lead. */
function seamGraph(): GraphBundle {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    graphs: {
      imports: [
        { from: "a.ts", to: "b.ts", kind: "imports" },
        { from: "b.ts", to: "c.ts", kind: "imports" },
      ],
    },
  } as unknown as GraphBundle;
}

function assessment(graph: GraphBundle) {
  return buildDesignAssessment({
    unitManifest: { units: [] },
    graphBundle: graph,
    criticalFlows: { flows: [] },
    riskRegister: { items: [] },
  } as never);
}

test("detectSeams stamps every seam lead with a producer and a content-derived source hash", () => {
  const seams = assessment(seamGraph()).findings.filter(
    (finding) => finding.category === "architectural_seam",
  );
  expect(seams.length, "the fixture graph must yield at least one seam lead").toBeGreaterThan(0);
  for (const finding of seams) {
    expect(finding.lead_lineage, "a seam without lineage is an unconfirmed verdict").toBeDefined();
    expect(finding.lead_lineage!.producer).toBe("detectSeams");
    expect(finding.lead_lineage!.confirmation).toBe("lead");
    expect(finding.lead_lineage!.source_hash.length).toBeGreaterThan(0);
  }
  // Same input generation → same hash; this is what makes the lead re-checkable.
  const again = assessment(seamGraph()).findings.filter(
    (finding) => finding.category === "architectural_seam",
  );
  expect(again[0].lead_lineage!.source_hash).toBe(seams[0].lead_lineage!.source_hash);
});

test("a different signal generation yields a different source hash", () => {
  const three = assessment({
    generated_at: "2026-01-01T00:00:00.000Z",
    graphs: {
      imports: [
        { from: "a.ts", to: "b.ts", kind: "imports" },
        { from: "b.ts", to: "c.ts", kind: "imports" },
      ],
    },
  } as unknown as GraphBundle).findings.filter((f) => f.category === "architectural_seam");
  const chain = assessment({
    generated_at: "2026-01-01T00:00:00.000Z",
    graphs: {
      imports: [
        { from: "a.ts", to: "b.ts", kind: "imports" },
        { from: "b.ts", to: "c.ts", kind: "imports" },
        { from: "c.ts", to: "d.ts", kind: "imports" },
        { from: "d.ts", to: "e.ts", kind: "imports" },
      ],
    },
  } as unknown as GraphBundle).findings.filter((f) => f.category === "architectural_seam");

  expect(three.length > 0 && chain.length > 0, "both generations must yield seams").toBe(true);
  expect(
    three[0].lead_lineage!.source_hash === chain[0].lead_lineage!.source_hash,
    "a moved signal generation must move the source hash",
  ).toBe(false);
});

test("detectNonColocalization names which of its two detectors produced each lead", () => {
  // 4 tightly-coupled files declared nowhere → the behavioral lead. A doc group
  // of 2 that is not one coupling cluster → the purpose lead.
  // A `Partition` is a node→community Map; one shared community across the four
  // files is what makes them a single behavior cluster.
  const behavioralPartition = new Map<string, string>([
    ["a.ts", "k1"],
    ["b.ts", "k1"],
    ["c.ts", "k1"],
    ["d.ts", "k1"],
  ]);
  const findings = detectNonColocalization({
    behaviorPartitions: [behavioralPartition],
    intentBoundaries: [],
    purposeGroups: [["x.ts", "y.ts"]],
  });

  const behavioral = findings.filter((f) => f.category === "non_colocalization_behavioral");
  const purpose = findings.filter((f) => f.category === "non_colocalization_purpose");
  expect(behavioral.length, "fixture must yield a behavioral lead").toBeGreaterThan(0);
  expect(purpose.length, "fixture must yield a purpose lead").toBeGreaterThan(0);
  expect(behavioral[0].lead_lineage!.producer).toBe("detectNonColocalization:behavioral");
  expect(purpose[0].lead_lineage!.producer).toBe("detectNonColocalization:purpose");
  for (const finding of findings) {
    expect(finding.lead_lineage!.confirmation).toBe("lead");
  }
});

// ── The lineage is not the host's to write ───────────────────────────────────
//
// `lead_lineage` is what makes a row a LEAD rather than a verdict — the whole
// point of the stamp is that a READER can tell a deterministic heuristic's
// generation-bound output from a claim someone made. A field the submitting
// host can set is a field that decides its own trust class: a submission
// carrying `{producer: "detectSeams", …}` would read as the tool's own
// heuristic output, and a re-emitted real lead stripped of its lineage would
// read as a first-hand finding. Both are the same defect from opposite sides,
// and the design-review lanes are the door — they ingest host-authored arrays
// through `consumeArraySubmission`, which checks the value is an array and
// nothing else, so the strip has to happen where the tool takes ownership of
// those findings (`groundDesignFindings`, at every design ingest site).

test("a design-review submission's forged lead_lineage never lands on a finding", () => {
  const forged = {
    ...assessment(seamGraph()).findings[0]!,
    lead_lineage: {
      producer: "host-forged",
      source_hash: "not-a-real-generation",
      confirmation: "lead" as const,
    },
  };
  expect(forged.lead_lineage.producer, "precondition: the submission carries one").toBe(
    "host-forged",
  );

  const grounded = groundDesignFindings([forged], { files: [] });
  expect(grounded.length).toBe(1);
  expect(
    grounded[0]!.lead_lineage,
    "the ingest must not carry a host-supplied lineage into the design assessment",
  ).toBeUndefined();
  // The row is otherwise intact and still lane-stamped — the strip removes the
  // forgery, not the record of which lane the finding arrived on.
  expect(grounded[0]!.id).toBe(forged.id);
  expect(grounded[0]!.evidence_lane).toBe("design-review-lane");
});

test("the design-review projection carries lead lineage into the reviewed slice", () => {
  const graph = seamGraph();
  const bundle = {
    design_assessment: assessment(graph),
  } as unknown as DesignReviewBundle;

  const projected = projectDesignReviewInput(
    "design_assessment",
    bundle,
  ) as Array<Record<string, unknown>>;

  const withLineage = projected.filter((row) => row.lead_lineage != null);
  expect(
    withLineage.length,
    "at least one projected finding must carry its lineage — dropping it here hands the reviewer an unmarked verdict",
  ).toBeGreaterThan(0);
  const lineage = withLineage[0].lead_lineage as Record<string, unknown>;
  expect(lineage.producer).toBeDefined();
  expect(lineage.source_hash).toBeDefined();
  expect(lineage.confirmation).toBe("lead");
});
