/**
 * T1 slice 4b — granularity collapse. For low-complexity (low-tier) work the
 * framing phases (goal_normalization + context_collection + decomposition) fold
 * into ONE round-trip producing all three artifacts, instead of three gated
 * steps. Medium/high tiers (and an absent signal) stay fine-grained — one phase
 * per round-trip — so failure-isolation + per-phase validation are preserved
 * exactly where complexity earns them. The collapse stops at decomposition so the
 * slice-4a escalate-on-evidence intercept can still un-collapse the remainder.
 * Collapse is best-effort: a single trailing framing phase is NOT collapsed (it
 * falls through to the normal per-phase dispatch).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  roundTripGranularityForTier,
  computeIntakeRiskSignal,
  writeIntakeRiskSignal,
  type RiskTier,
} from "../../src/remediate/riskSignal.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

/** A low-tier intake signal: one non-risk file, neutral goal. */
function lowSignal() {
  const s = computeIntakeRiskSignal({
    affectedFiles: ["src/remediate/reporting/render.ts"],
    goals: ["small copy tweak"],
  });
  if (s.tier !== "low") throw new Error(`expected low tier, got ${s.tier}`);
  return s;
}

async function seedGoalSpec(artifactsDir: string): Promise<void> {
  await writeContractArtifact(artifactsDir, "goal_spec", {
    contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
    goal_id: "G-1",
    goals: ["x"],
    created_at: CREATED_AT,
  });
}

async function seedContextBundle(artifactsDir: string): Promise<void> {
  await writeContractArtifact(artifactsDir, "context_bundle", {
    contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
    goal_id: "G-1",
    files: [],
    created_at: CREATED_AT,
  });
}

describe("roundTripGranularityForTier", () => {
  it("collapses only the low tier; medium/high/undefined stay fine", () => {
    expect(roundTripGranularityForTier("low")).toBe("collapsed");
    expect(roundTripGranularityForTier("medium")).toBe("fine");
    expect(roundTripGranularityForTier("high")).toBe("fine");
    expect(roundTripGranularityForTier(undefined)).toBe("fine");
  });

  it("is fail-safe toward isolation for every non-low tier", () => {
    for (const tier of ["medium", "high"] as RiskTier[]) {
      expect(roundTripGranularityForTier(tier)).toBe("fine");
    }
  });
});

describe("granularity collapse in buildNextContractPipelineStep", () => {
  let root: string;
  let artifactsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "granularity-collapse-"));
    artifactsDir = join(root, ".audit-tools", "remediation");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("folds the full framing group into ONE round-trip on a fresh low-tier run", async () => {
    await writeIntakeRiskSignal(artifactsDir, lowSignal());

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "GC-TEST",
    });

    expect(step).not.toBeNull();
    expect(step!.stop_condition).toContain("collapsed artifacts");
    expect(step!.stop_condition).toContain("goal_normalization");
    expect(step!.stop_condition).toContain("decomposition");

    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Collapsed Authoring Round-Trip — 3 Phases");
    // All three artifact write-targets are present in the single prompt.
    expect(prompt).toContain("goal_spec.input.json");
    expect(prompt).toContain("context_bundle.input.json");
    expect(prompt).toContain("module_decomposition.input.json");
    // Exactly one next-step footer for the whole round-trip.
    const nextStepCount = (prompt.match(/next-step/g) ?? []).length;
    expect(nextStepCount).toBeGreaterThan(0);
  });

  it("collapses only the remaining suffix when a run resumes mid-framing", async () => {
    await writeIntakeRiskSignal(artifactsDir, lowSignal());
    await seedGoalSpec(artifactsDir);

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "GC-TEST",
    });

    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Collapsed Authoring Round-Trip — 2 Phases");
    expect(prompt).toContain("context_bundle.input.json");
    expect(prompt).toContain("module_decomposition.input.json");
    expect(step!.stop_condition).toContain("context_collection");
    expect(step!.stop_condition).not.toContain("goal_normalization");
  });

  it("does NOT collapse a single trailing framing phase (decomposition alone)", async () => {
    await writeIntakeRiskSignal(artifactsDir, lowSignal());
    await seedGoalSpec(artifactsDir);
    await seedContextBundle(artifactsDir);

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "GC-TEST",
    });

    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).not.toContain("Collapsed Authoring Round-Trip");
    // Falls through to the normal single decomposition phase step.
    expect(step!.stop_condition).toContain("decomposition");
  });

  it("stays fine-grained (no collapse) for a medium-tier run", async () => {
    const medium = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["security hardening migration"],
    });
    expect(medium.tier === "medium" || medium.tier === "high").toBe(true);
    await writeIntakeRiskSignal(artifactsDir, medium);

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "GC-TEST",
    });

    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).not.toContain("Collapsed Authoring Round-Trip");
  });

  it("stays fine-grained when no intake risk signal is present (fail-safe)", async () => {
    // No writeIntakeRiskSignal — absent signal ⇒ undefined ⇒ fine.
    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "GC-TEST",
    });

    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).not.toContain("Collapsed Authoring Round-Trip");
  });
});

// ---------------------------------------------------------------------------
// The AUTHORING-TAIL group: {test_validator_plan, assessment}.
//
// The second (and only other) safe collapse group. Both are author-side,
// neither carries the independent-critic mandate, and the critic reviews both
// afterwards unchanged. See docs/reviews/low-tier-phase-cost-2026-08-25.md for
// why every other adjacency is unsafe.
//
// The scaffold assertion is the load-bearing one. `collapsedRoundTripGate` is
// registered BEFORE `scaffoldedPhaseGate`, so a group containing
// test_validator_plan can silently swallow the S3 skeleton the worker is meant
// to fill — which would make the collapse make that phase HARDER, not cheaper.
// ---------------------------------------------------------------------------

describe("authoring-tail collapse — {test_validator_plan, assessment}", () => {
  let root: string;
  let artifactsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-tail-collapse-"));
    artifactsDir = join(root, ".audit-tools", "remediation");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Seed every phase up to (not including) test_validator_plan. */
  async function seedThroughCyclicSeamResolution(): Promise<void> {
    const g = "G-1";
    await seedGoalSpec(artifactsDir);
    await writeContractArtifact(artifactsDir, "context_bundle", {
      contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
      goal_id: g,
      entries: [],
      context_summary: "ctx",
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "module_decomposition", {
      contract_version: "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
      goal_id: g,
      modules: [{ name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] }],
      created_at: CREATED_AT,
    });
    const contract = {
      name: "mod-a",
      inputs: ["x"],
      outputs: ["y"],
      invariants: ["x is always validated"],
      side_effects: [],
      validation_boundary: "validates x",
      failure_modes: [],
      neighbor_needs: [],
    };
    await writeContractArtifact(artifactsDir, "module_contracts", {
      contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
      goal_id: g,
      module_contracts: [contract],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "seam_reconciliation_report", {
      contract_version: "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
      goal_id: g,
      mismatches: [],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", {
      contract_version: "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
      goal_id: g,
      module_contracts: [{ ...contract, seam_adjustments: [] }],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "conceptual_design_critique", {
      contract_version: "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
      goal_id: g,
      items: [],
      verdict: "approved",
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "obligation_ledger", {
      contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
      goal_id: g,
      obligations: [
        {
          id: "O-1",
          description: "x is always validated.",
          kind: "behavioral",
          depends_on: [],
          status: "pending",
        },
      ],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "cyclic_seam_resolution", {
      contract_version: "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: g,
      status: "no_cycles",
      cycles: [],
      created_at: CREATED_AT,
    });
  }

  it("folds the tail into ONE round-trip on a low-tier run", async () => {
    await writeIntakeRiskSignal(artifactsDir, lowSignal());
    await seedThroughCyclicSeamResolution();

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "AT-TEST",
    });

    expect(step).not.toBeNull();
    expect(step!.stop_condition).toContain("collapsed artifacts");
    expect(step!.stop_condition).toContain("test_validator_plan");
    expect(step!.stop_condition).toContain("assessment");

    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Collapsed Authoring Round-Trip — 2 Phases");
    expect(prompt).toContain("test_validator_plan.input.json");
    expect(prompt).toContain("contract_assessment_report.input.json");
  });

  it("carries the S3 scaffold into the collapsed round-trip", async () => {
    await writeIntakeRiskSignal(artifactsDir, lowSignal());
    await seedThroughCyclicSeamResolution();

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "AT-SCAFFOLD",
    });
    const prompt = await readFile(step!.prompt_path, "utf8");

    // The collapse gate runs BEFORE the scaffolded-phase gate. Without the
    // per-section extra, the skeleton would vanish and the worker would be
    // asked to author the whole plan from scratch inside a CHEAPER step.
    expect(prompt, "the pre-filled skeleton must survive the collapse").toContain(
      "Pre-filled Skeleton",
    );
    expect(prompt, "the skeleton must carry the derived obligation id").toContain(
      "O-1",
    );
  });

  it("stays fine-grained at medium tier, and still scaffolds", async () => {
    const medium = computeIntakeRiskSignal({
      affectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      goals: ["rework the authentication boundary"],
    });
    expect(roundTripGranularityForTier(medium.tier)).toBe("fine");
    await writeIntakeRiskSignal(artifactsDir, medium);
    await seedThroughCyclicSeamResolution();

    const step = await buildNextContractPipelineStep({
      root,
      artifactsDir,
      runId: "AT-FINE",
    });

    expect(step).not.toBeNull();
    expect(step!.stop_condition).not.toContain("collapsed artifacts");
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).not.toContain("Collapsed Authoring Round-Trip");
    expect(prompt).toContain("Pre-filled Skeleton");
  });
});
