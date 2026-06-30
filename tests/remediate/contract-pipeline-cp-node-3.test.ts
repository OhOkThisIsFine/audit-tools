/**
 * CP-NODE-3 failure-mode obligations (security lens). Red-before-green coverage
 * for the contract-pipeline robustness fixes:
 *
 *  - implementation_dag edge referential integrity (edge.from/to must name a
 *    declared node id — a dangling edge would promote into a plan whose block
 *    dependencies cite phantom nodes).
 *  - lean light-review verdict schema_version enforcement (an unversioned or
 *    wrong-version verdict must fail safe toward escalation, never a silent
 *    `clear`).
 *  - rejectionRewriteInstruction honors archiveContractArtifact's originalFree
 *    signal (a failed history move leaves the rejected file in place, so the
 *    host must overwrite it, not Write-fresh-then-find-the-path-occupied).
 */
import { describe, it, expect } from "vitest";
import { validateImplementationDAG } from "../../src/remediate/validation/contractPipeline.js";
import { rejectionRewriteInstruction } from "../../src/remediate/steps/contractPipeline.js";
import {
  interpretLeanLightReviewVerdict,
  LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
} from "../../src/remediate/steps/leanFastPath.js";
import { CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION } from "audit-tools/shared";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function dagWithEdges(edges: Array<Record<string, unknown>>): unknown {
  return {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes: [
      {
        id: "N-1",
        title: "Node 1",
        description: "Does the work.",
        satisfies_obligations: [],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
      {
        id: "N-2",
        title: "Node 2",
        description: "Does more work.",
        satisfies_obligations: [],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
    ],
    edges,
    created_at: CREATED_AT,
  };
}

describe("CP-NODE-3: implementation_dag edge referential integrity", () => {
  it("accepts edges whose from/to reference declared node ids", () => {
    const issues = validateImplementationDAG(
      dagWithEdges([{ from: "N-1", to: "N-2", kind: "dependency" }]),
    );
    expect(issues).toEqual([]);
  });

  it("rejects an edge whose `from` names a non-existent node", () => {
    const issues = validateImplementationDAG(
      dagWithEdges([{ from: "N-GHOST", to: "N-2", kind: "dependency" }]),
    );
    expect(issues.some((i) => /from "N-GHOST" does not reference a declared node id/.test(i.message))).toBe(true);
  });

  it("rejects an edge whose `to` names a non-existent node", () => {
    const issues = validateImplementationDAG(
      dagWithEdges([{ from: "N-1", to: "N-GHOST", kind: "dependency" }]),
    );
    expect(issues.some((i) => /to "N-GHOST" does not reference a declared node id/.test(i.message))).toBe(true);
  });
});

describe("CP-NODE-3: lean light-review verdict schema_version enforcement", () => {
  it("interprets a correctly-versioned `clear` verdict as clear", () => {
    const out = interpretLeanLightReviewVerdict({
      schema_version: LEAN_LIGHT_REVIEW_SCHEMA_VERSION,
      disposition: "clear",
      concerns: [],
    });
    expect(out.disposition).toBe("clear");
  });

  it("escalates a `clear` verdict that omits schema_version (never a silent pass)", () => {
    const out = interpretLeanLightReviewVerdict({
      disposition: "clear",
      concerns: [],
    });
    expect(out.disposition).toBe("escalate");
    expect(out.concerns.join(" ")).toMatch(/schema_version/);
  });

  it("escalates a `clear` verdict carrying a wrong schema_version", () => {
    const out = interpretLeanLightReviewVerdict({
      schema_version: "some-other-contract/v1",
      disposition: "clear",
      concerns: [],
    });
    expect(out.disposition).toBe("escalate");
    expect(out.concerns.join(" ")).toMatch(/schema_version/);
  });
});

describe("CP-NODE-3: rejectionRewriteInstruction honors originalFree", () => {
  it("signposts a fresh Write at the original path when the archive succeeded", () => {
    const msg = rejectionRewriteInstruction({
      archivedPath: "/x/history/implementation_dag.invalid-1.json",
      originalFree: true,
    });
    expect(msg).toContain("/x/history/implementation_dag.invalid-1.json");
    expect(msg).toContain("Write a fresh complete artifact at its original path");
  });

  it("tells the host to overwrite-in-place when the archive FAILED (originalFree:false)", () => {
    const msg = rejectionRewriteInstruction({ originalFree: false });
    expect(msg).toMatch(/could not be archived/i);
    expect(msg).toMatch(/REMAINS at its original path/);
    // It must NOT claim the prior output was archived to a history path.
    expect(msg).not.toMatch(/archived to/);
  });

  it("treats a bare path argument as a successful archive (back-compat)", () => {
    const msg = rejectionRewriteInstruction("/x/history/foo.json");
    expect(msg).toContain("/x/history/foo.json");
    expect(msg).toContain("Write a fresh complete artifact at its original path");
  });
});
