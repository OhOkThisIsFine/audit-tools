import { captureCompletedDesignReviews, persistDesignReviewSnapshots } from "./helpers/designReviewSnapshotFixture.js";
import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { writeCoreArtifacts, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { writeBoundReviewFixture } from "./helpers/reviewSubmissionFixture.js";
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { charterExtractionKindsForCeiling } from "../../src/audit/cli/charterExtractionPrompt.js";
import { GATE_LANES, charterExtractionLane, charterExtractionPacketFilename } from "../../src/audit/cli/laneSubmissions.js";
import { handleCharterExtractionBranch, handleCharterComparisonBranch, handleCharterFidelityBranch } from "../../src/audit/cli/nextStepHelpers.js";
import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { withArtifactTreeHold } from "../../src/shared/io/artifactTreeHold.js";

function deepCeilingBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100 },
        { path: "README.md", language: "markdown", size_bytes: 100 },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "README.md", status: "doc_only" },
      ],
    },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    external_analyzer_results: [{ tool: "eslint", results: [] }],
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_findings: [],
      contract_reviewed: true,
      conceptual_findings: [],
      conceptual_reviewed: true,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 1,
      source_ids: ["call_import"],
      consensus: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
      findings: [],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: { answered_at: "2026-01-01T00:00:00Z", ceiling: { rung: "deep" } },
    },
  } as ArtifactBundle;
}


type CharterBranchResult = Awaited<ReturnType<
  typeof handleCharterExtractionBranch | typeof handleCharterComparisonBranch | typeof handleCharterFidelityBranch
>>;

function pendingBundle(kind: "extraction" | "comparison" | "fidelity"): ArtifactBundle {
  const bundle = deepCeilingBundle();
  if (kind === "extraction") return captureCompletedDesignReviews(bundle);
  bundle.charter_register = {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION, generated_at: "2026-01-01T00:00:00Z",
    target: "charter", ceiling: { rung: "deep" }, ...EMPTY_REGISTER_BODY,
    lanes: ["stated", "revealed"].map((lane, index) => ({ kind: lane as "stated" | "revealed",
      nodes: [{ node_id: `n${index}`, purpose: "Keep original behavior", premise_height: 0,
        files: ["src/a.ts"], provenance: [], confidence: "high" }], edges: [],
    })),
    candidates: [{ candidate_id: "candidate-a", members: [{ kind: "stated", node_ids: ["n0"] }, { kind: "revealed", node_ids: ["n1"] }], basis: "file_overlap", evidence_paths: ["src/a.ts"] }],
    comparison_pending: kind === "comparison", fidelity_pending: kind === "fidelity",
    differences: kind === "fidelity" ? [{ difference_id: "difference-a", correspondence_id: "correspondence-a",
      dimension: "purpose", relation: "incompatible", split: { kind: "two_against_one", odd: "revealed" },
      accounts: [{ kind: "stated", claim: "One", provenance: [{ kind: "code", ref: "src/a.ts#alpha" }] },
        { kind: "revealed", claim: "Two", provenance: [{ kind: "code", ref: "src/a.ts#alpha" }] }],
      gap: "One versus two", routed_to: "remediator", finding_candidate: true,
    }] : [],
  };
  return captureCompletedDesignReviews(bundle);
}

for (const kind of ["extraction", "comparison", "fidelity"] as const) {
  for (const change of [false, true]) {
    test(`charter ${kind} ${change ? "refuses context B after real emission A without re-emission" : "accepts unchanged context after real emission"}`, async () => {
      await withTempRepo(async (root) => {
        const artifactsDir = join(root, ".audit-tools", "audit");
        await mkdir(join(root, "src"), { recursive: true });
        await mkdir(join(artifactsDir, "lanes"), { recursive: true });
        await writeFile(join(root, "src/a.ts"), "// intent A\nexport const alpha = 1;\n");
        await writeFile(join(root, "README.md"), "# Original purpose\n");
        const original = pendingBundle(kind);
        await writeCoreArtifacts(artifactsDir, original);
        await persistDesignReviewSnapshots(artifactsDir, original);
        await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
        const step = JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
        expect(step.step_kind).toBe(`charter_${kind}`);
        if (kind === "extraction") {
          for (const laneKind of charterExtractionKindsForCeiling({ rung: "deep" })) {
            await writeBoundReviewFixture(artifactsDir, charterExtractionLane(laneKind), { inputs: [charterExtractionPacketFilename(laneKind)], nodes: [], edges: [] });
          }
        } else if (kind === "comparison") {
          await writeBoundReviewFixture(artifactsDir, GATE_LANES.charter_comparison, {
            correspondences: [{ candidate_id: "candidate-a", verdict: "reject", members: [{ kind: "stated", node_ids: ["n0"] }, { kind: "revealed", node_ids: ["n1"] }], evidence: [] }], differences: [], no_correspondences: true,
          });
        } else {
          await writeBoundReviewFixture(artifactsDir, GATE_LANES.charter_fidelity, {
            verdicts: [{ difference_id: "difference-a", verdict: "supported", rationale: "The emitted slices support both accounts." }],
          });
        }
        const current = structuredClone(original);
        if (change) {
          if (kind === "comparison") current.charter_register!.lanes[0]!.nodes[0]!.purpose = "Changed while review was in flight";
          else if (kind === "extraction") await writeFile(join(root, "README.md"), "# Changed purpose\n");
          else await writeFile(join(root, "src/a.ts"), "// intent B\nexport const alpha = 2;\n");
        }
        const beforeConsume = structuredClone(current);
        const tx = createFoldTransaction();
        const handler = { extraction: handleCharterExtractionBranch, comparison: handleCharterComparisonBranch, fidelity: handleCharterFidelityBranch }[kind];
        const branch = await withArtifactTreeHold<CharterBranchResult>(artifactsDir, undefined, () => handler(
          { root, artifactsDir }, current, { status: "active", obligations: [] }, tx));
        expect(branch.action).toBe(change ? "return" : "continue");
        expect(tx.staged.some((entry) => entry.applied)).toBe(!change);
        if (change) {
          expect(current).toEqual(beforeConsume);
          expect(tx.pendingSnapshots).toHaveLength(0);
        }
      });
    });
  }
}
