import { REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareConceptualDispatch } from "../../src/audit/cli/conceptualDispatch.js";
import {
  commitFold,
  createFoldTransaction,
} from "../../src/audit/cli/foldTransaction.js";
import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { handleDesignReviewBranch } from "../../src/audit/cli/nextStepHelpers.js";
import {
  writeCoreArtifacts,
  type ArtifactBundle,
} from "../../src/audit/io/artifacts.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { readConceptualReviewRoundManifest } from "../../src/audit/types/conceptualAdjudication.js";
import { persistAnalyzerConsent } from "../../src/shared/analyzerPolicy.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

function readyForIntentBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/api/auth.ts", language: "typescript", size_bytes: 100 },
      ],
    },
    file_disposition: {
      files: [{ path: "src/api/auth.ts", status: "included" }],
    },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_reviewed: false,
    },
    docs_digest: {
      generated_at: "2026-01-01T00:00:00.000Z",
      docs: [],
    },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
  };
}

test("fresh guidance reaches the production confirm-intent depth proposal", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, readyForIntentBundle());

    const guidancePath = join(root, "audit-guidance.md");
    await writeFile(
      guidancePath,
      "Run a comprehensive repository-wide audit of the entire codebase.\n",
    );

    await cmdNextStep([
      "--root",
      root,
      "--artifacts-dir",
      artifactsDir,
      "--guidance-file",
      guidancePath,
    ]);

    const step = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    );
    expect(step.step_kind).toBe("confirm_intent");

    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/proposed for this intent: \*\*deep\*\*/i);
    expect(prompt).toContain('"conceptual_depth": "deep"');
  });
});

test("production systemic dispatch never advertises the deleted deep-review judge result", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const perspectiveResultPath = join(
      artifactsDir,
      "submissions",
      "conceptual-perspective-1.json",
    );
    const deletedJudgeResultPath = join(
      artifactsDir,
      "submission-staging",
      "deleted-conceptual-judge.json",
    );
    await mkdir(join(artifactsDir, "submissions"), { recursive: true });
    await writeFile(perspectiveResultPath, "[]\n");

    const bundle: ArtifactBundle = {
      ...readyForIntentBundle(),
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1",
        confirmed_at: "2026-01-01T00:00:00.000Z",
        confirmed_by: "host",
        scope_summary: "whole repository",
        intent_summary: "comprehensive repository-wide audit",
        design_review: {
          // Bound to THIS confirmation — the depth dials are per-run.
          answered_at: "2026-01-01T00:00:00.000Z",
          conceptual_depth: "deep",
          ceiling: { rung: "deep" },
          attention: 0,
        },
      },
      design_assessment: {
        generated_at: "2026-01-01T00:00:00.000Z",
        findings: [],
        contract_findings: [],
        conceptual_findings: [],
        contract_reviewed: true,
        conceptual_reviewed: true,
      },
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "deep" },
        subsystems: [],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        triangulated: [],
        disagreement: [],
        validation_issues: [],
        ...REGISTER_V4_AFFIRMATION,
      },
      charter_clarification: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter_clarification",
        ceiling: { rung: "deep" },
        attention: 0,
        status: "omitted",
        asked: [],
        banked: [],
        findings: [],
        validation_issues: [],
        ...REGISTER_V4_AFFIRMATION,
      },
      conceptual_review_adjudication: {
        schema_version: 1,
        generated_at: "2026-01-01T00:00:00.000Z",
        round_id: "round-1",
        contributors: [
          {
            contributor_id: "conceptual-perspective-1",
            role: "perspective",
            perspective: "Minimalist",
            lane_id: "conceptual-perspective-1",
            prompt_path: join(
              artifactsDir,
              "conceptual-perspective-1-prompt.md",
            ),
            result_path: perspectiveResultPath,
          },
          {
            contributor_id: "design_review_conceptual",
            role: "judge",
            lane_id: "design_review_conceptual",
            prompt_path: join(artifactsDir, "conceptual-judge-prompt.md"),
            result_path: deletedJudgeResultPath,
          },
        ],
        candidate_dispositions: [],
        final_finding_shares: [],
        candidate_disposition_breakdown: {},
        candidate_verification_status_breakdown: {},
      },
    };
    await writeCoreArtifacts(artifactsDir, bundle);
    await persistAnalyzerConsent(root, {
      semgrep: "declined",
      eslint: "declined",
      knip: "declined",
      jscpd: "declined",
      "osv-scanner": "declined",
    });

    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);

    const step = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    );
    expect(step.step_kind).toBe("systemic_challenge");
    expect(step.access.read_paths).toContain(perspectiveResultPath);
    expect(step.access.read_paths).not.toContain(deletedJudgeResultPath);

    const prompt = await readFile(
      step.artifact_paths.systemic_challenge_prompt,
      "utf8",
    );
    const normalizedPrompt = prompt.replace(/\\+/g, "/");
    expect(normalizedPrompt).toContain(perspectiveResultPath.replace(/\\+/g, "/"));
    expect(normalizedPrompt).not.toContain(deletedJudgeResultPath.replace(/\\+/g, "/"));
  });
});

// The WIRING proof for NO-REJECTION-OUTCOME. `deriveConceptualVerificationStatus`
// has its own unit pins; this one runs the REAL ingest fold and reads the
// COMMITTED artifact, because a derivation nothing calls is write-only data that
// still reads as authoritative.
//
// The candidate set must be NON-EMPTY and asserted to be: `.every()` over an
// empty array is vacuously true, so the same assertion over the fixture's
// `conceptual_findings: []` would have been green on the unfixed tree.
test("the conceptual ingest fold stamps a verification status on every admitted finding", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });

    const bundle: ArtifactBundle = {
      ...readyForIntentBundle(),
      design_assessment: {
        generated_at: "2026-01-01T00:00:00.000Z",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: false,
      },
    };
    const dispatch = await prepareConceptualDispatch({
      artifactsDir,
      bundle,
      settings: { conceptual_depth: "deep", perspectives: 2 },
    });
    const round = await readConceptualReviewRoundManifest(artifactsDir);
    if (!round) throw new Error("missing conceptual round manifest");

    function conceptualFinding(id: string): Record<string, unknown> {
      return {
        id,
        title: id,
        category: "design_simplification",
        severity: "medium",
        confidence: "high",
        lens: "architecture",
        summary: `${id} summary`,
        affected_files: [{ path: "src/api/auth.ts" }],
      };
    }

    await Promise.all(
      round.perspectives.map((contributor, index) =>
        writeFile(
          contributor.result_path,
          JSON.stringify({ findings: [conceptualFinding(`DR-00${index + 1}`)] }),
          "utf8",
        ),
      ),
    );
    await writeFile(
      dispatch.conceptualResultsPath,
      JSON.stringify({
        round_id: round.round_id,
        findings: [conceptualFinding("FINAL-001")],
        candidate_dispositions: round.perspectives.map((contributor, index) => ({
          candidate_id: `${contributor.contributor_id}::DR-00${index + 1}`,
          contributor_id: contributor.contributor_id,
          source_finding_id: `DR-00${index + 1}`,
          disposition: index === 0 ? "retained" : "merged",
          target_final_finding_ids: ["FINAL-001"],
          modification_percent: index === 0 ? 10 : 50,
          rationale: `candidate ${index + 1} disposition`,
          verification_status: index === 0 ? "judge_confirmed" : "asserted",
          ...(index === 0
            ? { verification_note: "Re-read the cited module at HEAD." }
            : {}),
        })),
        final_finding_shares: [
          {
            final_finding_id: "FINAL-001",
            contributors: [
              ...round.perspectives.map((contributor, index) => ({
                contributor_id: contributor.contributor_id,
                source_candidate_ids: [
                  `${contributor.contributor_id}::DR-00${index + 1}`,
                ],
                contribution_percent: index === 0 ? 55 : 30,
                rationale: `perspective ${index + 1} share`,
              })),
              {
                contributor_id: round.judge.contributor_id,
                source_candidate_ids: [],
                contribution_percent: 15,
                rationale: "judge share",
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const tx = createFoldTransaction();
    const branch = await handleDesignReviewBranch(
      { artifactsDir },
      bundle,
      { status: "active", obligations: [] },
      tx,
    );
    if (branch.action !== "continue") throw new Error("expected continue");
    await commitFold(artifactsDir, branch.bundle, tx);

    const committed = JSON.parse(
      await readFile(join(artifactsDir, "design_assessment.json"), "utf8"),
    ) as { conceptual_findings?: { verification_status?: string }[] };
    const conceptual = committed.conceptual_findings ?? [];
    expect(
      conceptual.length,
      "a vacuous `.every()` over an empty set would be green on the unfixed tree",
    ).toBeGreaterThan(0);
    expect(
      conceptual.every((entry) => entry.verification_status !== undefined),
      "every admitted conceptual finding must carry a status after ingest",
    ).toBe(true);
    expect(conceptual[0]?.verification_status).toBe("judge_confirmed");
  });
});

// The production REACH proof for the supplied-`verification_status` refusal.
//
// The check lived only inside `buildConceptualReviewAdjudication`, which the
// fold reaches with a submission `ConceptualJudgeSubmissionSchema.safeParse` has
// ALREADY stripped — so on the only path that matters it never fired, and a
// judge could supply the very field this vocabulary derives and be told nothing.
// Moved to the gate, over the RAW value. Driven through the real ingest fold, so
// what is proven is that the message reaches the operator, not that a helper
// returns a string.
test("the ingest fold quarantines a judge submission that supplies verification_status", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });

    const bundle: ArtifactBundle = {
      ...readyForIntentBundle(),
      design_assessment: {
        generated_at: "2026-01-01T00:00:00.000Z",
        findings: [],
        contract_reviewed: true,
        conceptual_reviewed: false,
      },
    };
    const dispatch = await prepareConceptualDispatch({
      artifactsDir,
      bundle,
      settings: { conceptual_depth: "deep", perspectives: 1 },
    });
    const round = await readConceptualReviewRoundManifest(artifactsDir);
    if (!round) throw new Error("missing conceptual round manifest");
    const perspective = round.perspectives[0];
    if (!perspective) throw new Error("manifest carries no perspective");
    await writeFile(
      perspective.result_path,
      JSON.stringify({
        findings: [
          {
            id: "DR-001",
            title: "DR-001",
            category: "design_simplification",
            severity: "medium",
            confidence: "high",
            lens: "architecture",
            summary: "candidate",
            affected_files: [{ path: "src/api/auth.ts" }],
          },
        ],
      }),
      "utf8",
    );

    // The supplied field rides on the FINDING, which is where the schema omits it.
    await writeFile(
      dispatch.conceptualResultsPath,
      JSON.stringify({
        round_id: round.round_id,
        findings: [
          {
            id: "FINAL-001",
            title: "FINAL-001",
            category: "design_simplification",
            severity: "medium",
            confidence: "high",
            lens: "architecture",
            summary: "final",
            affected_files: [{ path: "src/api/auth.ts" }],
            verification_status: "judge_confirmed",
          },
        ],
        candidate_dispositions: [
          {
            candidate_id: `${perspective.contributor_id}::DR-001`,
            contributor_id: perspective.contributor_id,
            source_finding_id: "DR-001",
            disposition: "retained",
            target_final_finding_ids: ["FINAL-001"],
            modification_percent: 10,
            rationale: "kept",
            verification_status: "asserted",
          },
        ],
        final_finding_shares: [
          {
            final_finding_id: "FINAL-001",
            contributors: [
              {
                contributor_id: perspective.contributor_id,
                source_candidate_ids: [`${perspective.contributor_id}::DR-001`],
                contribution_percent: 85,
                rationale: "perspective share",
              },
              {
                contributor_id: round.judge.contributor_id,
                source_candidate_ids: [],
                contribution_percent: 15,
                rationale: "judge share",
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const tx = createFoldTransaction();
    const branch = await handleDesignReviewBranch(
      { artifactsDir },
      bundle,
      { status: "active", obligations: [] },
      tx,
    );
    // The refusal is a CONSUMPTION, not a throw: the fold keeps going, and the
    // conceptual pass is still owed — so the branch re-emits that step rather
    // than reporting progress it did not make.
    expect(branch.action).toBe("return");
    if (branch.action !== "return") throw new Error("unreachable");
    expect(branch.result.kind).toBe("design_review_conceptual");
    // The `return` arm carries the bundle on the RESULT, not on the branch.
    await commitFold(artifactsDir, branch.result.bundle, tx);

    const ledger = await readFile(
      join(artifactsDir, "submissions", "submission-ledger.jsonl"),
      "utf8",
    );
    expect(
      ledger,
      "the refusal must be ON THE RECORD with the field it named, not silently stripped",
    ).toContain("verification_status is derived at ingest and must not be supplied");

    const committed = JSON.parse(
      await readFile(join(artifactsDir, "design_assessment.json"), "utf8"),
    ) as { conceptual_reviewed?: boolean };
    expect(
      committed.conceptual_reviewed,
      "a refused submission must not mark the conceptual pass complete",
    ).not.toBe(true);
  });
});
