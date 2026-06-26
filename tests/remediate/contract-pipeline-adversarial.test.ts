/**
 * The adversarial critic → judge → repair loop (WS3). These tests drive
 * buildNextContractPipelineStep the way a host does — one bounded invocation
 * at a time over worker-written RAW payload files — covering ingestion
 * (raw → validated envelope), the clean approved path, a repair cycle that
 * converges via the staleness DAG, the repair-iteration cap, and the
 * implementation_dag traceability gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNextContractPipelineStep,
  ingestContractArtifacts,
  validateImplementationDagTraceability,
  promoteImplementationDagToExtractedPlan,
  inferRepairTarget,
  MAX_CONTRACT_REPAIR_ITERATIONS,
  MAX_DAG_REGENERATION_ATTEMPTS,
} from "../../src/remediate/steps/contractPipeline.js";
import {
  contractArtifactFilePath,
  contractPipelineDir,
  readContractArtifact,
  writeContractArtifact,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  validateContractCitationGrounding,
  enumerateRepoTreePaths,
} from "../../src/remediate/validation/contractPipeline.js";
import type { Finding } from "audit-tools/shared";
import {
  // MNT-7014a745: consume the single-sourced version constants from the
  // validation module rather than re-declaring them (a bump touches one place).
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
  CP_CYCLIC_SEAM_RESOLUTION_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import { intakePaths } from "../../src/remediate/intake.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
} from "audit-tools/shared";

// CP_TEST_VALIDATOR_PLAN_VERSION is not exported from the validation module
// (the source uses the shared CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION);
// keep this single local declaration for the raw-payload fixtures below.
const CP_TEST_VALIDATOR_PLAN_VERSION = "remediate-code-contract-pipeline/test-validator-plan/v1alpha1" as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-cp-adversarial");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const STEP_OPTIONS = {
  root: TEST_DIR,
  artifactsDir: ARTIFACTS_DIR,
  runId: "CONTRACT-TEST",
};

/** Write a RAW worker payload (not an envelope) at the artifact path. */
async function writeRawArtifact(
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<void> {
  const path = contractArtifactFilePath(ARTIFACTS_DIR, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function payloads(overrides: {
  finalizedNarrative?: string;
  counterexamples?: unknown[];
  judge?: unknown;
} = {}) {
  const moduleName = "auth-module";
  return {
    goal_spec: {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Clean up the auth flow.",
      non_goals: [],
      success_criteria: ["Auth flow is cleaned up."],
      source_type: "conversation",
      created_at: CREATED_AT,
    },
    context_bundle: {
      contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
      goal_id: "G1",
      entries: [],
      context_summary: "Auth flow context.",
      created_at: CREATED_AT,
    },
    module_decomposition: {
      contract_version: CP_MODULE_DECOMPOSITION_VERSION,
      goal_id: "G1",
      modules: [{ name: moduleName, responsibilities: "Handles auth.", file_scope: ["src/auth.ts"] }],
      created_at: CREATED_AT,
    },
    module_contracts: {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [{
        name: moduleName,
        inputs: ["credentials"],
        outputs: ["session"],
        invariants: ["INV-1: Sessions stay valid."],
        side_effects: [],
        validation_boundary: "Validates credentials.",
        failure_modes: ["InvalidCredentials"],
        neighbor_needs: [],
      }],
      created_at: CREATED_AT,
    },
    seam_reconciliation_report: {
      contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
      goal_id: "G1",
      mismatches: [],
      created_at: CREATED_AT,
    },
    finalized_module_contracts: {
      contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [{
        name: moduleName,
        inputs: ["credentials"],
        outputs: overrides.finalizedNarrative ? ["session (preserving across refresh: " + overrides.finalizedNarrative + ")"] : ["session"],
        invariants: ["INV-1: Sessions stay valid."],
        side_effects: [],
        validation_boundary: "Validates credentials.",
        failure_modes: ["InvalidCredentials"],
        seam_adjustments: [],
      }],
      created_at: CREATED_AT,
    },
    conceptual_design_critique: {
      contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
      goal_id: "G1",
      items: [],
      verdict: "approved",
      created_at: CREATED_AT,
    },
    obligation_ledger: {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        {
          id: "O-1",
          description: "the session behavior is preserved",
          kind: "behavioral",
          depends_on: [],
          status: "pending",
          // DC-5: a behavior CHANGE touching `session`; its paired negative must be
          // scoped to that symbol (an unscoped repo-wide negative fails the gate).
          change_classification: {
            change_kind: "change",
            touched_symbols: ["session"],
            determined_by: "touches_existing_symbol",
          },
        },
      ],
      created_at: CREATED_AT,
    },
    cyclic_seam_resolution: {
      contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
      goal_id: "G1",
      cycles: [],
      status: "no_cycles",
      created_at: CREATED_AT,
    },
    test_validator_plan: {
      contract_version: CP_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      // O-1 is behavioral (testable): the paired-obligation gate requires a spec
      // asserting both the satisfied path and the failure path before promotion.
      test_specs: [
        {
          obligation_id: "O-1",
          name: "auth flow behavior holds and rejects the failure case",
          kind: "invariant",
          assertions: [
            "returns the preserved session on the satisfied path",
            "rejects the session request on the failure path",
          ],
        },
      ],
      created_at: CREATED_AT,
    },
    contract_assessment_report: {
      contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
      goal_id: "G1",
      findings: [],
      verdict: "passed",
      created_at: CREATED_AT,
    },
    counterexample: {
      contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id: "G1",
      counterexamples: overrides.counterexamples ?? [],
      created_at: CREATED_AT,
    },
    judge_report: overrides.judge ?? {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "approved",
      classifications: [],
      created_at: CREATED_AT,
    },
  };
}

const CHAIN_THROUGH_JUDGE = [
  "goal_spec",
  "context_bundle",
  "module_decomposition",
  "module_contracts",
  "seam_reconciliation_report",
  "finalized_module_contracts",
  "conceptual_design_critique",
  "obligation_ledger",
  "cyclic_seam_resolution",
  "test_validator_plan",
  "contract_assessment_report",
  "counterexample",
  "judge_report",
] as const;

async function writeRawChainThroughJudge(
  overrides: Parameters<typeof payloads>[0] = {},
): Promise<void> {
  const all = payloads(overrides);
  for (const name of CHAIN_THROUGH_JUDGE) {
    await writeRawArtifact(name, all[name]);
  }
}

function traceableDag(nodeOverrides: Record<string, unknown> = {}) {
  return {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes: [
      {
        id: "CP-001",
        title: "Refactor auth flow",
        description: "Apply the cleanup.",
        satisfies_obligations: ["O-1"],
        // Cite a real tracked path so the M-B3 source-grounded citation gate
        // (promotion backstop) grounds this finding against the working tree.
        output_files: ["src/auth.ts"],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
        ...nodeOverrides,
      },
    ],
    edges: [],
    created_at: CREATED_AT,
  };
}

async function promptOf(step: { prompt_path: string }): Promise<string> {
  return readFile(step.prompt_path, "utf8");
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  // The M-B3 source-grounded citation gate enumerates the working tree at
  // STEP_OPTIONS.root via `git ls-files`. Make TEST_DIR its own git repo with
  // the cited path (src/auth.ts) tracked so promoted findings/module contracts
  // that cite it ground (and the gate does not fail closed on an empty tree).
  await mkdir(join(TEST_DIR, "src"), { recursive: true });
  await writeFile(join(TEST_DIR, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  // authFlow.ts gives the symbol corpus a non-path-shaped token (`authflow`) so a
  // bare symbol-only citation can be grounded against a real path segment.
  await writeFile(join(TEST_DIR, "src", "authFlow.ts"), "export const authFlow = 1;\n", "utf8");
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: TEST_DIR, shell: false, encoding: "utf8" });
  git(["init"]);
  git(["config", "user.email", "test@test"]);
  git(["config", "user.name", "test"]);
  git(["add", "src/auth.ts", "src/authFlow.ts"]);
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("ingestion: raw worker payloads become validated envelopes", () => {
  it("wraps a valid raw payload into an envelope with content and dependency hashes", async () => {
    await writeRawArtifact("goal_spec", payloads().goal_spec);

    const result = await ingestContractArtifacts(ARTIFACTS_DIR);

    expect(result.ingested).toContain("goal_spec");
    const envelope = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");
    expect(envelope?.artifact_name).toBe("goal_spec");
    expect(typeof envelope?.content_hash).toBe("string");
    expect((envelope?.payload as { goal_id: string }).goal_id).toBe("G1");
  });

  it("re-emits the producing phase with validation errors for an invalid raw payload", async () => {
    await writeRawArtifact("goal_spec", { goal_id: "G1" }); // missing everything else

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    expect(step?.step_kind).toBe("contract_pipeline");
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Goal Normalization/);
    expect(prompt).toMatch(/Validation Errors From the Previous Attempt/);
    expect(prompt).toMatch(/objective/);
    // The invalid output was archived, not left in place.
    expect(existsSync(contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec"))).toBe(false);
    const history = readdirSync(join(contractPipelineDir(ARTIFACTS_DIR), "history"));
    expect(history.some((f) => f.startsWith("goal_spec.invalid-"))).toBe(true);
  });
});

describe("clean run: approved judge verdict proceeds to implementation planning", () => {
  it("dispatches critic after assessment and judge after the counterexample report", async () => {
    const all = payloads();
    // slice(0, 11) = goal_spec..contract_assessment_report (stop before counterexample)
    for (const name of CHAIN_THROUGH_JUDGE.slice(0, 11)) {
      await writeRawArtifact(name, all[name]);
    }

    const criticStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(await promptOf(criticStep!)).toMatch(/Adversarial Critic/);

    await writeRawArtifact("counterexample", all.counterexample);
    const judgeStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(await promptOf(judgeStep!)).toMatch(/Adversarial Judge/);
  });

  it("emits implementation_planning when the judge approves, with no repair recorded", async () => {
    await writeRawChainThroughJudge();

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
    expect(prompt).not.toMatch(/Repair Cap Reached/);
    expect(
      existsSync(join(contractPipelineDir(ARTIFACTS_DIR), "repair-state.json")),
    ).toBe(false);
  });
});

describe("repair cycle: failing verdict triggers one targeted repair and re-derivation", () => {
  const NEEDS_REPAIR_JUDGE = {
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "G1",
    verdict: "needs_repair",
    classifications: [
      {
        counterexample_id: "CE-1",
        classification: "accepted",
        rationale: "Sessions are invalidated on refresh.",
      },
    ],
    repair_directive: {
      target: "finalized_module_contracts",
      instruction: "Add a session-preservation invariant covering token refresh.",
    },
    created_at: CREATED_AT,
  };

  it("emits a targeted repair step, idempotently per judge report", async () => {
    await writeRawChainThroughJudge({
      counterexamples: [
        {
          id: "CE-1",
          claim: "Sessions survive refresh.",
          reproduction_steps: ["Refresh the token."],
          expected: "Session preserved.",
          actual: "Session dropped.",
          violated_obligation_ids: ["O-1"],
        },
      ],
      judge: NEEDS_REPAIR_JUDGE,
    });

    const repairStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(repairStep!);
    expect(prompt).toMatch(/Contract Repair: finalized_module_contracts/);
    expect(prompt).toMatch(/session-preservation invariant/);

    const repairStatePath = join(contractPipelineDir(ARTIFACTS_DIR), "repair-state.json");
    const stateAfterFirst = JSON.parse(await readFile(repairStatePath, "utf8"));
    expect(stateAfterFirst.repairs).toHaveLength(1);
    expect(stateAfterFirst.repairs[0].target).toBe("finalized_module_contracts");

    // Re-invoking without the worker acting re-emits the SAME repair step
    // without recording another iteration.
    const repeatStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(await promptOf(repeatStep!)).toMatch(/Contract Repair: finalized_module_contracts/);
    const stateAfterRepeat = JSON.parse(await readFile(repairStatePath, "utf8"));
    expect(stateAfterRepeat.repairs).toHaveLength(1);
  });

  it("a completed repair invalidates downstream artifacts and the loop converges", async () => {
    await writeRawChainThroughJudge({ judge: NEEDS_REPAIR_JUDGE });

    // Invocation 1: repair step (also ingests the raw chain into envelopes).
    await buildNextContractPipelineStep(STEP_OPTIONS);

    // The repair worker rewrites finalized_module_contracts with new content (raw payload).
    await writeRawArtifact(
      "finalized_module_contracts",
      payloads({ finalizedNarrative: "session preservation across refresh" }).finalized_module_contracts,
    );

    // Invocation 2: the repaired contracts are ingested with a new content hash;
    // everything downstream goes stale, is archived, and the first missing
    // phase is the design critique re-derivation.
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Conceptual Design Critique/);
    for (const name of [
      "conceptual_design_critique",
      "obligation_ledger",
      "contract_assessment_report",
      "counterexample",
      "judge_report",
    ] as const) {
      expect(existsSync(contractArtifactFilePath(ARTIFACTS_DIR, name))).toBe(false);
    }
    const history = readdirSync(join(contractPipelineDir(ARTIFACTS_DIR), "history"));
    expect(history.some((f) => f.startsWith("judge_report.stale-"))).toBe(true);

    // The workers re-derive the chain; the judge now approves.
    // slice(6) = skip goal_spec, context_bundle, module_decomposition, module_contracts,
    // seam_reconciliation_report, finalized_module_contracts — restart from conceptual_design_critique
    const all = payloads({ finalizedNarrative: "session preservation across refresh" });
    for (const name of CHAIN_THROUGH_JUDGE.slice(6)) {
      await writeRawArtifact(name, all[name]);
    }

    // Invocation 3: approved verdict proceeds to implementation planning.
    const planningStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(await promptOf(planningStep!)).toMatch(/Implementation Planning/);

    // Invocation 4: a traceable DAG promotes to the extracted plan.
    await writeRawArtifact("implementation_dag", traceableDag());
    const done = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(done).toBeNull();
    const plan = JSON.parse(
      await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"),
    );
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0].evidence).toContain("Satisfies contract obligation: O-1");
  });

  it("proceeds with residual risks once the repair cap is exhausted", async () => {
    await writeRawChainThroughJudge({ judge: NEEDS_REPAIR_JUDGE });
    // Two prior repair iterations (distinct judge reports) already happened.
    await mkdir(contractPipelineDir(ARTIFACTS_DIR), { recursive: true });
    await writeFile(
      join(contractPipelineDir(ARTIFACTS_DIR), "repair-state.json"),
      JSON.stringify({
        schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1",
        repairs: [
          { judge_hash: "prior-judge-1", target: "finalized_module_contracts", at: CREATED_AT },
          { judge_hash: "prior-judge-2", target: "obligation_ledger", at: CREATED_AT },
        ],
        dag_regenerations: [],
      }),
      "utf8",
    );
    expect(MAX_CONTRACT_REPAIR_ITERATIONS).toBe(2);

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
    expect(prompt).toMatch(/Repair Cap Reached/);
    expect(prompt).toMatch(/residual risk/i);
  });
});

describe("traceability gate: untraceable implementation_dag nodes never promote", () => {
  it("rejects nodes tracing to no obligation and no accepted counterexample", async () => {
    await writeRawChainThroughJudge();
    await writeRawArtifact(
      "implementation_dag",
      traceableDag({ satisfies_obligations: ["O-UNKNOWN"], addresses_counterexamples: [] }),
    );

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Implementation Planning/);
    // ARC-86b18f1b-2: referential integrity gate fires before (and subsumes) the
    // traceability gate when references are to non-existent obligations.
    expect(prompt).toMatch(/Referential Integrity Errors From the Previous Attempt|Traceability Errors From the Previous Attempt/);
    expect(prompt).toMatch(/CP-001/);
    // No extracted plan was produced and the bad DAG was archived.
    expect(existsSync(intakePaths(ARTIFACTS_DIR).extractedPlan)).toBe(false);
    expect(existsSync(contractArtifactFilePath(ARTIFACTS_DIR, "implementation_dag"))).toBe(false);
  });

  it("blocks after repeated untraceable DAGs instead of looping forever", async () => {
    await writeRawChainThroughJudge();
    expect(MAX_DAG_REGENERATION_ATTEMPTS).toBe(2);

    for (let attempt = 0; attempt < MAX_DAG_REGENERATION_ATTEMPTS; attempt++) {
      await writeRawArtifact(
        "implementation_dag",
        traceableDag({ satisfies_obligations: [], addresses_counterexamples: [] }),
      );
      const step = await buildNextContractPipelineStep(STEP_OPTIONS);
      expect(step?.status).toBe("ready");
    }

    await writeRawArtifact(
      "implementation_dag",
      traceableDag({ satisfies_obligations: [], addresses_counterexamples: [] }),
    );
    const blocked = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(blocked?.status).toBe("blocked");
    // ARC-86b18f1b-2: referential integrity gate fires before and subsumes the
    // traceability gate — both produce a blocked step; the message differs.
    expect(await promptOf(blocked!)).toMatch(/Failed Referential Integrity|Failed Traceability/);
    expect(existsSync(intakePaths(ARTIFACTS_DIR).extractedPlan)).toBe(false);
  });

  it("accepts a node tracing only to a judge-accepted counterexample", async () => {
    await writeRawChainThroughJudge({
      counterexamples: [
        {
          id: "CE-1",
          claim: "Sessions survive refresh.",
          reproduction_steps: ["Refresh."],
          expected: "Preserved.",
          actual: "Dropped.",
          violated_obligation_ids: ["O-1"],
        },
      ],
      judge: {
        contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
        goal_id: "G1",
        verdict: "approved",
        classifications: [
          {
            counterexample_id: "CE-1",
            classification: "accepted",
            rationale: "Real, addressed by a dedicated task.",
          },
        ],
        created_at: CREATED_AT,
      },
    });
    await writeRawArtifact(
      "implementation_dag",
      traceableDag({ satisfies_obligations: [], addresses_counterexamples: ["CE-1"] }),
    );

    const result = await validateImplementationDagTraceability(ARTIFACTS_DIR);
    // Raw files have not been ingested yet in this direct call — ingest first.
    await ingestContractArtifacts(ARTIFACTS_DIR);
    const ingestedResult = await validateImplementationDagTraceability(ARTIFACTS_DIR);
    expect(ingestedResult.ok).toBe(true);
    expect(result.ok).toBe(true); // payload unwrap also handles raw files

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);
    const plan = JSON.parse(
      await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"),
    );
    expect(plan.findings[0].evidence).toContain(
      "Addresses accepted counterexample: CE-1",
    );
  });
});

describe("M-B3: source-grounded citation gate (repo-tree knownPaths)", () => {
  const mkFinding = (over: Partial<Finding>): Finding =>
    ({
      id: "F1",
      title: "t",
      category: "c",
      severity: "medium",
      confidence: "high",
      lens: "security",
      summary: "",
      affected_files: [],
      ...over,
    }) as Finding;

  it("enumerates the working tree via git ls-files (TEST_DIR has src/auth.ts tracked)", () => {
    const known = enumerateRepoTreePaths(TEST_DIR);
    expect(known.has("src/auth.ts")).toBe(true);
  });

  it("passes a finding that cites a real path", () => {
    const result = validateContractCitationGrounding(
      [mkFinding({ affected_files: [{ path: "src/auth.ts" }] })],
      TEST_DIR,
    );
    expect(result.treeReadable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("passes a symbol-only citation to a REAL symbol", () => {
    // No path cited; the summary names the symbol `authFlow`, a real segment of
    // the tracked file src/authFlow.ts.
    const result = validateContractCitationGrounding(
      [mkFinding({ summary: "Tighten the authFlow before refresh." })],
      TEST_DIR,
    );
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("REJECTS a symbol-only citation to a NON-existent symbol (not excused as 'cites no component')", () => {
    const result = validateContractCitationGrounding(
      [mkFinding({ summary: "Refactor nonExistentSymbolXyz before refresh." })],
      TEST_DIR,
    );
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/cites no real component/);
  });

  it("REJECTS a finding whose only cited path does not exist", () => {
    const result = validateContractCitationGrounding(
      [mkFinding({ affected_files: [{ path: "src/does-not-exist.ts" }] })],
      TEST_DIR,
    );
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(1);
  });

  it("fails CLOSED only when the working tree is unreadable/empty", () => {
    // A non-git directory enumerates to an empty set → fail closed.
    const result = validateContractCitationGrounding(
      [mkFinding({ affected_files: [{ path: "src/auth.ts" }] })],
      join(TEST_DIR, "no-such-subdir"),
    );
    expect(result.treeReadable).toBe(false);
    expect(result.issues.filter((i) => i.severity === "error").length).toBeGreaterThan(0);
    expect(result.issues[0].message).toMatch(/could not enumerate the working tree/i);
  });

  it("promotion backstop re-emits implementation_planning when a promoted finding cites a hallucinated path", async () => {
    await writeRawChainThroughJudge();
    const planningStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(await promptOf(planningStep!)).toMatch(/Implementation Planning/);

    // A DAG node whose only output_file does not exist in the working tree, and
    // whose prose names no real symbol.
    await writeRawArtifact(
      "implementation_dag",
      traceableDag({ output_files: ["src/ghost-file-xyz.ts"], description: "do the work" }),
    );
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(step?.status).toBe("ready");
    expect(await promptOf(step!)).toMatch(/Source-Grounded Citation Gate Errors/);
    // The bad DAG was archived and no plan was promoted past the gate.
    expect(existsSync(contractArtifactFilePath(ARTIFACTS_DIR, "implementation_dag"))).toBe(false);
  });
});

describe("design-spec structural gates: critic phase gate checks", () => {
  /** Write all artifacts up to (but not including) the critic artifact. */
  async function writeChainThroughAssessment(
    finalizedModuleContractsOverride?: unknown,
    obligationLedgerOverride?: unknown,
  ): Promise<void> {
    const base = payloads();
    const chainNames = [
      "goal_spec",
      "context_bundle",
      "module_decomposition",
      "module_contracts",
      "seam_reconciliation_report",
      "finalized_module_contracts",
      "conceptual_design_critique",
      "obligation_ledger",
      "cyclic_seam_resolution",
      "test_validator_plan",
      "contract_assessment_report",
    ] as const;
    for (const name of chainNames) {
      if (name === "finalized_module_contracts" && finalizedModuleContractsOverride !== undefined) {
        await writeRawArtifact(name, finalizedModuleContractsOverride);
      } else if (name === "obligation_ledger" && obligationLedgerOverride !== undefined) {
        await writeRawArtifact(name, obligationLedgerOverride);
      } else if (name === "cyclic_seam_resolution") {
        await writeRawArtifact(name, {
          contract_version: CP_CYCLIC_SEAM_RESOLUTION_VERSION,
          goal_id: "G1",
          cycles: [],
          status: "no_cycles",
          created_at: CREATED_AT,
        });
      } else if (name === "test_validator_plan") {
        await writeRawArtifact(name, {
          contract_version: CP_TEST_VALIDATOR_PLAN_VERSION,
          goal_id: "G1",
          test_specs: [],
          created_at: CREATED_AT,
        });
      } else {
        await writeRawArtifact(name, (base as Record<string, unknown>)[name]);
      }
    }
    // Ingest so artifacts are in valid envelope form.
    await ingestContractArtifacts(ARTIFACTS_DIR);
  }

  it("re-emits design phase when finalized_module_contracts has a module missing outputs", async () => {
    const badFinalized = {
      contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [{
        name: "auth-module",
        inputs: ["credentials"],
        outputs: [], // missing outputs — gate error
        invariants: [],
        side_effects: [],
        validation_boundary: "Validates credentials.",
        failure_modes: [],
      }],
      created_at: CREATED_AT,
    };
    await writeChainThroughAssessment(badFinalized);

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    expect(step?.step_kind).toBe("contract_pipeline");
    const prompt = await promptOf(step!);
    // Re-emits the contract_finalization (design) phase
    expect(prompt).toMatch(/Contract Finalization|Finalized Module Contracts/i);
    // Gate error message present
    expect(prompt).toMatch(/Design Structural Gate Errors|outputs/i);
  });

  it("appends N-R21 advisory when circular obligation dependency warning is present", async () => {
    const circularLedger = {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        { id: "O-1", description: "Obligation 1", kind: "behavioral", depends_on: ["O-2"], status: "pending" },
        { id: "O-2", description: "Obligation 2", kind: "behavioral", depends_on: ["O-1"], status: "pending" },
      ],
      created_at: CREATED_AT,
    };
    await writeChainThroughAssessment(undefined, circularLedger);

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    expect(step?.step_kind).toBe("contract_pipeline");
    const prompt = await promptOf(step!);
    // Should emit the critic phase step (not re-emit design)
    expect(prompt).toMatch(/Critic|counterexample/i);
    // Advisory section for circular dependency warning
    expect(prompt).toContain("N-R21");
  });
});

describe("inferRepairTarget: judge repair-directive inference (N-R11)", () => {
  it("defaults to finalized_module_contracts when there are no accepted classifications", () => {
    const result = inferRepairTarget([
      {
        counterexample_id: "CE-1",
        classification: "out_of_scope",
        rationale: "This is out of scope.",
      },
    ]);
    expect(result).toBe("finalized_module_contracts");
  });

  it("defaults to finalized_module_contracts when classifications array is empty", () => {
    expect(inferRepairTarget([])).toBe("finalized_module_contracts");
  });

  it("infers obligation_ledger when accepted rationale contains 'obligation'", async () => {
    // Write all artifacts up to (not including) the judge_report via writeRawChainThroughJudge
    // excluding the judge, then write the judge as a pre-validated envelope (no repair_directive)
    // so the inference path in evaluateJudgeGate is exercised.
    const all = payloads({
      counterexamples: [
        {
          id: "CE-1",
          claim: "Obligation not covered.",
          reproduction_steps: ["Check the ledger."],
          expected: "Obligation present.",
          actual: "Missing.",
          violated_obligation_ids: ["O-1"],
        },
      ],
    });
    for (const name of CHAIN_THROUGH_JUDGE.slice(0, -1)) {
      await writeRawArtifact(name, all[name]);
    }
    // Ingest the raw artifacts so the pipeline has valid envelopes for everything before judge.
    await ingestContractArtifacts(ARTIFACTS_DIR);
    // Write judge as pre-enveloped artifact (bypasses validator, which requires repair_directive).
    await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [
        {
          counterexample_id: "CE-1",
          classification: "accepted",
          rationale: "obligation not covered in the ledger",
        },
      ],
      // no repair_directive — inference should kick in
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Contract Repair: obligation_ledger/);
  });

  it("infers contract_assessment_report when accepted rationale contains 'contract finding'", async () => {
    const all = payloads({
      counterexamples: [
        {
          id: "CE-2",
          claim: "Contract finding unaddressed.",
          reproduction_steps: ["Check assessment."],
          expected: "Finding addressed.",
          actual: "Not addressed.",
          violated_obligation_ids: ["O-1"],
        },
      ],
    });
    for (const name of CHAIN_THROUGH_JUDGE.slice(0, -1)) {
      await writeRawArtifact(name, all[name]);
    }
    await ingestContractArtifacts(ARTIFACTS_DIR);
    await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [
        {
          counterexample_id: "CE-2",
          classification: "accepted",
          rationale: "contract finding unaddressed",
        },
      ],
      // no repair_directive — inference should kick in
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Contract Repair: contract_assessment_report/);
  });

  it("falls back to finalized_module_contracts (design_spec mapped) when no known keyword", async () => {
    const all = payloads({
      counterexamples: [
        {
          id: "CE-3",
          claim: "Sessions are invalidated on refresh.",
          reproduction_steps: ["Refresh the token."],
          expected: "Session preserved.",
          actual: "Session dropped.",
          violated_obligation_ids: ["O-1"],
        },
      ],
    });
    for (const name of CHAIN_THROUGH_JUDGE.slice(0, -1)) {
      await writeRawArtifact(name, all[name]);
    }
    await ingestContractArtifacts(ARTIFACTS_DIR);
    await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [
        {
          counterexample_id: "CE-3",
          classification: "accepted",
          rationale: "Sessions are invalidated on refresh.",
        },
      ],
      // no repair_directive — generic rationale → design_spec → finalized_module_contracts
      created_at: CREATED_AT,
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    expect(prompt).toMatch(/Contract Repair: finalized_module_contracts/);
  });

  it("explicit repair_directive is honored over inference", async () => {
    await writeRawChainThroughJudge({
      counterexamples: [
        {
          id: "CE-4",
          claim: "obligation not covered",
          reproduction_steps: [],
          expected: "covered",
          actual: "missing",
          violated_obligation_ids: ["O-1"],
        },
      ],
      judge: {
        contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
        goal_id: "G1",
        verdict: "needs_repair",
        classifications: [
          {
            counterexample_id: "CE-4",
            classification: "accepted",
            rationale: "obligation not covered",
          },
        ],
        repair_directive: {
          target: "obligation_ledger",
          instruction: "Add the missing obligation entry.",
        },
        created_at: CREATED_AT,
      },
    });

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    // The explicit directive is used as-is (obligation_ledger), not overridden.
    expect(prompt).toMatch(/Contract Repair: obligation_ledger/);
    expect(prompt).toMatch(/Add the missing obligation entry/);
  });

  it("inferRepairTarget: the fallback is finalized_module_contracts (not the deprecated design_spec)", () => {
    // Pure unit check: fallback produces finalized_module_contracts — the post-redesign
    // default — not the deprecated design_spec artifact name.
    expect(inferRepairTarget([])).toBe("finalized_module_contracts");
    expect(
      inferRepairTarget([
        { counterexample_id: "CE-X", classification: "out_of_scope", rationale: "nope" },
      ]),
    ).toBe("finalized_module_contracts");
  });
});
