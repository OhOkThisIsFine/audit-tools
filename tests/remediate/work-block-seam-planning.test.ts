import { describe, expect, it } from "vitest";
import { validateWorkBlockSeamPreparation } from "../../src/remediate/validation/contractPipelineGates.js";
import {
  applyWorkBlockSeamDependencies,
  derivePhaseCut,
} from "../../src/remediate/contractPipeline/phaseCut.js";

const seed = {
  work_blocks: [
    { id: "B-1", role: "implementation" },
    { id: "B-2", role: "implementation" },
  ],
  work_block_seams: [
    {
      id: "S-1",
      block_ids: ["B-1", "B-2"],
      shared_files: ["src/shared.ts"],
      requires_preparation: true,
    },
  ],
};

const decomposition = {
  modules: [
    {
      name: "shared-contract",
      file_scope: ["src/shared.ts"],
      source_work_block_ids: [],
      prepares_seam_ids: ["S-1"],
    },
    {
      name: "refactor-a",
      file_scope: ["src/a.ts"],
      source_work_block_ids: ["B-1"],
      prepares_seam_ids: [],
    },
    {
      name: "refactor-b",
      file_scope: ["src/b.ts"],
      source_work_block_ids: ["B-2"],
      prepares_seam_ids: [],
    },
  ],
};

describe("Path-A work-block seam planning", () => {
  it("rejects a dangerous overlap without an explicit seam-preparation module", () => {
    const withoutPreparer = {
      modules: decomposition.modules.filter((module) => module.name !== "shared-contract"),
    };
    const issues = validateWorkBlockSeamPreparation(seed, withoutPreparer);

    expect(issues.some((issue) => issue.message.includes("exactly one module"))).toBe(true);
  });

  it("accepts a distinct, shared-file-scoped seam preparer", () => {
    expect(validateWorkBlockSeamPreparation(seed, decomposition)).toEqual([]);
  });

  it("derives a seam-first phase followed by parallel implementation modules", () => {
    const constrained = applyWorkBlockSeamDependencies(
      decomposition.modules.map((module) => ({ name: module.name, depends_on: [] })),
      decomposition,
      seed,
    );
    const byName = new Map(constrained.map((module) => [module.name, module]));

    expect(byName.get("shared-contract")?.depends_on).toEqual([]);
    expect(byName.get("refactor-a")?.depends_on).toEqual(["shared-contract"]);
    expect(byName.get("refactor-b")?.depends_on).toEqual(["shared-contract"]);

    const cut = derivePhaseCut(constrained);
    expect(cut.phases).toEqual([
      { ordinal: 0, name: "foundations", modules: ["shared-contract"] },
      { ordinal: 1, name: "integration", modules: ["refactor-a", "refactor-b"] },
    ]);
  });
});
