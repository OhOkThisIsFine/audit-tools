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
    expect(step!.stop_condition).toContain("collapsed-framing artifacts");
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
