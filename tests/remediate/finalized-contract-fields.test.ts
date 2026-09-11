/**
 * The module-contract field vocabulary is stated ONCE.
 *
 * Three hand-written copies of the shape used to exist — the finalizer's object
 * literal, the defensive reader's field-by-field narrowing, and the staleness
 * projection's list — and two of them had already drifted by one field. These
 * pins hold the draws to the single vocabulary in
 * `contractPipeline/finalizedContractFields.ts`, so a field added to one is
 * either present in all of them or fails here by name.
 */
import { describe, it, expect } from "vitest";

import { deriveFinalizedModuleContracts } from "../../src/remediate/contractPipeline/derive.js";
import {
  COPIED_MODULE_CONTRACT_FIELDS,
  DERIVED_MODULE_CONTRACT_FIELDS,
  DERIVABLE_MODULE_CONTRACT_FIELDS,
  FINALIZED_MODULE_CONTRACT_FIELDS,
} from "../../src/remediate/contractPipeline/finalizedContractFields.js";
import { semanticProjection } from "../../src/remediate/contractPipeline/semanticProjection.js";

const COPIED: readonly string[] = [...COPIED_MODULE_CONTRACT_FIELDS].sort();
const DERIVED: readonly string[] = [...DERIVED_MODULE_CONTRACT_FIELDS].sort();

function draft(): Record<string, unknown> {
  return {
    goal_id: "goal-1",
    module_contracts: [
      {
        name: "auth",
        inputs: ["artifact:roster"],
        outputs: ["artifact:session"],
        invariants: ["one session per user"],
        failure_modes: ["expired token"],
        side_effects: ["writes a row"],
        validation_boundary: "rejects an empty token",
        // Non-derivable draft prose finalization must DROP (ordering derives
        // from the artifact-token graph, never from this field).
        neighbor_needs: ["notification"],
        rationale: "why this module exists",
      },
    ],
  };
}

describe("the module-contract field vocabulary is stated once", () => {
  it("partitions into copied and derived, with no field in both", () => {
    expect(COPIED_MODULE_CONTRACT_FIELDS).not.toHaveLength(0);
    expect(DERIVED_MODULE_CONTRACT_FIELDS).not.toHaveLength(0);
    for (const field of DERIVED_MODULE_CONTRACT_FIELDS) {
      expect(COPIED_MODULE_CONTRACT_FIELDS).not.toContain(field);
    }
    expect([...FINALIZED_MODULE_CONTRACT_FIELDS].sort()).toEqual(
      [...COPIED, ...DERIVED].sort(),
    );
  });

  it("the staleness projection narrows to the COPIED half exactly", () => {
    // `seam_adjustments` is DERIVED at finalization and read by no
    // deterministic consumer, so a re-agreed seam must not re-stale the ledger.
    expect([...DERIVABLE_MODULE_CONTRACT_FIELDS].sort()).toEqual(COPIED);
    expect(DERIVABLE_MODULE_CONTRACT_FIELDS).not.toContain("seam_adjustments");
  });

  it("the FINALIZER writes exactly the vocabulary's key set", () => {
    const finalized = deriveFinalizedModuleContracts(draft(), {}, {
      created_at: "2026-01-01T00:00:00.000Z",
    }) as { module_contracts: Record<string, unknown>[] };
    expect(Object.keys(finalized.module_contracts[0]!).sort()).toEqual(
      [...FINALIZED_MODULE_CONTRACT_FIELDS].sort(),
    );
    // The drafts' non-derivable prose is dropped, never carried.
    expect(finalized.module_contracts[0]!).not.toHaveProperty("neighbor_needs");
    expect(finalized.module_contracts[0]!).not.toHaveProperty("rationale");
    // COPIED fields carry the draft's values verbatim.
    const drafted = (draft().module_contracts as Record<string, unknown>[])[0]!;
    for (const field of COPIED_MODULE_CONTRACT_FIELDS) {
      expect(finalized.module_contracts[0]![field]).toEqual(drafted[field]);
    }
  });

  it("the PROJECTION keeps exactly the COPIED fields of a module entry", () => {
    const projected = semanticProjection("finalized_module_contracts", {
      contract_version: "cp-finalized-module-contracts/v1alpha1",
      goal_id: "goal-1",
      module_contracts: [
        {
          ...(draft().module_contracts as Record<string, unknown>[])[0]!,
          seam_adjustments: ["re-agreed"],
          rationale: "prose",
        },
      ],
    }) as { module_contracts: Record<string, unknown>[] };
    expect(Object.keys(projected.module_contracts[0]!).sort()).toEqual(COPIED);
  });

  it("a re-agreed seam alone does NOT re-stale; a changed copied field does", () => {
    const base = {
      goal_id: "goal-1",
      module_contracts: [
        { ...(draft().module_contracts as Record<string, unknown>[])[0]!, seam_adjustments: [] },
      ],
    };
    const seamChanged = {
      ...base,
      module_contracts: [{ ...base.module_contracts[0]!, seam_adjustments: ["re-agreed"] }],
    };
    expect(semanticProjection("finalized_module_contracts", seamChanged)).toEqual(
      semanticProjection("finalized_module_contracts", base),
    );

    const invariantChanged = {
      ...base,
      module_contracts: [
        { ...base.module_contracts[0]!, invariants: ["two sessions per user"] },
      ],
    };
    expect(semanticProjection("finalized_module_contracts", invariantChanged)).not.toEqual(
      semanticProjection("finalized_module_contracts", base),
    );
  });
});
