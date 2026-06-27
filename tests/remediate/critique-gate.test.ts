/**
 * The conceptual-design-critique gate (A1). Closes the gap where a critique
 * carrying a `severity: "blocking"` item — even inside a non-`rejected` verdict —
 * silently proceeded because only the judge verdict was ever consumed. The gate's
 * routing signal is MECHANICAL (any blocking item), independent of the stated
 * verdict, and convergence-terminated like the judge gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { evaluateCritiqueGate } from "../../src/remediate/steps/contractPipeline.js";
import {
  contractPipelineDir,
  writeContractArtifact,
} from "../../src/remediate/contractPipeline/artifactStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-critique-gate");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CRITIQUE_VERSION =
  "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1";

function critique(opts: {
  verdict: "approved" | "approved_with_concerns" | "rejected";
  items: Array<{ id: string; severity: "blocking" | "advisory" }>;
  createdAt?: string;
}) {
  return {
    contract_version: CRITIQUE_VERSION,
    goal_id: "G-1",
    items: opts.items.map((i) => ({
      id: i.id,
      kind: "concern",
      description: `concern ${i.id}`,
      severity: i.severity,
    })),
    verdict: opts.verdict,
    created_at: opts.createdAt ?? CREATED_AT,
  };
}

async function writeRepairState(critique_repairs: unknown[]): Promise<void> {
  await mkdir(contractPipelineDir(ARTIFACTS_DIR), { recursive: true });
  await writeFile(
    join(contractPipelineDir(ARTIFACTS_DIR), "repair-state.json"),
    JSON.stringify({
      schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1",
      repairs: [],
      critique_repairs,
      dag_regenerations: [],
    }),
    "utf8",
  );
}

describe("conceptual-design-critique gate (A1)", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("proceeds when there is no critique artifact", async () => {
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("proceed");
  });

  it("proceeds when no item is blocking (advisory concerns under approved_with_concerns)", async () => {
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({
        verdict: "approved_with_concerns",
        items: [{ id: "C-1", severity: "advisory" }],
      }),
    );
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("proceed");
  });

  it("repairs on a blocking item even when the stated verdict is approved_with_concerns (the contradictory combo)", async () => {
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({
        verdict: "approved_with_concerns",
        items: [
          { id: "C-1", severity: "blocking" },
          { id: "C-2", severity: "advisory" },
        ],
      }),
    );
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("repair");
    if (gate.kind === "repair") {
      expect(gate.blockingIds).toEqual(["C-1"]);
    }
  });

  it("repairs on a bare rejected verdict (blocking item present)", async () => {
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({
        verdict: "rejected",
        items: [{ id: "C-9", severity: "blocking" }],
      }),
    );
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("repair");
  });

  it("re-emits the same repair idempotently for an already-handled critique hash", async () => {
    const env = await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({ verdict: "rejected", items: [{ id: "C-1", severity: "blocking" }] }),
    );
    await writeRepairState([
      { critique_hash: env.content_hash, at: CREATED_AT, blocking_ids: ["C-1"] },
    ]);
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("repair");
  });

  it("escalates (stall) when a FRESH critique re-raises only already-addressed blocking ids", async () => {
    // Different created_at ⇒ different content_hash ⇒ a genuinely fresh critique
    // (a prior repair produced it), but its blocking ids were all addressed.
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({
        verdict: "rejected",
        items: [{ id: "C-1", severity: "blocking" }],
        createdAt: "2026-02-02T00:00:00.000Z",
      }),
    );
    await writeRepairState([
      { critique_hash: "some-older-hash", at: CREATED_AT, blocking_ids: ["C-1"] },
    ]);
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("escalate");
    if (gate.kind === "escalate") {
      expect(gate.reason).toBe("stall");
      expect(gate.blocking).toEqual(["C-1"]);
    }
  });

  it("repairs (not stall) when a fresh critique raises a NEW blocking id", async () => {
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({
        verdict: "rejected",
        items: [
          { id: "C-1", severity: "blocking" },
          { id: "C-2", severity: "blocking" },
        ],
      }),
    );
    await writeRepairState([
      { critique_hash: "older", at: CREATED_AT, blocking_ids: ["C-1"] },
    ]);
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("repair");
  });

  it("escalates (runaway) at the repair-iteration backstop", async () => {
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "conceptual_design_critique",
      critique({
        verdict: "rejected",
        items: [{ id: "C-1", severity: "blocking" }],
        createdAt: "2026-03-03T00:00:00.000Z",
      }),
    );
    // 8 prior repair rounds (MAX_CONTRACT_REPAIR_ITERATIONS), each a distinct hash.
    await writeRepairState(
      Array.from({ length: 8 }, (_unused, i) => ({
        critique_hash: `h-${i}`,
        at: CREATED_AT,
        blocking_ids: [`X-${i}`],
      })),
    );
    const gate = await evaluateCritiqueGate(ARTIFACTS_DIR);
    expect(gate.kind).toBe("escalate");
    if (gate.kind === "escalate") {
      expect(gate.reason).toBe("runaway");
    }
  });
});
