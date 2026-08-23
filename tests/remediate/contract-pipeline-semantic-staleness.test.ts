/**
 * B3 — content/semantics-aware staleness guard.
 *
 * Staleness records and compares each dependency by the hash of its SEMANTIC
 * PROJECTION (load-bearing structure only), not its raw payload bytes. These
 * tests lock the two halves of that property:
 *
 *  1. A COSMETIC upstream edit — a reworded rationale, a regenerated
 *     `created_at` stamp, reordered keys, or a non-derivable field on the
 *     finalized contracts — does NOT re-stale downstream artifacts.
 *  2. A LOAD-BEARING upstream edit — a new module invariant / failure mode / a
 *     changed interface on the finalized contracts — DOES re-stale downstream.
 *
 * Without this, every cosmetic edit to finalized_module_contracts re-staled
 * obligation_ledger → test_validator_plan → contract_assessment and forced a
 * full (LLM) re-authoring of artifacts whose load-bearing inputs were unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeContractArtifact,
  readContractArtifact,
  detectStaleArtifacts,
  contractArtifactFilePath,
  envelopeSemanticHash,
  type ContractPipelineArtifactEnvelope,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { semanticProjection } from "../../src/remediate/contractPipeline/semanticProjection.js";

let tmpDir: string;
let artifactsDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cp-sem-stale-"));
  artifactsDir = join(tmpDir, ".audit-tools", "remediation");
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const GOAL = "GOAL-SEM";

function makeFinalized(opts: {
  invariants?: string[];
  failure_modes?: string[];
  rationale?: string;
  created_at?: string;
} = {}): Record<string, unknown> {
  return {
    contract_version: "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
    goal_id: GOAL,
    module_contracts: [
      {
        name: "mod-a",
        inputs: ["x"],
        outputs: ["y"],
        invariants: opts.invariants ?? [],
        failure_modes: opts.failure_modes ?? [],
        validation_boundary: "validates x",
        side_effects: [],
        seam_adjustments: [],
        // Non-derivable prose the projection must ignore.
        rationale: opts.rationale ?? "original rationale",
      },
    ],
    created_at: opts.created_at ?? "2026-06-18T00:00:00.000Z",
  };
}

/** A derived-ledger-shaped payload depending on finalized_module_contracts. */
function makeLedger(created_at = "2026-06-18T00:00:00.000Z"): Record<string, unknown> {
  return {
    contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
    goal_id: GOAL,
    obligations: [
      { id: "OBL-mod-a-contract", description: "Implement mod-a.", kind: "structural", depends_on: [], status: "pending" },
    ],
    created_at,
  };
}

/** Seed finalized's full transitive ancestor chain so finalized is fresh (no
 *  missing-dependency staleness leaks into the assertions below). */
async function seedFinalizedDeps(): Promise<void> {
  for (const name of [
    "goal_spec",
    "context_bundle",
    "module_decomposition",
    "module_contracts",
    "seam_reconciliation_report",
  ] as const) {
    await writeContractArtifact(artifactsDir, name, { goal_id: GOAL, artifact: name });
  }
}

describe("B3 semantic staleness — cosmetic upstream edits do not re-stale", () => {
  it("a non-derivable (rationale) edit to finalized_module_contracts leaves obligation_ledger fresh", async () => {
    await seedFinalizedDeps();
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", makeFinalized());
    await writeContractArtifact(artifactsDir, "obligation_ledger", makeLedger());
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("obligation_ledger");

    // Reword rationale + bump created_at — both non-load-bearing.
    await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      makeFinalized({ rationale: "completely reworded rationale", created_at: "2099-01-01T00:00:00.000Z" }),
    );

    const { stale } = await detectStaleArtifacts(artifactsDir);
    expect(stale).not.toContain("finalized_module_contracts"); // just written → fresh
    expect(stale).not.toContain("obligation_ledger"); // cosmetic upstream → still fresh
  });

  it("a created_at-only re-emit of obligation_ledger does not re-stale test_validator_plan", async () => {
    await seedFinalizedDeps();
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", makeFinalized());
    await writeContractArtifact(artifactsDir, "obligation_ledger", makeLedger("2026-06-18T00:00:00.000Z"));
    await writeContractArtifact(artifactsDir, "test_validator_plan", { goal_id: GOAL, test_specs: [] });
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("test_validator_plan");

    // Re-derive the ledger: identical obligations, fresh created_at (the exact
    // churn the derived-ledger path produces every run).
    await writeContractArtifact(artifactsDir, "obligation_ledger", makeLedger("2030-12-31T23:59:59.000Z"));

    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("test_validator_plan");
  });
});

describe("B3 semantic staleness — load-bearing upstream edits do re-stale", () => {
  it("adding a module invariant to finalized_module_contracts re-stales obligation_ledger", async () => {
    await seedFinalizedDeps();
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", makeFinalized());
    await writeContractArtifact(artifactsDir, "obligation_ledger", makeLedger());
    expect((await detectStaleArtifacts(artifactsDir)).stale).not.toContain("obligation_ledger");

    // A new invariant IS load-bearing (it becomes a new obligation).
    await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      makeFinalized({ invariants: ["x must never be negative"] }),
    );

    expect((await detectStaleArtifacts(artifactsDir)).stale).toContain("obligation_ledger");
  });

  it("adding a failure mode is load-bearing and re-stales downstream", async () => {
    await seedFinalizedDeps();
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", makeFinalized());
    await writeContractArtifact(artifactsDir, "obligation_ledger", makeLedger());

    await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      makeFinalized({ failure_modes: ["upstream timeout"] }),
    );

    expect((await detectStaleArtifacts(artifactsDir)).stale).toContain("obligation_ledger");
  });
});

describe("B3 semantic staleness — projection + envelope", () => {
  it("finalized projection keeps derivable fields and drops rationale/created_at/seam prose", () => {
    const projected = semanticProjection("finalized_module_contracts", makeFinalized({ rationale: "x" })) as {
      goal_id: string;
      module_contracts: Array<Record<string, unknown>>;
    };
    expect(projected.goal_id).toBe(GOAL);
    const mod = projected.module_contracts[0];
    expect(mod).toHaveProperty("invariants");
    expect(mod).toHaveProperty("failure_modes");
    expect(mod).not.toHaveProperty("rationale");
    expect(mod).not.toHaveProperty("seam_adjustments");
    expect(mod).not.toHaveProperty("created_at");
  });

  it("a whitespace-only edit to a load-bearing field projects identically (no churn)", () => {
    const a = makeFinalized({ invariants: ["x must never be negative"] });
    const b = makeFinalized({ invariants: ["x   must  never   be negative  "] });
    expect(semanticProjection("finalized_module_contracts", a)).toEqual(
      semanticProjection("finalized_module_contracts", b),
    );
  });

  it("side_effects is load-bearing at BOTH layers of the module-contract projection", () => {
    const make = (sideEffects: string[], layer: "intermediate" | "finalized") =>
      layer === "intermediate"
        ? {
            contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
            goal_id: GOAL,
            module_contracts: [
              {
                name: "mod-a",
                inputs: ["x"],
                outputs: ["y"],
                invariants: [],
                failure_modes: [],
                validation_boundary: "v",
                side_effects: sideEffects,
                neighbor_needs: ["needs mod-b"],
              },
            ],
            created_at: "2026-06-18T00:00:00.000Z",
          }
        : {
            contract_version:
              "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1",
            goal_id: GOAL,
            module_contracts: [
              {
                name: "mod-a",
                inputs: ["x"],
                outputs: ["y"],
                invariants: [],
                failure_modes: [],
                validation_boundary: "v",
                side_effects: sideEffects,
                seam_adjustments: [],
                rationale: "prose the projection drops",
              },
            ],
            created_at: "2026-06-18T00:00:00.000Z",
          };

    for (const layer of ["intermediate", "finalized"] as const) {
      const name = layer === "intermediate" ? "module_contracts" : "finalized_module_contracts";
      const projected = semanticProjection(name, make(["writes a file"], layer)) as {
        module_contracts: Array<Record<string, unknown>>;
      };
      // Load-bearing at both layers: buildBaselineSymbolCorpus draws the
      // change-vs-addition corpus from the declared interface surface including
      // side_effects, so a dropped side_effects left stale classification inputs
      // behind a fresh-looking ledger (CP-NODE-19).
      expect(projected.module_contracts[0]).toHaveProperty("side_effects");

      // A side_effects-only edit is a LOAD-BEARING edit → re-projects.
      expect(semanticProjection(name, make(["writes a file"], layer))).not.toEqual(
        semanticProjection(name, make(["appends a log line"], layer)),
      );
    }

    // Still narrowed: the truly non-derivable per-entry fields drop.
    const intermediate = semanticProjection(
      "module_contracts",
      make(["writes a file"], "intermediate"),
    ) as { module_contracts: Array<Record<string, unknown>> };
    expect(intermediate.module_contracts[0]).not.toHaveProperty("neighbor_needs");
    const finalized = semanticProjection(
      "finalized_module_contracts",
      make(["writes a file"], "finalized"),
    ) as { module_contracts: Array<Record<string, unknown>> };
    expect(finalized.module_contracts[0]).not.toHaveProperty("rationale");
    expect(finalized.module_contracts[0]).not.toHaveProperty("seam_adjustments");
  });

  it("a changed interface on the intermediate module_contracts still re-projects (load-bearing)", () => {
    const make = (outputs: string[]) => ({
      contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1",
      goal_id: GOAL,
      module_contracts: [
        { name: "mod-a", inputs: ["x"], outputs, invariants: [], failure_modes: [], validation_boundary: "v" },
      ],
      created_at: "2026-06-18T00:00:00.000Z",
    });
    expect(semanticProjection("module_contracts", make(["y"]))).not.toEqual(
      semanticProjection("module_contracts", make(["y", "z"])),
    );
  });

  it("envelopeSemanticHash recomputes from payload and is identical for a cosmetic-only twin", async () => {
    const a = await writeContractArtifact(artifactsDir, "finalized_module_contracts", makeFinalized());
    const b = await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      makeFinalized({ rationale: "different", created_at: "2099-01-01T00:00:00.000Z" }),
    );
    // Different bytes → different content_hash; same meaning → same recomputed semantic hash.
    expect(b.content_hash).not.toBe(a.content_hash);
    expect(envelopeSemanticHash(b)).toBe(envelopeSemanticHash(a));
  });

  it("envelopeSemanticHash always recomputes from the envelope's current payload (no stored field)", async () => {
    await writeContractArtifact(artifactsDir, "obligation_ledger", makeLedger());
    const env = (await readContractArtifact(artifactsDir, "obligation_ledger"))!;
    // The envelope no longer persists a semantic_hash field (CE-003, delete-legacy).
    expect(env).not.toHaveProperty("semantic_hash");
    // The hash is the semantic projection of the current payload — recomputed on read.
    const expected = envelopeSemanticHash(env);
    const recomputed = envelopeSemanticHash({ ...env });
    expect(recomputed).toBe(expected);
    // An in-place payload edit (header untouched) reconverges on next read: a
    // load-bearing change yields a different hash, a cosmetic one the same.
    const loadBearing: ContractPipelineArtifactEnvelope = {
      ...env,
      payload: makeLedger("2099-01-01T00:00:00.000Z"),
    };
    expect(envelopeSemanticHash(loadBearing)).toBe(expected); // created_at is cosmetic
  });

  it("the on-disk envelope persists no semantic_hash field (recompute-on-read design)", async () => {
    await writeContractArtifact(artifactsDir, "goal_spec", { goal_id: GOAL });
    const raw = JSON.parse(
      await readFile(contractArtifactFilePath(artifactsDir, "goal_spec"), "utf8"),
    );
    expect(raw).not.toHaveProperty("semantic_hash");
    // It carries the structural fields the new design relies on instead.
    expect(typeof raw.content_hash).toBe("string");
    expect(raw).toHaveProperty("payload");
  });
});
