/**
 * Type-level and runtime tests for contract-pipeline type extensions (N-S05):
 *   - ImplementationDAGNode enriched metadata fields
 *   - SeamNegotiationRecord / AgentSeam / SeamRole
 *   - ObligationEntry priority + source fields
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
} = await import("../../src/shared/types/contractPipeline.ts");

// ── ImplementationDAGNode enriched metadata ───────────────────────────────────

test("ImplementationDAGNode accepts enriched metadata fields", async (t) => {
  await t.test("node with all optional metadata fields is well-formed", () => {
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

    assert.equal(node.id, "N-001");
    assert.deepEqual(node.affected_files, ["packages/shared/src/types/contractPipeline.ts"]);
    assert.equal(node.lens, "architecture");
    assert.equal(node.severity, "medium");
    assert.deepEqual(node.preconditions, ["shared package builds clean"]);
    assert.deepEqual(node.expected_changes, ["SeamNegotiationRecord exported from contractPipeline.ts"]);
    assert.deepEqual(node.verification, ["npm run check passes with no errors"]);
  });

  await t.test("node without optional metadata fields is still valid", () => {
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

    assert.equal(node.id, "N-002");
    assert.equal(node.affected_files, undefined);
    assert.equal(node.read_scope, undefined);
    assert.equal(node.lens, undefined);
    assert.equal(node.severity, undefined);
    assert.equal(node.preconditions, undefined);
    assert.equal(node.expected_changes, undefined);
    assert.equal(node.verification, undefined);
  });
});

// ── SeamNegotiationRecord round-trip ─────────────────────────────────────────

test("SeamNegotiationRecord round-trips through JSON", async (t) => {
  await t.test("full record with multiple AgentSeam entries serializes and deserializes", () => {
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

    assert.equal(deserialized.contract_version, CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION);
    assert.equal(deserialized.goal_id, "goal-abc");
    assert.equal(deserialized.seams.length, 2);
    assert.equal(deserialized.seams[0].seam_id, "seam-001");
    assert.equal(deserialized.seams[0].role, "author");
    assert.equal(deserialized.seams[0].agent_hint, "claude-code");
    assert.equal(deserialized.seams[1].role, "reviewer");
    assert.equal(deserialized.seams[1].agent_hint, undefined);
  });

  await t.test("contract_version equals CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION constant", () => {
    assert.equal(
      CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION,
      "remediate-code-contract-pipeline/seam-negotiation/v1alpha1"
    );
  });
});

// ── ObligationEntry priority and source fields ────────────────────────────────

test("ObligationEntry priority and source fields are optional", async (t) => {
  await t.test("ObligationEntry without priority or source is valid", () => {
    /** @type {import('../../src/shared/types/contractPipeline.ts').ObligationEntry} */
    const entry = {
      id: "OBL-001",
      description: "System must handle concurrent writes",
      kind: "invariant",
      depends_on: [],
      status: "pending",
    };

    assert.equal(entry.id, "OBL-001");
    assert.equal(entry.priority, undefined);
    assert.equal(entry.source, undefined);
  });

  await t.test("ObligationEntry with priority=1 and source='design_spec' is valid", () => {
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

    assert.equal(entry.priority, 1);
    assert.equal(entry.source, "design_spec");
  });

  await t.test("all valid source values are accepted", () => {
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
      assert.equal(entry.source, source);
    }
  });
});
