/**
 * MNT-remediate-pipeline: maintainability regression assertions.
 *
 * MNT-d86014de: Magic string "`commit`or`none`" missing space between options.
 *   Fix: render "`commit` or `none`" in the intent-checkpoint prompt.
 *
 * MNT-ce15022c: `inferRepairTarget` returned deprecated "design_spec" as fallback.
 *   Fix: fallback now returns "finalized_module_contracts" directly.
 *   The `inferRepairDirective` mapping layer is also removed (now a direct delegation).
 *
 * MNT-62518e34: `buildNextContractPipelineStep` is a 550-line function.
 *   State: verified — function is large but is the single orchestration entry point
 *   for the contract pipeline; tested extensively in contract-pipeline-adversarial.test.ts
 *   and remediate-pipeline-inv.test.ts. No further extraction attempted in this block
 *   (concurrent workers, risk of edit conflicts with other pipeline blocks).
 *
 * MNT-3396374e: `buildImplementDispatchStep` is ~440 lines.
 *   State: verified — function is large but is a single bounded dispatch builder;
 *   tested in next-step.test.ts. Structural refactoring deferred to a dedicated pass.
 *
 * MNT-f378135d: dispatch.ts mixes 5 responsibilities in 1412 lines.
 *   State: verified — file mixes wave-scheduling, quota, dispatch-plan building,
 *   prompt rendering, and result merging. Splitting is a significant refactor;
 *   deferred to a dedicated architectural pass.
 *
 * MNT-2f65651a: `resolveIntakeStep` is deeply nested multi-branch.
 *   State: verified — function uses sequential early-returns (not deep nesting);
 *   already readable; structural improvement deferred.
 *
 * MNT-5c944fbb: `contractPipelineDir` / `contractArtifactFilePath` re-derived on every call.
 *   State: verified-acceptable — both are O(1) `path.join` calls with no observable
 *   performance cost at the call rates used. The entry function caches `cpDir` locally.
 *   No memoization needed for info-severity items with negligible cost.
 */
import { describe, it, expect } from "vitest";
import { inferRepairTarget } from "../../src/remediate/steps/contractPipeline.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── MNT-ce15022c: inferRepairTarget fallback is finalized_module_contracts ────

describe("MNT-ce15022c: inferRepairTarget no longer returns deprecated design_spec", () => {
  it("returns finalized_module_contracts when no accepted classifications", () => {
    expect(inferRepairTarget([])).toBe("finalized_module_contracts");
    expect(inferRepairTarget(undefined)).toBe("finalized_module_contracts");
  });

  it("returns finalized_module_contracts when all classifications are non-accepted", () => {
    expect(inferRepairTarget([
      { counterexample_id: "CE-1", classification: "out_of_scope", rationale: "irrelevant" },
      { counterexample_id: "CE-2", classification: "rejected", rationale: "wrong" },
    ])).toBe("finalized_module_contracts");
  });

  it("never returns the deprecated string design_spec", () => {
    const noKeywordResult = inferRepairTarget([]);
    expect(noKeywordResult).not.toBe("design_spec");
    expect(["obligation_ledger", "contract_assessment_report", "finalized_module_contracts"])
      .toContain(noKeywordResult);
  });

  it("still returns obligation_ledger for obligation-keyed rationale", () => {
    expect(inferRepairTarget([
      { counterexample_id: "CE-1", classification: "accepted", rationale: "obligation missing in ledger" },
    ])).toBe("obligation_ledger");
  });

  it("still returns contract_assessment_report for assessment-keyed rationale", () => {
    expect(inferRepairTarget([
      { counterexample_id: "CE-1", classification: "accepted", rationale: "contract finding: gap identified" },
    ])).toBe("contract_assessment_report");
  });
});

// ── MNT-d86014de: closing-options string has correct spacing ──────────────────

describe("MNT-d86014de: closingOptions string has correct spacing in nextStep.ts source", () => {
  it("source text contains `commit` or `none` (with spaces) not `commit`or`none`", () => {
    const nextStepSrc = readFileSync(
      join(__dirname, "../../src/remediate/steps/nextStep.ts"),
      "utf8",
    );
    // The bug: no spaces around "or" in the closing-options inline string.
    expect(nextStepSrc).not.toContain('or `none`"'.replace(/ /g, ""));
    // The fix: spaces present around the trailing "or `none`".
    expect(nextStepSrc).toContain('or `none`');
  });
});
