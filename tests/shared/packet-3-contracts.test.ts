import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IntentEquivalenceVerdictSchema } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";
import {
  RemediationPlanSchema,
  type RemediationPlan,
} from "../../src/remediate/state/types.js";
import {
  promoteImplementationDagToExtractedPlan,
  writePathASeedFromFindings,
} from "../../src/remediate/steps/contractPipeline.js";
import { prepareRemediationHostHandoff } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import {
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  buildAuditFindingsDeliverable,
} from "../../src/shared/index.js";
import { FindingSchema, type Finding } from "../../src/shared/types/finding.js";
import { intakePaths } from "../../src/remediate/intake.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { IntentFiltersSchema } from "../../src/shared/types/intentCheckpoint.js";
import { filterFindingsByCheckpoint } from "../../src/remediate/intent/checkpointFilter.js";

describe("Packet 3 Contracts & Schemas", () => {
  describe("FindingSchema field preservation & validation (O46, M47)", () => {
    const baseFinding = {
      id: "finding-packet-3-01",
      title: "Test finding title",
      description: "Test finding description",
      severity: "high" as const,
      confidence: "high" as const,
      category: "correctness",
      lens: "correctness" as const,
      summary: "Test finding summary",
      affected_files: [{ path: "src/index.ts" }],
      evidence: ["src/index.ts:10"],
    };

    it("preserves concrete_change, preconditions, expected_changes, addresses_counterexamples", () => {
      const findingData = {
        ...baseFinding,
        concrete_change: "Replace oldHelper() with newHelper()",
        preconditions: ["precondition 1", "precondition 2"],
        expected_changes: "Changes to src/index.ts to use newHelper",
        addresses_counterexamples: ["counterexample A", "counterexample B"],
      };

      const parsed = FindingSchema.parse(findingData);

      expect(parsed.concrete_change).toBe("Replace oldHelper() with newHelper()");
      expect(parsed.preconditions).toEqual(["precondition 1", "precondition 2"]);
      expect(parsed.expected_changes).toBe("Changes to src/index.ts to use newHelper");
      expect(parsed.addresses_counterexamples).toEqual(["counterexample A", "counterexample B"]);
    });

    it("accepts legacy findings without optional fields", () => {
      const legacyFinding = { ...baseFinding };
      const parsed = FindingSchema.parse(legacyFinding);

      expect(parsed.concrete_change).toBeUndefined();
      expect(parsed.preconditions).toBeUndefined();
      expect(parsed.expected_changes).toBeUndefined();
      expect(parsed.addresses_counterexamples).toBeUndefined();
    });

    it("fails when concrete_change is malformed", () => {
      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          concrete_change: 12345,
        }),
      ).toThrow();

      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          concrete_change: ["not", "a", "string"],
        }),
      ).toThrow();
    });

    it("fails when preconditions is malformed", () => {
      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          preconditions: "not-an-array",
        }),
      ).toThrow();

      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          preconditions: [1, 2, 3],
        }),
      ).toThrow();
    });

    it("fails when expected_changes is malformed", () => {
      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          expected_changes: { not: "a string" },
        }),
      ).toThrow();

      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          expected_changes: 42,
        }),
      ).toThrow();
    });

    it("fails when addresses_counterexamples is malformed", () => {
      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          addresses_counterexamples: "not-an-array",
        }),
      ).toThrow();

      expect(() =>
        FindingSchema.parse({
          ...baseFinding,
          addresses_counterexamples: [true, false],
        }),
      ).toThrow();
    });
  });

  describe("Report promotion preserves finding fields (M47)", () => {
    it("preserves fields during fresh implementation DAG promotion (Path A)", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "packet3-promote-a-"));
      try {
        await writeContractArtifact(artifactsDir, "obligation_ledger", {
          contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
          goal_id: "G1",
          obligations: [
            {
              id: "OBL-1",
              description: "Correctness obligation",
              kind: "behavioral",
              depends_on: [],
              status: "pending",
            },
          ],
          created_at: new Date().toISOString(),
        });

        await writeContractArtifact(artifactsDir, "implementation_dag", {
          contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
          goal_id: "G1",
          nodes: [
            {
              id: "CP-001",
              title: "Task 1",
              description: "Do first task",
              satisfies_obligations: ["OBL-1"],
              depends_on: [],
              verification_obligation_ids: [],
              targeted_commands: [],
              status: "pending",
              concrete_change: "Modify foo to handle null",
              preconditions: ["foo is not called concurrently"],
              expected_changes: "foo returns empty string on null",
              addresses_counterexamples: ["input: null -> crash"],
            },
          ],
          edges: [],
          created_at: new Date().toISOString(),
        });

        await promoteImplementationDagToExtractedPlan(artifactsDir);

        const paths = intakePaths(artifactsDir);
        const plan = JSON.parse(await readFile(paths.extractedPlan, "utf8"));

        expect(plan.findings).toBeDefined();
        expect(plan.findings.length).toBe(1);
        const finding = plan.findings[0];
        expect(finding.concrete_change).toBe("Modify foo to handle null");
        expect(finding.preconditions).toEqual(["foo is not called concurrently"]);
        expect(finding.expected_changes).toBe("foo returns empty string on null");
        expect(finding.addresses_counterexamples).toEqual(["input: null -> crash"]);
      } finally {
        await rm(artifactsDir, { recursive: true, force: true });
      }
    });

    it("preserves fields during Path A seed promotion from audit findings", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "packet3-promote-seed-"));
      const testDir = await mkdtemp(join(tmpdir(), "packet3-test-seed-"));
      try {
        const auditFindingsReport = buildAuditFindingsDeliverable(
          [
            {
              id: "F-1",
              title: "Fix null check in handler",
              category: "correctness",
              severity: "high",
              confidence: "high",
              lens: "correctness",
              summary: "Null check missing",
              affected_files: [{ path: "src/one.ts" }],
              evidence: ["src/one.ts:10"],
              concrete_change: "Add null check in handler",
              preconditions: ["handler invoked with undefined payload"],
              expected_changes: "Return 400 instead of 500 on undefined",
              addresses_counterexamples: ["POST {} -> unhandled exception"],
            } as Finding,
          ],
          null,
        );

        const reportPath = join(testDir, "audit-findings.json");
        await writeFile(reportPath, JSON.stringify(auditFindingsReport, null, 2), "utf8");
        await writePathASeedFromFindings(artifactsDir, reportPath, auditFindingsReport);

        await writeContractArtifact(artifactsDir, "implementation_dag", {
          contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
          goal_id: "G1",
          nodes: [
            {
              id: "N1",
              title: "Implement F-1",
              description: "Implement handler fix",
              satisfies_obligations: [],
              depends_on: [],
              verification_obligation_ids: [],
              targeted_commands: [],
              status: "pending",
              source_finding_ids: ["F-1"],
              // Node provides updated expected_changes
              expected_changes: "Return 400 Bad Request with json error body",
            },
          ],
          edges: [],
          created_at: new Date().toISOString(),
        });

        await promoteImplementationDagToExtractedPlan(artifactsDir, testDir);

        const paths = intakePaths(artifactsDir);
        const plan = JSON.parse(await readFile(paths.extractedPlan, "utf8"));
        expect(plan.findings).toHaveLength(1);
        const finding = plan.findings[0];
        expect(finding.id).toBe("F-1");
        expect(finding.concrete_change).toBe("Add null check in handler");
        expect(finding.preconditions).toEqual(["handler invoked with undefined payload"]);
        expect(finding.expected_changes).toBe("Return 400 Bad Request with json error body");
        expect(finding.addresses_counterexamples).toEqual(["POST {} -> unhandled exception"]);
      } finally {
        await rm(artifactsDir, { recursive: true, force: true });
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("uses explicit DAG fields over source findings during seed promotion", async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "packet3-promote-node-"));
      const testDir = await mkdtemp(join(tmpdir(), "packet3-test-node-"));
      try {
        const auditFindingsReport = buildAuditFindingsDeliverable(
          [
            {
              id: "F-2",
              title: "Fix concurrent handler",
              category: "correctness",
              severity: "high",
              confidence: "high",
              lens: "correctness",
              summary: "Concurrent mutation can lose data",
              affected_files: [{ path: "src/two.ts" }],
              evidence: ["src/two.ts:10"],
              concrete_change: "Add a lock around updates",
              preconditions: ["Source precondition"],
              expected_changes: "Source outcome",
              addresses_counterexamples: ["Source counterexample"],
            } as Finding,
          ],
          null,
        );
        const reportPath = join(testDir, "audit-findings.json");
        await writeFile(reportPath, JSON.stringify(auditFindingsReport, null, 2), "utf8");
        await writePathASeedFromFindings(artifactsDir, reportPath, auditFindingsReport);
        await writeContractArtifact(artifactsDir, "implementation_dag", {
          contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
          goal_id: "G2",
          nodes: [
            {
              id: "N2",
              title: "Implement F-2",
              description: "Generic handler fix",
              concrete_change: "Use atomic compare-and-swap",
              preconditions: ["DAG precondition"],
              expected_changes: "DAG outcome",
              addresses_counterexamples: ["DAG counterexample"],
              satisfies_obligations: [],
              depends_on: [],
              verification_obligation_ids: [],
              targeted_commands: [],
              status: "pending",
              source_finding_ids: ["F-2"],
            },
          ],
          edges: [],
          created_at: new Date().toISOString(),
        });

        await promoteImplementationDagToExtractedPlan(artifactsDir, testDir);

        const plan = JSON.parse(await readFile(intakePaths(artifactsDir).extractedPlan, "utf8"));
        expect(plan.findings).toHaveLength(1);
        const finding = plan.findings[0];
        expect(finding.concrete_change).toBe("Use atomic compare-and-swap");
        expect(finding.preconditions).toEqual(["DAG precondition"]);
        expect(finding.expected_changes).toBe("DAG outcome");
        expect(finding.addresses_counterexamples).toEqual(["DAG counterexample"]);
      } finally {
        await rm(artifactsDir, { recursive: true, force: true });
        await rm(testDir, { recursive: true, force: true });
      }
    });
  });

  describe("Assignment construction and host workload serialization (M47)", () => {
    it("round-trips all four finding fields through host handoff workload serialization", async () => {
      const root = await mkdtemp(join(tmpdir(), "packet3-workload-root-"));
      const artifactsDir = join(root, ".audit-tools");
      const runId = "run-packet-3-test";
      try {
        const state = {
          contract_version: "remediate-code-state/v1alpha1",
          status: "implementing",
          plan: {
            plan_id: runId,
            findings: [
              {
                id: "F-100",
                title: "Fix null check",
                category: "correctness",
                severity: "high" as const,
                confidence: "high" as const,
                lens: "correctness" as const,
                summary: "Fix null check in src/a.ts",
                affected_files: [{ path: "src/a.ts" }],
                evidence: ["src/a.ts:5"],
                concrete_change: "Add null safety guard before accessing member",
                preconditions: ["Object can be null or undefined"],
                expected_changes: "Guarded property access returns fallback",
                addresses_counterexamples: ["test(null) threw TypeError"],
              },
            ],
            blocks: [
              {
                block_id: "block-1",
                items: ["F-100"],
                parallel_safe: true,
                dependencies: [],
                touched_files: ["src/a.ts"],
                targeted_commands: ['node -e "process.exit(0)"'],
                phase_ordinal: 0,
                token_estimate: 50,
              },
            ],
            project_type: "typescript",
            candidate_closing_actions: ["none" as const],
          },
          items: {
            "F-100": {
              finding_id: "F-100",
              block_id: "block-1",
              status: "pending",
            },
          },
        };

        const result = await prepareRemediationHostHandoff({
          root,
          artifactsDir,
          runId,
          baselineCommit: "0".repeat(40),
          state,
        });

        expect(typeof result).toBe("object");
        if (typeof result !== "object" || !("workload_path" in result)) {
          throw new Error("Expected PreparedRemediationHostHandoff");
        }

        // Verify workload written to disk
        const workloadContent = await readFile(result.workload_path, "utf8");
        const workload = JSON.parse(workloadContent);

        expect(workload.work_items).toHaveLength(1);
        const workItem = workload.work_items[0];

        // Prompt text embeds the assignment json
        const promptText = workItem.prompt.text;
        expect(promptText).toContain("Assignment:");
        const jsonMatch = promptText.match(/```json\n([\s\S]*?)\n```/);
        expect(jsonMatch).not.toBeNull();

        const assignmentData = JSON.parse(jsonMatch![1]);
        expect(assignmentData.assignments).toHaveLength(1);
        const assignedFinding = assignmentData.assignments[0].finding;

        expect(assignedFinding.id).toBe("F-100");
        expect(assignedFinding.concrete_change).toBe("Add null safety guard before accessing member");
        expect(assignedFinding.preconditions).toEqual(["Object can be null or undefined"]);
        expect(assignedFinding.expected_changes).toBe("Guarded property access returns fallback");
        expect(assignedFinding.addresses_counterexamples).toEqual(["test(null) threw TypeError"]);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(artifactsDir, { recursive: true, force: true });
      }
    });
  });

  describe("IntentEquivalenceVerdictSchema rationale support (O06)", () => {
    const validJudgedPair = {
      prior_hash: "a".repeat(64),
      new_hash: "b".repeat(64),
    };

    it("accepts valid verdict with rationale", () => {
      const verdict = {
        verdict: "equivalent" as const,
        judged_pair: validJudgedPair,
        rationale: "Both implementations preserve the identical postconditions and state transitions.",
      };

      const parsed = IntentEquivalenceVerdictSchema.parse(verdict);
      expect(parsed.verdict).toBe("equivalent");
      expect(parsed.rationale).toBe(
        "Both implementations preserve the identical postconditions and state transitions.",
      );
    });

    it("accepts valid verdict without rationale", () => {
      const verdict = {
        verdict: "changed" as const,
        judged_pair: validJudgedPair,
      };

      const parsed = IntentEquivalenceVerdictSchema.parse(verdict);
      expect(parsed.verdict).toBe("changed");
      expect(parsed.rationale).toBeUndefined();
    });

    it("rejects malformed rationale", () => {
      expect(() =>
        IntentEquivalenceVerdictSchema.parse({
          verdict: "equivalent",
          judged_pair: validJudgedPair,
          rationale: 1234,
        }),
      ).toThrow();

      expect(() =>
        IntentEquivalenceVerdictSchema.parse({
          verdict: "equivalent",
          judged_pair: validJudgedPair,
          rationale: { reason: "not a string" },
        }),
      ).toThrow();
    });

    it("rejects unknown fields under strict schema", () => {
      expect(() =>
        IntentEquivalenceVerdictSchema.parse({
          verdict: "equivalent",
          judged_pair: validJudgedPair,
          unknown_field: true,
        }),
      ).toThrow();
    });
  });

  describe("RemediationPlanSchema themes property removal & filters.themes preservation (O46, M47)", () => {
    const validPlan: RemediationPlan = {
      plan_id: "plan-packet-3-01",
      findings: [],
      blocks: [],
      project_type: "typescript",
      candidate_closing_actions: ["open-pr"],
    };

    it("accepts valid remediation plan without themes", () => {
      const parsed = RemediationPlanSchema.parse(validPlan);
      expect(parsed.plan_id).toBe("plan-packet-3-01");
      expect((parsed as Record<string, unknown>).themes).toBeUndefined();
    });

    it("rejects top-level themes property under strict schema", () => {
      const planWithTopLevelThemes = {
        ...validPlan,
        themes: [
          {
            id: "theme-1",
            title: "Security hardening",
            finding_ids: ["F1"],
          },
        ],
      };

      expect(() => RemediationPlanSchema.parse(planWithTopLevelThemes)).toThrow();
    });

    it("retains and accepts filters.themes feature in IntentFiltersSchema and filter evaluator", () => {
      const filters = IntentFiltersSchema.parse({
        themes: ["theme-auth", "security"],
        severity: ["high", "critical"],
      });
      expect(filters.themes).toEqual(["theme-auth", "security"]);

      const matchingFinding: Finding = {
        id: "F-1",
        title: "Auth bug",
        category: "security",
        severity: "high",
        confidence: "high",
        lens: "security",
        summary: "Auth token leak",
        affected_files: [{ path: "src/auth.ts" }],
        evidence: ["src/auth.ts:1"],
      };

      const nonMatchingFinding: Finding = {
        ...matchingFinding,
        id: "F-2",
        category: "performance",
      };

      const checkpoint = {
        schema_version: 1,
        filters,
      } as const;

      const result = filterFindingsByCheckpoint(
        [matchingFinding, nonMatchingFinding],
        checkpoint as any,
      );

      expect(result.kept.map((f) => f.id)).toEqual(["F-1"]);
      expect(result.droppedIds).toEqual(["F-2"]);
    });
  });
});
