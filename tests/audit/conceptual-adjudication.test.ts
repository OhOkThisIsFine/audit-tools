import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Finding } from "../../src/audit/types.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";

const {
  ConceptualJudgeSubmissionSchema,
  buildConceptualReviewAdjudication,
  loadConceptualPerspectiveFindings,
  readConceptualReviewRoundManifest,
} = await import("../../src/audit/types/conceptualAdjudication.js");
const { prepareConceptualDispatch } = await import(
  "../../src/audit/cli/conceptualDispatch.js"
);
const { handleDesignReviewBranch } = await import(
  "../../src/audit/cli/nextStepHelpers.js"
);
const { commitFold, createFoldTransaction } = await import(
  "../../src/audit/cli/foldTransaction.js"
);
const { readJsonFile } = await import("../../src/shared/io/json.js");
const { renderAuditReportMarkdown } = await import(
  "../../src/audit/reporting/synthesis.js"
);

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

function finding(id: string, title = id): Finding {
  return {
    id,
    title,
    category: "design_simplification",
    severity: "medium",
    confidence: "high",
    lens: "architecture",
    summary: `${title} summary`,
    affected_files: [{ path: "src/a.ts" }],
  };
}

const manifest = {
  schema_version: 1 as const,
  mode: "deep" as const,
  round_id: "round-current",
  perspectives: [
    {
      contributor_id: "design_review_conceptual_p1_round-current",
      perspective: "Mathematician",
      lane_id: "design_review_conceptual_p1_round-current",
      prompt_path: "C:/tmp/p1-prompt.md",
      result_path: "C:/tmp/p1-result.json",
    },
    {
      contributor_id: "design_review_conceptual_p2_round-current",
      perspective: "Minimalist",
      lane_id: "design_review_conceptual_p2_round-current",
      prompt_path: "C:/tmp/p2-prompt.md",
      result_path: "C:/tmp/p2-result.json",
    },
  ],
  judge: {
    contributor_id: "design_review_conceptual",
    lane_id: "design_review_conceptual",
    prompt_path: "C:/tmp/judge-prompt.md",
    result_path: "C:/tmp/judge-result.json",
  },
};

const perspectiveFindings = new Map([
  [manifest.perspectives[0]!.contributor_id, [finding("DR-001", "Remove state machine")]],
  [manifest.perspectives[1]!.contributor_id, [finding("DR-002", "Collapse adapter")]],
]);

function validSubmission() {
  return {
    round_id: "round-current",
    findings: [finding("FINAL-001", "One simpler core")],
    candidate_dispositions: [
      {
        candidate_id: `${manifest.perspectives[0]!.contributor_id}::DR-001`,
        contributor_id: manifest.perspectives[0]!.contributor_id,
        source_finding_id: "DR-001",
        disposition: "retained" as const,
        target_final_finding_ids: ["FINAL-001"],
        modification_percent: 20,
        rationale: "Core mechanism retained with narrower scope.",
      },
      {
        candidate_id: `${manifest.perspectives[1]!.contributor_id}::DR-002`,
        contributor_id: manifest.perspectives[1]!.contributor_id,
        source_finding_id: "DR-002",
        disposition: "merged" as const,
        target_final_finding_ids: ["FINAL-001"],
        modification_percent: 60,
        rationale: "Merged as supporting evidence for the same reduction.",
      },
    ],
    final_finding_shares: [
      {
        final_finding_id: "FINAL-001",
        contributors: [
          {
            contributor_id: manifest.perspectives[0]!.contributor_id,
            source_candidate_ids: [
              `${manifest.perspectives[0]!.contributor_id}::DR-001`,
            ],
            contribution_percent: 55,
            rationale: "Supplied the primary reduction.",
          },
          {
            contributor_id: manifest.perspectives[1]!.contributor_id,
            source_candidate_ids: [
              `${manifest.perspectives[1]!.contributor_id}::DR-002`,
            ],
            contribution_percent: 30,
            rationale: "Supplied corroborating simplification evidence.",
          },
          {
            contributor_id: manifest.judge.contributor_id,
            source_candidate_ids: [],
            contribution_percent: 15,
            rationale: "Judge reconciled and synthesized the final framing.",
          },
        ],
      },
    ],
  };
}

describe("conceptual review adjudication", () => {
  it("preserves contributor identity, disposition, shares, modification, and rationale", () => {
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission: validSubmission(),
      generatedAt: "2026-08-31T00:00:00.000Z",
    });

    expect(adjudication.round_id).toBe("round-current");
    expect(adjudication.contributors).toHaveLength(3);
    expect(adjudication.candidate_dispositions).toHaveLength(2);
    expect(adjudication.candidate_dispositions[1]?.modification_percent).toBe(60);
    expect(
      adjudication.final_finding_shares[0]?.contributors.reduce(
        (sum, contributor) => sum + contributor.contribution_percent,
        0,
      ),
    ).toBe(100);
  });

  it("requires exactly one disposition for every current-round candidate", () => {
    const missing = validSubmission();
    missing.candidate_dispositions.pop();
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: missing,
        generatedAt: "now",
      }),
    ).toThrow(/missing candidate disposition.*DR-002/i);

    const duplicate = validSubmission();
    duplicate.candidate_dispositions.push({
      ...duplicate.candidate_dispositions[0]!,
    });
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: duplicate,
        generatedAt: "now",
      }),
    ).toThrow(/duplicate candidate disposition/i);
  });

  it("rejects unknown contributors and invalid final-id mappings", () => {
    const unknown = validSubmission();
    unknown.final_finding_shares[0]!.contributors[0]!.contributor_id = "unknown";
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: unknown,
        generatedAt: "now",
      }),
    ).toThrow(/unknown contributor/i);

    const unknownFinal = validSubmission();
    unknownFinal.candidate_dispositions[0]!.target_final_finding_ids = ["FINAL-404"];
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: unknownFinal,
        generatedAt: "now",
      }),
    ).toThrow(/unknown final finding/i);
  });

  it("validates percentage bounds, 100% totals, and an explicit judge share", () => {
    const outOfBounds = validSubmission();
    outOfBounds.candidate_dispositions[0]!.modification_percent = 101;
    expect(ConceptualJudgeSubmissionSchema.safeParse(outOfBounds).success).toBe(false);

    const wrongTotal = validSubmission();
    wrongTotal.final_finding_shares[0]!.contributors[0]!.contribution_percent = 54;
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: wrongTotal,
        generatedAt: "now",
      }),
    ).toThrow(/total 100/i);

    const noJudge = validSubmission();
    noJudge.final_finding_shares[0]!.contributors.pop();
    noJudge.final_finding_shares[0]!.contributors[0]!.contribution_percent = 70;
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: noJudge,
        generatedAt: "now",
      }),
    ).toThrow(/judge share/i);
  });

  it("requires every retained or merged target edge to be cited exactly once", () => {
    const missing = validSubmission();
    missing.final_finding_shares[0]!.contributors.splice(1, 1);
    missing.final_finding_shares[0]!.contributors[0]!.contribution_percent = 85;
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: missing,
        generatedAt: "now",
      }),
    ).toThrow(/not cited/i);

    const duplicate = validSubmission();
    duplicate.final_finding_shares[0]!.contributors[0]!.source_candidate_ids.push(
      duplicate.final_finding_shares[0]!.contributors[0]!.source_candidate_ids[0]!,
    );
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: duplicate,
        generatedAt: "now",
      }),
    ).toThrow(/cited more than once/i);
  });

  it("loads only perspective files named by the current round manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "conceptual-adjudication-"));
    cleanups.push(root);
    const currentPath = join(root, "current.json");
    const stalePath = join(root, "stale.json");
    await mkdir(dirname(currentPath), { recursive: true });
    await writeFile(currentPath, JSON.stringify({ findings: [finding("CURRENT")] }), "utf8");
    await writeFile(stalePath, JSON.stringify({ findings: [finding("STALE")] }), "utf8");

    const currentManifest = {
      ...manifest,
      perspectives: [
        {
          ...manifest.perspectives[0]!,
          result_path: currentPath,
        },
      ],
    };
    const loaded = await loadConceptualPerspectiveFindings(currentManifest);
    expect([...loaded.values()].flat().map((entry) => entry.id)).toEqual(["CURRENT"]);
    expect([...loaded.values()].flat().map((entry) => entry.id)).not.toContain("STALE");
  });

  it("persists final findings and their adjudication in the same fold commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "conceptual-adjudication-fold-"));
    cleanups.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });

    const bundle: ArtifactBundle = {
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: false,
      },
    };
    await prepareConceptualDispatch({
      artifactsDir,
      bundle,
      settings: { conceptual_depth: "deep", perspectives: 2 },
    });
    const current = await readConceptualReviewRoundManifest(artifactsDir);
    if (!current) throw new Error("missing conceptual round manifest");
    await Promise.all(
      current.perspectives.map((contributor, index) =>
        writeFile(
          contributor.result_path,
          JSON.stringify({ findings: [finding(`DR-00${index + 1}`)] }),
          "utf8",
        ),
      ),
    );

    const submission = {
      round_id: current.round_id,
      findings: [finding("FINAL-001")],
      candidate_dispositions: current.perspectives.map((contributor, index) => ({
        candidate_id: `${contributor.contributor_id}::DR-00${index + 1}`,
        contributor_id: contributor.contributor_id,
        source_finding_id: `DR-00${index + 1}`,
        disposition: index === 0 ? ("retained" as const) : ("merged" as const),
        target_final_finding_ids: ["FINAL-001"],
        modification_percent: index === 0 ? 10 : 50,
        rationale: `candidate ${index + 1} disposition`,
      })),
      final_finding_shares: [
        {
          final_finding_id: "FINAL-001",
          contributors: [
            ...current.perspectives.map((contributor, index) => ({
              contributor_id: contributor.contributor_id,
              source_candidate_ids: [
                `${contributor.contributor_id}::DR-00${index + 1}`,
              ],
              contribution_percent: index === 0 ? 55 : 30,
              rationale: `perspective ${index + 1} share`,
            })),
            {
              contributor_id: current.judge.contributor_id,
              source_candidate_ids: [],
              contribution_percent: 15,
              rationale: "judge synthesis share",
            },
          ],
        },
      ],
    };
    await writeFile(current.judge.result_path, JSON.stringify(submission), "utf8");

    const tx = createFoldTransaction();
    const state: AuditState = { status: "active", obligations: [] };
    const branch = await handleDesignReviewBranch(
      { artifactsDir },
      bundle,
      state,
      tx,
    );
    expect(branch.action).toBe("continue");
    if (branch.action !== "continue") throw new Error("expected continue");
    expect(branch.bundle.design_assessment?.conceptual_findings?.[0]?.id).toBe(
      "FINAL-001",
    );
    expect(branch.bundle.conceptual_review_adjudication?.round_id).toBe(
      current.round_id,
    );

    await commitFold(artifactsDir, branch.bundle, tx);
    const writtenAssessment = await readJsonFile<{
      conceptual_findings: Finding[];
    }>(join(artifactsDir, "design_assessment.json"));
    const writtenAdjudication = await readJsonFile<{
      round_id: string;
      final_finding_shares: unknown[];
    }>(join(artifactsDir, "conceptual_review_adjudication.json"));
    expect(writtenAssessment.conceptual_findings[0]?.id).toBe("FINAL-001");
    expect(writtenAdjudication.round_id).toBe(current.round_id);
    expect(writtenAdjudication.final_finding_shares).toHaveLength(1);
  });

  it("clears stale deep attribution when a shallow conceptual result supersedes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "conceptual-adjudication-shallow-"));
    cleanups.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const priorAdjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission: validSubmission(),
      generatedAt: "prior",
    });
    const bundle: ArtifactBundle = {
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: false,
      },
      conceptual_review_adjudication: priorAdjudication,
    };
    await writeFile(
      join(artifactsDir, "conceptual_review_adjudication.json"),
      JSON.stringify(priorAdjudication),
      "utf8",
    );
    const dispatch = await prepareConceptualDispatch({
      artifactsDir,
      bundle,
      settings: { conceptual_depth: "shallow", perspectives: 1 },
    });
    await writeFile(
      dispatch.conceptualResultsPath,
      JSON.stringify({ findings: [finding("SHALLOW-001")] }),
      "utf8",
    );

    const tx = createFoldTransaction();
    const branch = await handleDesignReviewBranch(
      { artifactsDir },
      bundle,
      { phase: "analysis", stale_artifacts: [] },
      tx,
    );
    expect(branch.action).toBe("continue");
    if (branch.action !== "continue") throw new Error("expected continue");
    expect(branch.bundle.conceptual_review_adjudication).toBeUndefined();

    await commitFold(artifactsDir, branch.bundle, tx);
    await expect(
      readJsonFile(join(artifactsDir, "conceptual_review_adjudication.json")),
    ).rejects.toThrow();
  });

  it("renders contribution and modification detail in the human report", () => {
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission: validSubmission(),
      generatedAt: "now",
    });
    const markdown = renderAuditReportMarkdown(
      {
        summary: {
          finding_count: 0,
          work_block_count: 0,
          severity_breakdown: {},
          audited_file_count: 0,
          excluded_file_count: 0,
          runtime_validation_status_breakdown: {},
        },
        findings: [],
        work_blocks: [],
        work_block_seams: [],
      },
      { conceptual_adjudication: adjudication },
    );
    expect(markdown).toContain("## Conceptual Review Attribution");
    expect(markdown).toContain("Mathematician");
    expect(markdown).toContain("55%");
    expect(markdown).toContain("modified 60%");
    expect(markdown).toContain("Judge (design_review_conceptual)");
  });
});
