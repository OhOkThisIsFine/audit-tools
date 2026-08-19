import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { validateWorkBlockSeamPreparation } from "../../src/remediate/validation/contractPipelineGates.js";
import {
  applyWorkBlockSeamDependencies,
  derivePhaseCut,
} from "../../src/remediate/contractPipeline/phaseCut.js";

// The audit seam contract is per CONTESTED FILE: one seam names one `file` and
// every block that owns it (two here, but the shape admits N).
const seed = {
  work_blocks: [
    { id: "B-1", role: "implementation" },
    { id: "B-2", role: "implementation" },
    { id: "B-3", role: "implementation" },
  ],
  work_block_seams: [
    {
      id: "S-1",
      file: "src/shared.ts",
      block_ids: ["B-1", "B-2", "B-3"],
      kind: "predicted_write_conflict",
      requires_preparation: true,
      rationale: "3 components cite the same predicted write path src/shared.ts.",
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
    {
      name: "refactor-c",
      file_scope: ["src/c.ts"],
      source_work_block_ids: ["B-3"],
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

  it("accepts a distinct preparer that owns the contested file", () => {
    expect(validateWorkBlockSeamPreparation(seed, decomposition)).toEqual([]);
  });

  it("refuses a seam whose shape it cannot read instead of skipping the check", () => {
    // The contested-file check used to be `typeof seam.file === "string" ? … :
    // skip`, so an old-shape or malformed seed silently LOST the check while the
    // gate still reported green.
    for (const malformed of [
      { ...seed.work_block_seams[0], file: undefined },
      { ...seed.work_block_seams[0], file: 42 },
      { ...seed.work_block_seams[0], block_ids: ["B-1", "B-1"] },
      { ...seed.work_block_seams[0], shared_files: ["src/shared.ts"], file: undefined },
    ]) {
      const issues = validateWorkBlockSeamPreparation(
        { ...seed, work_block_seams: [malformed] },
        decomposition,
      );
      expect(
        issues.some((issue) => /does not match the work-block seam contract/i.test(issue.message)),
        JSON.stringify(malformed),
      ).toBe(true);
    }
  });

  it("rejects a preparer whose file scope excludes the contested file", () => {
    const wrongScope = {
      modules: decomposition.modules.map((module) =>
        module.name === "shared-contract"
          ? { ...module, file_scope: ["src/elsewhere.ts"] }
          : module,
      ),
    };
    const issues = validateWorkBlockSeamPreparation(seed, wrongScope);

    expect(
      issues.some((issue) => issue.message.includes("must own its contested file")),
    ).toBe(true);
  });

  it("derives a seam-first phase followed by parallel implementation modules", () => {
    const constrained = applyWorkBlockSeamDependencies(
      decomposition.modules.map((module) => ({ name: module.name, depends_on: [] })),
      decomposition,
      seed,
    );
    const byName = new Map(constrained.map((module) => [module.name, module]));

    expect(byName.get("shared-contract")?.depends_on).toEqual([]);
    // Every block on the contested file is gated behind the one preparer — the
    // aggregated seam reaches all three at once.
    expect(byName.get("refactor-a")?.depends_on).toEqual(["shared-contract"]);
    expect(byName.get("refactor-b")?.depends_on).toEqual(["shared-contract"]);
    expect(byName.get("refactor-c")?.depends_on).toEqual(["shared-contract"]);

    const cut = derivePhaseCut(constrained);
    expect(cut.phases).toEqual([
      { ordinal: 0, name: "foundations", modules: ["shared-contract"] },
      {
        ordinal: 1,
        name: "integration",
        modules: ["refactor-a", "refactor-b", "refactor-c"],
      },
    ]);
  });
});

// ── End-to-end over the REAL auditor contract fixture ────────────────────────
// The fixture's seams are derived by the same `deriveWorkBlockSeams` the two
// findings-draw producers call, so this drives the gate with producer-shaped
// input rather than a hand-written seam. Before the per-file seam contract the
// fixture carried `work_block_seams: []` and nothing here ran at all.

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "auditor-contract-audit-findings.json",
    ),
    "utf8",
  ),
) as {
  work_blocks: Array<{ id: string; owned_files: string[] }>;
  work_block_seams: Array<{ id: string; file: string; block_ids: string[] }>;
};

describe("Path-A seam planning over the auditor contract fixture", () => {
  const seam = FIXTURE.work_block_seams[0]!;

  it("derives exactly one contested-file seam from the fixture's blocks", () => {
    expect(FIXTURE.work_block_seams).toHaveLength(1);
    expect(seam.file).toBe("src/api/auth.ts");
    expect(seam.block_ids).toEqual(["block-1", "block-2"]);
  });

  /** The decomposition a real run must produce for this seed to pass the gate. */
  const realisticDecomposition = {
    modules: [
      {
        name: "auth-contract",
        file_scope: [seam.file],
        source_work_block_ids: [],
        prepares_seam_ids: [seam.id],
      },
      {
        name: "auth-expiry",
        file_scope: ["src/api/auth.ts"],
        source_work_block_ids: ["block-1"],
        prepares_seam_ids: [],
      },
      {
        name: "session-coverage",
        file_scope: ["src/lib/session.ts"],
        source_work_block_ids: ["block-2"],
        prepares_seam_ids: [],
      },
      {
        name: "invoice-status",
        file_scope: ["src/billing/invoice.ts"],
        source_work_block_ids: ["block-3"],
        prepares_seam_ids: [],
      },
    ],
  };

  it("accepts a decomposition that prepares the contested file", () => {
    expect(
      validateWorkBlockSeamPreparation(FIXTURE, realisticDecomposition),
    ).toEqual([]);
  });

  it("refuses the same decomposition once the preparer is removed", () => {
    const issues = validateWorkBlockSeamPreparation(FIXTURE, {
      modules: realisticDecomposition.modules.filter(
        (module) => module.name !== "auth-contract",
      ),
    });
    expect(issues.some((issue) => issue.message.includes("exactly one module"))).toBe(
      true,
    );
  });

  it("gates both contesting blocks behind the preparer, leaving the third free", () => {
    const constrained = applyWorkBlockSeamDependencies(
      realisticDecomposition.modules.map((module) => ({
        name: module.name,
        depends_on: [],
      })),
      realisticDecomposition,
      FIXTURE,
    );
    const byName = new Map(constrained.map((module) => [module.name, module]));

    expect(byName.get("auth-expiry")?.depends_on).toEqual(["auth-contract"]);
    expect(byName.get("session-coverage")?.depends_on).toEqual(["auth-contract"]);
    // block-3 does not touch the contested file, so it stays parallel-safe.
    expect(byName.get("invoice-status")?.depends_on).toEqual([]);

    expect(derivePhaseCut(constrained).phases).toEqual([
      {
        ordinal: 0,
        name: "foundations",
        modules: ["auth-contract", "invoice-status"],
      },
      {
        ordinal: 1,
        name: "integration",
        modules: ["auth-expiry", "session-coverage"],
      },
    ]);
  });
});
