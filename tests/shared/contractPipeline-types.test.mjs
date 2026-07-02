/**
 * Type-level and runtime tests for contract-pipeline type extensions (N-S05):
 *   - ImplementationDAGNode enriched metadata fields
 *   - SeamNegotiationRecord / AgentSeam / SeamRole
 *   - ObligationEntry priority + source fields
 */

import { test, expect, describe, it } from "vitest";

const {
  CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
} = await import("../../src/shared/types/contractPipeline.ts");

// ── ImplementationDAGNode enriched metadata ───────────────────────────────────

describe("ImplementationDAGNode accepts enriched metadata fields", () => {
  it("node with all optional metadata fields is well-formed", () => {
    /** @type {import('../../src/shared/types/contractPipeline.ts').ImplementationDAGNode} */
    const node = {
      id: "N-001",
      title: "Add seam types",
      description: "Adds AgentSeam and SeamNegotiationRecord",
      satisfies_obligations: ["OBL-001"],
      depends_on: [],
      verification_obligation_ids: ["VOBJ-001"],
      targeted_commands: ["npm run build"],
      status: "pending",
      affected_files: ["packages/shared/src/types/contractPipeline.ts"],
      read_scope: ["packages/shared/src/types/finding.ts"],
      lens: "architecture",
      severity: "medium",
      preconditions: ["shared package builds clean"],
      expected_changes: ["SeamNegotiationRecord exported from contractPipeline.ts"],
      verification: ["npm run check passes with no errors"],
    };

    expect(node.id).toBe("N-001");
    expect(node.affected_files).toEqual(["packages/shared/src/types/contractPipeline.ts"]);
    expect(node.lens).toBe("architecture");
    expect(node.severity).toBe("medium");
    expect(node.preconditions).toEqual(["shared package builds clean"]);
    expect(node.expected_changes).toEqual(["SeamNegotiationRecord exported from contractPipeline.ts"]);
    expect(node.verification).toEqual(["npm run check passes with no errors"]);
  });

  it("node without optional metadata fields is still valid", () => {
    /** @type {import('../../src/shared/types/contractPipeline.ts').ImplementationDAGNode} */
    const node = {
      id: "N-002",
      title: "Minimal node",
      description: "No optional fields",
      satisfies_obligations: [],
      depends_on: [],
      verification_obligation_ids: [],
      targeted_commands: [],
      status: "pending",
    };

    expect(node.id).toBe("N-002");
    expect(node.affected_files).toBe(undefined);
    expect(node.read_scope).toBe(undefined);
    expect(node.lens).toBe(undefined);
    expect(node.severity).toBe(undefined);
    expect(node.preconditions).toBe(undefined);
    expect(node.expected_changes).toBe(undefined);
    expect(node.verification).toBe(undefined);
  });
});

// ── SeamNegotiationRecord round-trip ─────────────────────────────────────────

describe("SeamNegotiationRecord round-trips through JSON", () => {
  it("full record with multiple AgentSeam entries serializes and deserializes", () => {
    /** @type {import('../../src/shared/types/contractPipeline.ts').SeamNegotiationRecord} */
    const record = {
      contract_version: CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION,
      goal_id: "goal-abc",
      seams: [
        {
          seam_id: "seam-001",
          node_id: "N-001",
          role: "author",
          agent_hint: "claude-code",
          handoff_artifact: ".audit-tools/remediation/seams/N-001-author.json",
          read_artifacts: ["packages/shared/src/types/contractPipeline.ts"],
          write_artifacts: ["packages/shared/src/types/contractPipeline.ts"],
          constraints: ["must not modify unrelated files"],
        },
        {
          seam_id: "seam-002",
          node_id: "N-001",
          role: "reviewer",
          handoff_artifact: ".audit-tools/remediation/seams/N-001-reviewer.json",
          read_artifacts: [".audit-tools/remediation/seams/N-001-author.json"],
          write_artifacts: [".audit-tools/remediation/seams/N-001-reviewer.json"],
          constraints: ["read-only review; no file edits"],
        },
      ],
      created_at: "2026-06-10T00:00:00.000Z",
    };

    const serialized = JSON.stringify(record);
    const deserialized = JSON.parse(serialized);

    expect(deserialized.contract_version).toBe(CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION);
    expect(deserialized.goal_id).toBe("goal-abc");
    expect(deserialized.seams.length).toBe(2);
    expect(deserialized.seams[0].seam_id).toBe("seam-001");
    expect(deserialized.seams[0].role).toBe("author");
    expect(deserialized.seams[0].agent_hint).toBe("claude-code");
    expect(deserialized.seams[1].role).toBe("reviewer");
    expect(deserialized.seams[1].agent_hint).toBe(undefined);
  });

  it("contract_version equals CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION constant", () => {
    expect(CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION).toBe("remediate-code-contract-pipeline/seam-negotiation/v1alpha1");
  });
});

// ── ObligationEntry priority and source fields ────────────────────────────────

describe("ObligationEntry priority and source fields are optional", () => {
  it("ObligationEntry without priority or source is valid", () => {
    /** @type {import('../../src/shared/types/contractPipeline.ts').ObligationEntry} */
    const entry = {
      id: "OBL-001",
      description: "System must handle concurrent writes",
      kind: "invariant",
      depends_on: [],
      status: "pending",
    };

    expect(entry.id).toBe("OBL-001");
    expect(entry.priority).toBe(undefined);
    expect(entry.source).toBe(undefined);
  });

  it("ObligationEntry with priority=1 and source='design_spec' is valid", () => {
    /** @type {import('../../src/shared/types/contractPipeline.ts').ObligationEntry} */
    const entry = {
      id: "OBL-002",
      description: "All exported types must have JSDoc",
      kind: "structural",
      depends_on: ["OBL-001"],
      status: "pending",
      priority: 1,
      source: "design_spec",
    };

    expect(entry.priority).toBe(1);
    expect(entry.source).toBe("design_spec");
  });

  it("all valid source values are accepted", () => {
    /** @type {Array<import('../../src/shared/types/contractPipeline.ts').ObligationEntry['source']>} */
    const validSources = ["design_spec", "critique", "counterexample", "manual"];
    for (const source of validSources) {
      /** @type {import('../../src/shared/types/contractPipeline.ts').ObligationEntry} */
      const entry = {
        id: "OBL-check",
        description: "test",
        kind: "behavioral",
        depends_on: [],
        status: "pending",
        source,
      };
      expect(entry.source).toBe(source);
    }
  });
});
