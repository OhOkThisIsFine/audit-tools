/**
 * T1 slice 4 — escalate-on-evidence (optimistic-start) wired into the contract
 * pipeline. A run begins at the cheap intake tier; once `module_decomposition`
 * reveals the work's actual shape, buildNextContractPipelineStep raises the
 * persisted intake risk signal IN-BAND on the next next-step, so the
 * adversarial-depth dial tightens. The raise is idempotent + convergent: a
 * second next-step over the same evidence does not re-append rationale.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  computeIntakeRiskSignal,
  writeIntakeRiskSignal,
  readIntakeRiskSignal,
} from "../../src/remediate/riskSignal.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

async function seedDecomposition(
  artifactsDir: string,
  modules: { name: string; responsibilities: string; file_scope: string[] }[],
): Promise<void> {
  await writeContractArtifact(artifactsDir, "module_decomposition", {
    contract_version: "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
    goal_id: "G-1",
    modules,
    created_at: CREATED_AT,
  });
}

describe("escalate-on-evidence in buildNextContractPipelineStep", () => {
  let root: string;
  let artifactsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "escalate-evidence-"));
    artifactsDir = join(root, ".audit-tools", "remediation");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("raises a low intake tier to medium when decomposition reveals >1 module", async () => {
    const base = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["small refactor"],
    });
    expect(base.tier).toBe("low");
    await writeIntakeRiskSignal(artifactsDir, base);

    await seedDecomposition(artifactsDir, [
      { name: "a", responsibilities: "x", file_scope: ["src/remediate/reporting/a.ts"] },
      { name: "b", responsibilities: "y", file_scope: ["src/remediate/reporting/b.ts"] },
    ]);

    await buildNextContractPipelineStep({ root, artifactsDir, runId: "ESC-TEST" });

    const after = await readIntakeRiskSignal(artifactsDir);
    expect(after?.tier).toBe("medium");
    expect(after?.escalated).toBe(true);
    expect(after?.rationale.at(-1)).toContain("2 modules");
  });

  it("raises to high when a module file_scope touches a risk subsystem", async () => {
    await writeIntakeRiskSignal(
      artifactsDir,
      computeIntakeRiskSignal({
        affectedFiles: ["src/remediate/reporting/render.ts"],
        goals: ["small refactor"],
      }),
    );
    await seedDecomposition(artifactsDir, [
      { name: "a", responsibilities: "x", file_scope: ["src/remediate/steps/dispatch.ts"] },
    ]);

    await buildNextContractPipelineStep({ root, artifactsDir, runId: "ESC-TEST" });

    const after = await readIntakeRiskSignal(artifactsDir);
    expect(after?.tier).toBe("high");
    expect(after?.rationale.at(-1)).toContain("dispatch");
  });

  it("is convergent — a second next-step over the same evidence does not re-append rationale", async () => {
    await writeIntakeRiskSignal(
      artifactsDir,
      computeIntakeRiskSignal({
        affectedFiles: ["src/remediate/reporting/render.ts"],
        goals: ["small refactor"],
      }),
    );
    await seedDecomposition(artifactsDir, [
      { name: "a", responsibilities: "x", file_scope: ["src/remediate/reporting/a.ts"] },
      { name: "b", responsibilities: "y", file_scope: ["src/remediate/reporting/b.ts"] },
    ]);

    await buildNextContractPipelineStep({ root, artifactsDir, runId: "ESC-TEST" });
    const first = await readIntakeRiskSignal(artifactsDir);
    await buildNextContractPipelineStep({ root, artifactsDir, runId: "ESC-TEST" });
    const second = await readIntakeRiskSignal(artifactsDir);

    expect(second).toEqual(first);
  });

  it("leaves a genuinely low single-module run untouched", async () => {
    const base = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["small refactor"],
    });
    await writeIntakeRiskSignal(artifactsDir, base);
    await seedDecomposition(artifactsDir, [
      { name: "a", responsibilities: "x", file_scope: ["src/remediate/reporting/a.ts"] },
    ]);

    await buildNextContractPipelineStep({ root, artifactsDir, runId: "ESC-TEST" });

    const after = await readIntakeRiskSignal(artifactsDir);
    expect(after?.tier).toBe("low");
    expect(after?.escalated).toBe(false);
  });
});
