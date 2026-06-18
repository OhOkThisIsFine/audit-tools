/**
 * B2 — diff-based re-review guard.
 *
 * When a verdict-bearing review phase (critique / assessment / critic / judge) is
 * re-emitted because an upstream changed, the tool must hand the worker its prior
 * verdict + the precise changed-since-last-review delta — not a blind full
 * re-run. These tests lock:
 *
 *  1. A review verdict is snapshotted (verdict + the upstream projections it
 *     reviewed) at ingest; non-review artifacts are not snapshotted.
 *  2. The delta against the snapshot reflects ONLY load-bearing upstream changes
 *     (it rides the same semantic projection as staleness — cosmetic edits show
 *     no delta).
 *  3. The rendered re-review section carries the prior verdict and the diff and
 *     instructs re-affirm-or-revise-only-affected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeContractArtifact,
  contractArtifactFilePath,
  type ContractPipelineArtifactName,
} from "../src/contractPipeline/artifactStore.js";
import {
  captureReviewSnapshot,
  computeReReviewDelta,
  diffProjections,
  isReviewArtifact,
  readReviewSnapshot,
  renderReReviewSection,
  reviewSnapshotExists,
} from "../src/contractPipeline/reviewSnapshot.js";
import { ingestContractArtifacts } from "../src/steps/contractPipeline.js";

let tmpDir: string;
let artifactsDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cp-diff-review-"));
  artifactsDir = join(tmpDir, ".audit-tools", "remediation");
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const GOAL = "GOAL-DR";
const AT = "2026-06-18T00:00:00.000Z";

function makeFinalized(invariants: string[] = []): Record<string, unknown> {
  return {
    contract_version: "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
    goal_id: GOAL,
    module_contracts: [
      {
        name: "mod-a",
        inputs: ["x"],
        outputs: ["y"],
        invariants,
        failure_modes: [],
        validation_boundary: "validates x",
        seam_adjustments: [],
        rationale: "prose",
      },
    ],
    created_at: AT,
  };
}

function makeCounterexamplePayload(): Record<string, unknown> {
  return {
    contract_version: "remediate-code-contract-pipeline/counterexample/v1alpha1",
    goal_id: GOAL,
    counterexamples: [],
    created_at: AT,
  };
}

/** Seed counterexample's full upstream chain so it can be snapshotted/ingested. */
async function seedCounterexampleDeps(invariants: string[] = []): Promise<void> {
  const deps: Array<[ContractPipelineArtifactName, Record<string, unknown>]> = [
    ["goal_spec", { goal_id: GOAL }],
    ["context_bundle", { goal_id: GOAL }],
    ["module_decomposition", { goal_id: GOAL }],
    ["module_contracts", { goal_id: GOAL }],
    ["seam_reconciliation_report", { goal_id: GOAL }],
    ["finalized_module_contracts", makeFinalized(invariants)],
    ["obligation_ledger", { goal_id: GOAL, obligations: [] }],
    ["cyclic_seam_resolution", { goal_id: GOAL, cycles: [], status: "no_cycles" }],
    ["test_validator_plan", { goal_id: GOAL, test_specs: [] }],
    ["contract_assessment_report", { goal_id: GOAL, findings: [], verdict: "passed" }],
  ];
  for (const [name, payload] of deps) {
    await writeContractArtifact(artifactsDir, name, payload);
  }
}

describe("B2 diff-based re-review — snapshot membership + capture", () => {
  it("isReviewArtifact covers the four verdict-bearing phases only", () => {
    expect(isReviewArtifact("conceptual_design_critique")).toBe(true);
    expect(isReviewArtifact("contract_assessment_report")).toBe(true);
    expect(isReviewArtifact("counterexample")).toBe(true);
    expect(isReviewArtifact("judge_report")).toBe(true);
    expect(isReviewArtifact("obligation_ledger")).toBe(false);
    expect(isReviewArtifact("finalized_module_contracts")).toBe(false);
    expect(isReviewArtifact("implementation_dag")).toBe(false);
  });

  it("captureReviewSnapshot records the verdict + upstream projections; no-op for non-review", async () => {
    await seedCounterexampleDeps();
    const verdict = makeCounterexamplePayload();
    await captureReviewSnapshot(artifactsDir, "counterexample", verdict, AT);

    expect(reviewSnapshotExists(artifactsDir, "counterexample")).toBe(true);
    const snap = (await readReviewSnapshot(artifactsDir, "counterexample"))!;
    expect(snap.prior_payload).toEqual(verdict);
    expect(snap.reviewed_inputs.finalized_module_contracts).toBeDefined();
    // The snapshot stores the SEMANTIC projection: per-module rationale is gone.
    const fmc = snap.reviewed_inputs.finalized_module_contracts as {
      module_contracts: Array<Record<string, unknown>>;
    };
    expect(fmc.module_contracts[0]).not.toHaveProperty("rationale");

    // Non-review artifact: no snapshot written.
    await captureReviewSnapshot(artifactsDir, "obligation_ledger", { goal_id: GOAL }, AT);
    expect(reviewSnapshotExists(artifactsDir, "obligation_ledger")).toBe(false);
  });

  it("ingestContractArtifacts captures a snapshot when a review artifact is ingested", async () => {
    await seedCounterexampleDeps();
    // Write a RAW (un-enveloped) counterexample, as a worker would.
    await writeFile(
      contractArtifactFilePath(artifactsDir, "counterexample"),
      JSON.stringify(makeCounterexamplePayload()),
    );
    const result = await ingestContractArtifacts(artifactsDir);
    expect(result.ingested).toContain("counterexample");
    expect(reviewSnapshotExists(artifactsDir, "counterexample")).toBe(true);
  });
});

describe("B2 diff-based re-review — delta", () => {
  it("a load-bearing upstream change appears in the delta; a cosmetic one does not", async () => {
    await seedCounterexampleDeps();
    const snap0 = makeCounterexamplePayload();
    await captureReviewSnapshot(artifactsDir, "counterexample", snap0, AT);
    const snapshot = (await readReviewSnapshot(artifactsDir, "counterexample"))!;

    // Cosmetic upstream edit (reworded rationale) → no delta.
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", {
      ...makeFinalized(),
      module_contracts: [
        { name: "mod-a", inputs: ["x"], outputs: ["y"], invariants: [], failure_modes: [], validation_boundary: "validates x", rationale: "REWORDED" },
      ],
    });
    let delta = await computeReReviewDelta(artifactsDir, "counterexample", snapshot);
    expect(delta.allUnchanged).toBe(true);

    // Load-bearing upstream edit (new invariant) → delta names the changed dep.
    await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      makeFinalized(["x must never be negative"]),
    );
    delta = await computeReReviewDelta(artifactsDir, "counterexample", snapshot);
    expect(delta.allUnchanged).toBe(false);
    const changed = delta.changedInputs.map((c) => c.dep);
    expect(changed).toContain("finalized_module_contracts");
    const lines = delta.changedInputs.find((c) => c.dep === "finalized_module_contracts")!.lines;
    expect(lines.join("\n")).toContain("x must never be negative");
  });
});

describe("B2 diff-based re-review — diffProjections + render", () => {
  it("diffProjections returns +/-/~ lines and empty for identical", () => {
    expect(diffProjections({ a: 1 }, { a: 1 })).toEqual([]);
    const lines = diffProjections({ a: 1, b: 2 }, { a: 9, c: 3 });
    expect(lines.some((l) => l.startsWith("~ a:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- b:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+ c:"))).toBe(true);
  });

  it("diffProjections caps output with an explicit overflow note", () => {
    const prior: Record<string, number> = {};
    const current: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      prior[`k${i}`] = 0;
      current[`k${i}`] = 1;
    }
    const lines = diffProjections(prior, current);
    expect(lines.length).toBeLessThanOrEqual(41);
    expect(lines[lines.length - 1]).toContain("more changed field(s)");
  });

  it("renderReReviewSection embeds the prior verdict, the diff, and the re-affirm instruction", () => {
    const snapshot = {
      schema_version: "remediate-code-contract-pipeline/review-snapshot/v1alpha1" as const,
      artifact_name: "counterexample" as const,
      reviewed_at: AT,
      prior_payload: { verdict: "PRIOR-VERDICT-MARKER", counterexamples: [] },
      reviewed_inputs: {},
    };
    const delta = {
      changedInputs: [{ dep: "finalized_module_contracts" as const, lines: ["+ a: 1"] }],
      allUnchanged: false,
    };
    const section = renderReReviewSection("counterexample", snapshot, delta);
    expect(section).toContain("PRIOR-VERDICT-MARKER");
    expect(section).toContain("finalized_module_contracts");
    expect(section).toContain("+ a: 1");
    expect(section).toMatch(/re-affirm|re-emit the prior verdict/i);
  });

  it("renderReReviewSection states re-affirm verbatim when nothing changed", () => {
    const snapshot = {
      schema_version: "remediate-code-contract-pipeline/review-snapshot/v1alpha1" as const,
      artifact_name: "judge_report" as const,
      reviewed_at: AT,
      prior_payload: { verdict: "approved" },
      reviewed_inputs: {},
    };
    const section = renderReReviewSection("judge_report", snapshot, {
      changedInputs: [],
      allUnchanged: true,
    });
    expect(section).toMatch(/No upstream semantic change/i);
  });
});
