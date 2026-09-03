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
const { canonicalizeConceptualAttributionIds, renderAuditReportMarkdown } = await import(
  "../../src/audit/reporting/synthesis.js"
);
const { runSynthesisExecutor, runSynthesisNarrativeExecutor } = await import(
  "../../src/audit/orchestrator/synthesisExecutors.js"
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
        verification_status: "asserted" as const,
      },
      {
        candidate_id: `${manifest.perspectives[1]!.contributor_id}::DR-002`,
        contributor_id: manifest.perspectives[1]!.contributor_id,
        source_finding_id: "DR-002",
        disposition: "merged" as const,
        target_final_finding_ids: ["FINAL-001"],
        modification_percent: 60,
        rationale: "Merged as supporting evidence for the same reduction.",
        verification_status: "asserted" as const,
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

function collidingFinalSubmission() {
  return {
    round_id: "round-current",
    findings: [
      finding("FINAL-001", "One shared canonical core"),
      finding("FINAL-002", "One shared canonical core"),
    ],
    candidate_dispositions: [
      {
        candidate_id: `${manifest.perspectives[0]!.contributor_id}::DR-001`,
        contributor_id: manifest.perspectives[0]!.contributor_id,
        source_finding_id: "DR-001",
        disposition: "retained" as const,
        target_final_finding_ids: ["FINAL-001"],
        modification_percent: 20,
        rationale: "First candidate retained in FINAL-001.",
        verification_status: "asserted" as const,
      },
      {
        candidate_id: `${manifest.perspectives[1]!.contributor_id}::DR-002`,
        contributor_id: manifest.perspectives[1]!.contributor_id,
        source_finding_id: "DR-002",
        disposition: "merged" as const,
        target_final_finding_ids: ["FINAL-002"],
        modification_percent: 60,
        rationale: "Second candidate merged into FINAL-002.",
        verification_status: "asserted" as const,
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
            contribution_percent: 70,
            rationale: "First perspective supplied FINAL-001.",
          },
          {
            contributor_id: manifest.judge.contributor_id,
            source_candidate_ids: [],
            contribution_percent: 30,
            rationale: "Judge refined FINAL-001.",
          },
        ],
      },
      {
        final_finding_id: "FINAL-002",
        contributors: [
          {
            contributor_id: manifest.perspectives[1]!.contributor_id,
            source_candidate_ids: [
              `${manifest.perspectives[1]!.contributor_id}::DR-002`,
            ],
            contribution_percent: 40,
            rationale: "Second perspective supplied FINAL-002.",
          },
          {
            contributor_id: manifest.judge.contributor_id,
            source_candidate_ids: [],
            contribution_percent: 60,
            rationale: "Judge reconciled FINAL-002.",
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
        verification_status: "asserted" as const,
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
      { status: "active", obligations: [], blockers: [] },
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
    const submission = validSubmission();
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission,
      generatedAt: "now",
    });
    const markdown = renderAuditReportMarkdown(
      {
        summary: {
          finding_count: 1,
          work_block_count: 0,
          severity_breakdown: {},
          audited_file_count: 0,
          excluded_file_count: 0,
          runtime_validation_status_breakdown: {},
        },
        findings: submission.findings,
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

  it("renders conceptual attribution against the canonical synthesis finding id", () => {
    const submission = validSubmission();
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission,
      generatedAt: "now",
    });
    const run = runSynthesisExecutor({
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: true,
        conceptual_findings: submission.findings,
      },
      conceptual_review_adjudication: adjudication,
    });

    const canonicalId = run.updated.audit_findings?.findings[0]?.id;
    expect(canonicalId).toBeDefined();
    expect(canonicalId).not.toBe("FINAL-001");
    expect(run.updated.audit_report).toContain(`### ${canonicalId}`);
    expect(run.updated.audit_report).toContain(`targets ${canonicalId}.`);
    expect(run.updated.audit_report).not.toContain("### FINAL-001");
    expect(run.updated.audit_report).not.toContain("targets FINAL-001.");
    expect(JSON.stringify(run.updated.audit_findings)).not.toContain(
      "conceptual-final-id",
    );
    expect(
      run.updated.conceptual_review_adjudication?.final_finding_shares[0]
        ?.final_finding_id,
    ).toBe(canonicalId);
    expect(
      run.updated.conceptual_review_adjudication?.candidate_dispositions.map(
        (disposition) => disposition.target_final_finding_ids,
      ),
    ).toEqual([[canonicalId], [canonicalId]]);
    expect(run.updated.audit_report).toContain("55%");
    expect(run.updated.audit_report).toContain("modified 60%");
    expect(run.updated.audit_report).toContain(
      "Judge (design_review_conceptual)",
    );

    const reloaded = JSON.parse(JSON.stringify(run.updated)) as ArtifactBundle;
    const narrativeRun = runSynthesisNarrativeExecutor(reloaded, {
      themes: [],
      executive_summary: "Canonical attribution survives artifact reload.",
    });
    expect(narrativeRun.updated.audit_report).toContain(`### ${canonicalId}`);
    expect(narrativeRun.updated.audit_report).toContain(
      `targets ${canonicalId}.`,
    );
    expect(narrativeRun.updated.audit_report).not.toContain("FINAL-001");
  });

  it("coalesces judge-final shares that dedupe to one canonical finding", () => {
    const submission = collidingFinalSubmission();
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission,
      generatedAt: "now",
    });
    const run = runSynthesisExecutor({
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: true,
        conceptual_findings: submission.findings,
      },
      conceptual_review_adjudication: adjudication,
    });

    const canonicalId = run.updated.audit_findings?.findings[0]?.id;
    const canonicalShares =
      run.updated.conceptual_review_adjudication?.final_finding_shares;
    expect(run.updated.audit_findings?.findings).toHaveLength(1);
    expect(canonicalShares).toHaveLength(1);
    expect(canonicalShares?.[0]?.final_finding_id).toBe(canonicalId);
    expect(
      canonicalShares?.[0]?.contributors.reduce(
        (total, contributor) => total + contributor.contribution_percent,
        0,
      ),
    ).toBe(100);
    const attributionShares = run.updated.audit_report
      ?.split("## Conceptual Review Attribution")[1]
      ?.split("### Candidate dispositions")[0];
    expect(attributionShares?.split(`### ${canonicalId}`).length).toBe(2);

    const contributors = new Map(
      canonicalShares?.[0]?.contributors.map((contributor) => [
        contributor.contributor_id,
        contributor,
      ]),
    );
    expect(
      contributors.get(manifest.perspectives[0]!.contributor_id),
    ).toMatchObject({
      contribution_percent: 35,
      source_candidate_ids: [
        `${manifest.perspectives[0]!.contributor_id}::DR-001`,
      ],
    });
    expect(
      contributors.get(manifest.perspectives[0]!.contributor_id)?.rationale,
    ).toContain("FINAL-001 (70%): First perspective supplied FINAL-001.");
    expect(
      contributors.get(manifest.perspectives[1]!.contributor_id),
    ).toMatchObject({
      contribution_percent: 20,
      source_candidate_ids: [
        `${manifest.perspectives[1]!.contributor_id}::DR-002`,
      ],
    });
    expect(contributors.get(manifest.judge.contributor_id)).toMatchObject({
      contribution_percent: 45,
      source_candidate_ids: [],
    });
    expect(
      contributors.get(manifest.judge.contributor_id)?.rationale,
    ).toContain("FINAL-001 (30%): Judge refined FINAL-001.");
    expect(
      contributors.get(manifest.judge.contributor_id)?.rationale,
    ).toContain("FINAL-002 (60%): Judge reconciled FINAL-002.");
    expect(
      run.updated.conceptual_review_adjudication?.candidate_dispositions,
    ).toMatchObject([
      {
        target_final_finding_ids: [canonicalId],
        modification_percent: 20,
        rationale: "First candidate retained in FINAL-001.",
      },
      {
        target_final_finding_ids: [canonicalId],
        modification_percent: 60,
        rationale: "Second candidate merged into FINAL-002.",
      },
    ]);
  });

  it("migrates pre-fix persisted local attribution ids before narrative render", () => {
    const submission = validSubmission();
    const designAssessment = {
      generated_at: "now",
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
      conceptual_findings: submission.findings,
    };
    const synthesized = runSynthesisExecutor({
      design_assessment: designAssessment,
    });
    const legacyAdjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission,
      generatedAt: "before-fix",
    });
    const persisted = JSON.parse(
      JSON.stringify({
        ...synthesized.updated,
        conceptual_review_adjudication: legacyAdjudication,
      }),
    ) as ArtifactBundle;

    const migrated = runSynthesisNarrativeExecutor(persisted, {
      themes: [],
      executive_summary: "Resume a pre-fix persisted bundle.",
    });
    const canonicalId = migrated.updated.audit_findings?.findings[0]?.id;
    expect(migrated.updated.audit_report).toContain(`### ${canonicalId}`);
    expect(migrated.updated.audit_report).toContain(`targets ${canonicalId}.`);
    expect(migrated.updated.audit_report).not.toContain("FINAL-001");
    expect(
      migrated.updated.conceptual_review_adjudication?.final_finding_shares[0]
        ?.final_finding_id,
    ).toBe(canonicalId);
  });

  it("keeps largest-remainder collision allocations bounded and exactly 100%", () => {
    const perspectives = Array.from({ length: 7 }, (_, index) => ({
      contributor_id: `edge-p${index + 1}`,
      perspective: `Edge ${index + 1}`,
      lane_id: `edge-p${index + 1}`,
      prompt_path: `C:/tmp/edge-p${index + 1}-prompt.md`,
      result_path: `C:/tmp/edge-p${index + 1}-result.json`,
    }));
    const edgeManifest = {
      schema_version: 1 as const,
      mode: "deep" as const,
      round_id: "round-edge",
      perspectives,
      judge: {
        contributor_id: "edge-judge",
        lane_id: "edge-judge",
        prompt_path: "C:/tmp/edge-judge-prompt.md",
        result_path: "C:/tmp/edge-judge-result.json",
      },
    };
    const edgePerspectiveFindings = new Map(
      perspectives.map((perspective, index) => [
        perspective.contributor_id,
        [finding(`DR-${index + 1}`, `Perspective ${index + 1}`)],
      ]),
    );
    const edgeSubmission = {
      round_id: edgeManifest.round_id,
      findings: perspectives.map((_, index) =>
        finding(`FINAL-${index + 1}`, "One edge canonical core"),
      ),
      candidate_dispositions: perspectives.map((perspective, index) => ({
        candidate_id: `${perspective.contributor_id}::DR-${index + 1}`,
        contributor_id: perspective.contributor_id,
        source_finding_id: `DR-${index + 1}`,
        disposition: "retained" as const,
        target_final_finding_ids: [`FINAL-${index + 1}`],
        modification_percent: index,
        rationale: `Disposition ${index + 1}.`,
        verification_status: "asserted" as const,
      })),
      final_finding_shares: perspectives.map((perspective, index) => {
        const perspectivePercent = index < 6 ? 4 : 0;
        return {
          final_finding_id: `FINAL-${index + 1}`,
          contributors: [
            {
              contributor_id: perspective.contributor_id,
              source_candidate_ids: [
                `${perspective.contributor_id}::DR-${index + 1}`,
              ],
              contribution_percent: perspectivePercent,
              rationale: `Perspective share ${index + 1}.`,
            },
            {
              contributor_id: edgeManifest.judge.contributor_id,
              source_candidate_ids: [],
              contribution_percent: 100 - perspectivePercent,
              rationale: `Judge share ${index + 1}.`,
            },
          ],
        };
      }),
    };
    const adjudication = buildConceptualReviewAdjudication({
      manifest: edgeManifest,
      perspectiveFindings: edgePerspectiveFindings,
      submission: edgeSubmission,
      generatedAt: "now",
    });
    const run = runSynthesisExecutor({
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: true,
        conceptual_findings: edgeSubmission.findings,
      },
      conceptual_review_adjudication: adjudication,
    });

    const contributors =
      run.updated.conceptual_review_adjudication?.final_finding_shares[0]
        ?.contributors ?? [];
    expect(contributors).toHaveLength(8);
    expect(
      contributors.every(
        (contributor) =>
          contributor.contribution_percent >= 0 &&
          contributor.contribution_percent <= 100,
      ),
    ).toBe(true);
    expect(
      contributors.reduce(
        (sum, contributor) => sum + contributor.contribution_percent,
        0,
      ),
    ).toBe(100);
  });

  it("leaves adjudication unchanged when canonicalization cannot resolve every target", () => {
    const submission = validSubmission();
    const synthesized = runSynthesisExecutor({
      design_assessment: {
        generated_at: "now",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: true,
        conceptual_findings: submission.findings,
      },
    });
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission,
      generatedAt: "before-fix",
    });
    adjudication.candidate_dispositions[1]!.target_final_finding_ids = [
      "FINAL-UNKNOWN",
    ];
    const before = JSON.stringify(adjudication);
    const report = synthesized.updated.audit_findings!;

    expect(() =>
      canonicalizeConceptualAttributionIds(report, adjudication, report),
    ).toThrow(/FINAL-UNKNOWN/);
    expect(JSON.stringify(adjudication)).toBe(before);
  });
});

// ── Judge verification of every candidate (NO-REJECTION-OUTCOME) ─────────────
//
// 134 candidates across two live runs produced ZERO rejections: one candidate
// whose two named defects the judge itself reported as ALREADY FIXED at HEAD
// was merged at 70% modification. The disposition enum could always express
// `rejected`; what was missing was a field recording the verification claim and
// a rule that makes a refutation UNMERGEABLE. These pin the rule, not the judge.
describe("conceptual adjudication — candidate verification status", () => {
  it("refuses a refuted_at_head candidate that is not rejected", () => {
    const merged = validSubmission();
    const disposition = merged.candidate_dispositions[1] as unknown as {
      verification_status: string;
      verification_note: string;
    };
    disposition.verification_status = "refuted_at_head";
    disposition.verification_note =
      "Both named defects are already fixed at HEAD.";

    // The regex is load-bearing: a bare `toThrow()` is GREEN on the unfixed tree
    // for the wrong reason (`.strict()` refuses the unknown key first).
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: merged,
        generatedAt: "now",
      }),
    ).toThrow(/refuted_at_head candidate .* must be rejected/);
  });

  it("requires a verification_status on every candidate disposition", () => {
    const silent = validSubmission();
    delete (
      silent.candidate_dispositions[0] as unknown as {
        verification_status?: unknown;
      }
    ).verification_status;

    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: silent,
        generatedAt: "now",
      }),
    ).toThrow(/verification_status/);
  });

  it("requires a verification_note iff the status is not `asserted`", () => {
    const notedAssertion = validSubmission();
    (
      notedAssertion.candidate_dispositions[0] as unknown as {
        verification_note: string;
      }
    ).verification_note = "boilerplate stamped on everything";
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: notedAssertion,
        generatedAt: "now",
      }),
    ).toThrow(/verification_note is not permitted on an asserted candidate/);

    const unnotedConfirmation = validSubmission();
    const confirmed = unnotedConfirmation
      .candidate_dispositions[0] as unknown as {
      verification_status: string;
      verification_note?: unknown;
    };
    confirmed.verification_status = "judge_confirmed";
    delete confirmed.verification_note;
    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: unnotedConfirmation,
        generatedAt: "now",
      }),
    ).toThrow(/judge_confirmed[\s\S]*requires a verification_note/);
  });

  it("refuses a judge-supplied verification_status on a final finding", () => {
    const selfCertifying = validSubmission();
    (
      selfCertifying.findings[0] as unknown as { verification_status: string }
    ).verification_status = "judge_confirmed";

    expect(() =>
      buildConceptualReviewAdjudication({
        manifest,
        perspectiveFindings,
        submission: selfCertifying,
        generatedAt: "now",
      }),
    ).toThrow(
      /findings\[0\]\.verification_status[\s\S]*derived at ingest and must not be supplied/,
    );
  });

  it("publishes candidate-scoped disposition and verification counts it derived itself", () => {
    const adjudication = buildConceptualReviewAdjudication({
      manifest,
      perspectiveFindings,
      submission: validSubmission(),
      generatedAt: "now",
    });

    expect(adjudication.candidate_disposition_breakdown).toEqual({
      retained: 1,
      merged: 1,
    });
    expect(adjudication.candidate_verification_status_breakdown).toEqual({
      asserted: 2,
    });
  });
});
