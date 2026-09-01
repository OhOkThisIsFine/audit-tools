import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import {
  writeCoreArtifacts,
  type ArtifactBundle,
} from "../../src/audit/io/artifacts.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
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
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      reviewed: false,
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
