/**
 * validate-artifact cross-gate parity (MNT — self-check must not lie).
 *
 * Before this fix, `validate-artifact --name X` ran ONLY the per-artifact
 * structural CONTRACT_PIPELINE_VALIDATORS[X] check. The cross-artifact gates
 * (paired-obligation/CE-006, evidence-threading, digest-coverage,
 * reconciliation-derivation, design-spec, DAG-integrity,
 * decomposition-file-scope) ran only in the plural `validate-artifacts` sweep
 * and in `next-step` — so a shape-valid `test_validator_plan` missing its
 * scoped negative could self-validate "ok" and only fail later at next-step
 * (an authoring round-trip). This suite covers:
 *
 *   - evaluateContractPipelineCrossGates (the single-sourced runner both the
 *     plural sweep and the singular self-check now use) in isolation.
 *   - runValidateArtifactAction (the singular command's extracted action) now
 *     loading on-disk siblings and running the same 7 gates, with the
 *     in-flight payload always winning over a stale/absent on-disk sibling.
 *   - the Commander wiring for the new --root / --artifacts-dir options.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  program,
  runValidateArtifactAction,
} from "../../src/remediate/index.js";
import { evaluateContractPipelineCrossGates } from "../../src/remediate/validation/contractPipeline.js";
import {
  writeContractArtifact,
  contractPipelineDir,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "audit-tools/shared";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cvg-cross-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTempFile(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ── evaluateContractPipelineCrossGates — unit ──────────────────────────────────

describe("evaluateContractPipelineCrossGates", () => {
  it("returns 7 sub-arrays, all empty, for an empty payload map (no false-fail on nothing)", () => {
    const result = evaluateContractPipelineCrossGates({
      payloads: new Map(),
      root: "/does/not/matter",
    });
    expect(result).toHaveLength(7);
    for (const gateIssues of result) {
      expect(gateIssues).toEqual([]);
    }
  });

  it("returns all-empty for a single-entry map (a lone artifact can never false-fail)", () => {
    const payloads = new Map<ContractPipelineArtifactName, unknown>([
      [
        "test_validator_plan",
        {
          contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
          goal_id: "G1",
          test_specs: [],
          created_at: CREATED_AT,
        },
      ],
    ]);
    const result = evaluateContractPipelineCrossGates({ payloads, root: "/does/not/matter" });
    expect(result).toHaveLength(7);
    for (const gateIssues of result) {
      expect(gateIssues).toEqual([]);
    }
  });

  it("gate 1 (paired obligations) fails with a CE-006 message for an unscoped negative", () => {
    const payloads = new Map<ContractPipelineArtifactName, unknown>([
      [
        "obligation_ledger",
        {
          obligations: [
            {
              id: "OBL-1",
              description: "an invariant touching writeRecord",
              kind: "invariant",
              change_classification: {
                change_kind: "change",
                touched_symbols: ["writeRecord"],
                determined_by: "touches_existing_symbol",
              },
            },
          ],
        },
      ],
      [
        "test_validator_plan",
        {
          test_specs: [
            {
              obligation_id: "OBL-1",
              assertions: [
                "POSITIVE: writeRecord succeeds and returns the record when in scope",
                // Affirmative repo-wide scan — CE-006 unscoped negative.
                "NEGATIVE: no file anywhere in the repo still calls the old writeRecord path",
              ],
            },
          ],
        },
      ],
    ]);
    const result = evaluateContractPipelineCrossGates({ payloads, root: "/does/not/matter" });
    expect(result).toHaveLength(7);
    const [gate1, ...rest] = result;
    expect(gate1.length).toBeGreaterThan(0);
    expect(gate1.some((i) => i.message.includes("CE-006"))).toBe(true);
    // Nothing else in this narrow payload should be implicated.
    for (const gateIssues of rest) {
      expect(gateIssues).toEqual([]);
    }
  });

  it("a 7-failing-inputs matrix fails all 7 gates, in the fixed canonical order", async () => {
    const root = await makeTempDir(); // plain dir, no git init → gate 7 fails closed

    const obligationLedger = {
      obligations: [
        {
          id: "OBL-X",
          description: "some testable obligation about zzzblorp",
          kind: "invariant",
        },
      ],
    };
    const testValidatorPlan = { test_specs: [] }; // gate 1: OBL-X entirely uncovered

    const assessment = {
      findings: [{ obligation_id: "OBL-X", status: "violated", evidence: [] }],
    }; // gate 2: violated finding with no evidence

    const finalizedContracts = {
      module_contracts: [
        {
          name: "modA",
          inputs: [], // gate 5: empty inputs
          outputs: ["x"],
          invariants: [],
          side_effects: [],
          validation_boundary: "b",
          failure_modes: [],
        },
      ],
    };
    const seamReport = {
      mismatches: [
        {
          seam_id: "S1",
          module_a: "A",
          module_b: "B",
          description: "d",
          resolution: {
            decision: "A",
            // Salient tokens absent from the finalizedContracts corpus above.
            agreed_interface: "a wholly different reconciled seam interface about zzzblorp wiring",
          },
        },
      ],
    }; // gate 4: agreed_interface not reflected downstream

    const dag = {
      nodes: [
        {
          id: "N1",
          satisfies_obligations: ["OBL-NOPE"], // gate 6: dangling reference
          verification_obligation_ids: [],
          addresses_counterexamples: [],
        },
      ],
      edges: [],
    };

    const moduleDecomposition = {
      modules: [{ name: "installer", file_scope: ["src/anything.ts"] }],
    }; // gate 7: unreadable git tree → fails closed

    const payloads = new Map<ContractPipelineArtifactName, unknown>([
      ["goal_spec", { source_type: "structured_audit" }],
      ["obligation_ledger", obligationLedger],
      ["test_validator_plan", testValidatorPlan],
      ["finalized_module_contracts", finalizedContracts],
      ["seam_reconciliation_report", seamReport],
      ["contract_assessment_report", assessment],
      ["implementation_dag", dag],
      ["module_decomposition", moduleDecomposition],
    ]);
    const findingEnumeration = {
      is_enumerable: true,
      findings: [{ id: "F-UNCOVERED" }],
    }; // gate 3: F-UNCOVERED maps to no obligation

    const result = evaluateContractPipelineCrossGates({ payloads, findingEnumeration, root });
    expect(result).toHaveLength(7);
    result.forEach((gateIssues, i) => {
      expect(gateIssues.length, `gate index ${i} expected to fail`).toBeGreaterThan(0);
    });
  });
});

// ── runValidateArtifactAction — the singular self-check command ────────────────

describe("runValidateArtifactAction (validate-artifact --name X self-check)", () => {
  it("RED→GREEN: a structurally-valid test_validator_plan missing its scoped negative now fails (was 'ok' pre-fix)", async () => {
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await writeContractArtifact(artifactsDir, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        {
          id: "OBL-1",
          description: "an invariant touching writeRecord",
          kind: "invariant",
          depends_on: [],
          status: "pending",
          change_classification: {
            change_kind: "change",
            touched_symbols: ["writeRecord"],
            determined_by: "touches_existing_symbol",
          },
        },
      ],
      created_at: CREATED_AT,
    });

    const inFlight = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        {
          obligation_id: "OBL-1",
          name: "writeRecord behavior",
          kind: "invariant",
          assertions: [
            "POSITIVE: writeRecord succeeds and returns the record when in scope",
            // Affirmative repo-wide scan — CE-006 unscoped negative — the exact
            // shape-valid-but-cross-gate-invalid case this fix must catch.
            "NEGATIVE: no file anywhere in the repo still calls the old writeRecord path",
          ],
        },
      ],
    };
    const file = await writeTempFile(repo, "in-flight.json", inFlight);

    const { result, exitCode } = await runValidateArtifactAction({
      name: "test_validator_plan",
      file,
      root: repo,
      artifactsDir,
    });

    expect(result.status).toBe("error");
    expect(exitCode).toBe(1);
    expect((result.issues ?? []).some((i) => i.message.includes("CE-006"))).toBe(true);
  });

  it("in-flight payload overrides a stale/invalid on-disk sibling of the SAME name", async () => {
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await writeContractArtifact(artifactsDir, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        {
          id: "OBL-1",
          description: "an invariant touching writeRecord",
          kind: "invariant",
          depends_on: [],
          status: "pending",
          change_classification: {
            change_kind: "change",
            touched_symbols: ["writeRecord"],
            determined_by: "touches_existing_symbol",
          },
        },
      ],
      created_at: CREATED_AT,
    });
    // Stale on-disk test_validator_plan: positive-only, no negative at all.
    await writeContractArtifact(artifactsDir, "test_validator_plan", {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        {
          obligation_id: "OBL-1",
          name: "writeRecord behavior",
          kind: "invariant",
          assertions: ["POSITIVE: writeRecord succeeds and returns the record when in scope"],
        },
      ],
      created_at: CREATED_AT,
    });

    // Valid in-flight payload: positive + a NEGATIVE properly scoped to writeRecord.
    const inFlight = {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        {
          obligation_id: "OBL-1",
          name: "writeRecord behavior",
          kind: "invariant",
          assertions: [
            "POSITIVE: writeRecord succeeds and returns the record when in scope",
            "NEGATIVE: writeRecord rejects and throws when called out of scope",
          ],
        },
      ],
    };
    const file = await writeTempFile(repo, "in-flight.json", inFlight);

    const { result, exitCode } = await runValidateArtifactAction({
      name: "test_validator_plan",
      file,
      root: repo,
      artifactsDir,
    });

    expect(result.status).toBe("ok");
    expect(exitCode).toBe(0);
  });

  it("partial pipeline: self-checking a lone goal_spec in an empty artifactsDir never false-fails", async () => {
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const goalSpec = {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Improve coverage.",
      non_goals: [],
      success_criteria: ["All tests pass."],
      source_type: "conversation",
      created_at: CREATED_AT,
    };
    const file = await writeTempFile(repo, "goal_spec.json", goalSpec);

    const { result, exitCode } = await runValidateArtifactAction({
      name: "goal_spec",
      file,
      root: repo,
      artifactsDir,
    });

    expect(result.status).toBe("ok");
    expect(result.issue_count).toBe(0);
    expect(exitCode).toBe(0);
  });

  it("a corrupt (malformed-JSON) sibling envelope errors out (exit 2), not an unhandled crash", async () => {
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const cpDir = contractPipelineDir(artifactsDir);
    await mkdir(cpDir, { recursive: true });
    await writeFile(join(cpDir, "obligation_ledger.json"), "{not valid json", "utf8");

    const goalSpec = {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Improve coverage.",
      non_goals: [],
      success_criteria: ["All tests pass."],
      source_type: "conversation",
      created_at: CREATED_AT,
    };
    const file = await writeTempFile(repo, "goal_spec.json", goalSpec);

    const { result, exitCode } = await runValidateArtifactAction({
      name: "goal_spec",
      file,
      root: repo,
      artifactsDir,
    });

    expect(result.status).toBe("error");
    expect(exitCode).toBe(2);
    expect(result.message).toBeDefined();
    expect(result.message).toContain("obligation_ledger.json");
  });
});

// ── Commander wiring ────────────────────────────────────────────────────────────

describe("validate-artifact Commander wiring", () => {
  function validateArtifactCommand() {
    const cmd = program.commands.find((c) => c.name() === "validate-artifact");
    if (!cmd) throw new Error("validate-artifact command is not registered on program");
    return cmd;
  }

  it("registers --root with the '.' default (matches validate-artifacts)", () => {
    const opt = validateArtifactCommand().options.find((o) => o.long === "--root");
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe(".");
  });

  it("registers --artifacts-dir with the '.audit-tools/remediation' default (matches validate-artifacts)", () => {
    const opt = validateArtifactCommand().options.find((o) => o.long === "--artifacts-dir");
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe(".audit-tools/remediation");
  });

  it("still registers --name (required) and --file", () => {
    const cmd = validateArtifactCommand();
    const name = cmd.options.find((o) => o.long === "--name");
    const file = cmd.options.find((o) => o.long === "--file");
    expect(name).toBeDefined();
    expect(name!.required).toBe(true);
    expect(file).toBeDefined();
  });
});
