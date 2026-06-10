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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNextContractPipelineStep,
  ingestContractArtifacts,
  validateImplementationDagTraceability,
  promoteImplementationDagToExtractedPlan,
  MAX_CONTRACT_REPAIR_ITERATIONS,
  MAX_DAG_REGENERATION_ATTEMPTS,
} from "../src/steps/contractPipeline.js";
import {
  contractArtifactFilePath,
  contractPipelineDir,
  readContractArtifact,
  type ContractPipelineArtifactName,
} from "../src/contractPipeline/artifactStore.js";
import { intakePaths } from "../src/intake.js";

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
  designNarrative?: string;
  counterexamples?: unknown[];
  judge?: unknown;
} = {}) {
  return {
    goal_spec: {
      contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1",
      goal_id: "G1",
      objective: "Clean up the auth flow.",
      non_goals: [],
      success_criteria: ["Auth flow is cleaned up."],
      source_type: "conversation",
      created_at: CREATED_AT,
    },
    context_bundle: {
      contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1",
      goal_id: "G1",
      entries: [],
      context_summary: "Auth flow context.",
      created_at: CREATED_AT,
    },
    design_spec: {
      contract_version: "remediate-code-contract-pipeline/design-spec/v1alpha1",
      goal_id: "G1",
      design_narrative: overrides.designNarrative ?? "Refactor the auth flow.",
      invariants: [{ id: "INV-1", description: "Sessions stay valid." }],
      affected_paths: ["src/auth.ts"],
      created_at: CREATED_AT,
    },
    conceptual_design_critique: {
      contract_version:
        "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
      goal_id: "G1",
      items: [],
      verdict: "approved",
      created_at: CREATED_AT,
    },
    obligation_ledger: {
      contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
      goal_id: "G1",
      obligations: [
        {
          id: "O-1",
          description: "Auth flow behavior preserved.",
          kind: "behavioral",
          depends_on: [],
          status: "pending",
        },
      ],
      created_at: CREATED_AT,
    },
    contract_assessment_report: {
      contract_version:
        "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
      goal_id: "G1",
      findings: [],
      verdict: "passed",
      created_at: CREATED_AT,
    },
    counterexample: {
      contract_version: "remediate-code-contract-pipeline/counterexample/v1alpha1",
      goal_id: "G1",
      counterexamples: overrides.counterexamples ?? [],
      created_at: CREATED_AT,
    },
    judge_report: overrides.judge ?? {
      contract_version: "remediate-code-contract-pipeline/judge-report/v1alpha1",
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
  "design_spec",
  "conceptual_design_critique",
  "obligation_ledger",
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
    contract_version: "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
    goal_id: "G1",
    nodes: [
      {
        id: "CP-001",
        title: "Refactor auth flow",
        description: "Apply the cleanup.",
        satisfies_obligations: ["O-1"],
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
    for (const name of CHAIN_THROUGH_JUDGE.slice(0, 6)) {
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
    contract_version: "remediate-code-contract-pipeline/judge-report/v1alpha1",
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
      target: "design_spec",
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
    expect(prompt).toMatch(/Contract Repair: design_spec/);
    expect(prompt).toMatch(/session-preservation invariant/);

    const repairStatePath = join(contractPipelineDir(ARTIFACTS_DIR), "repair-state.json");
    const stateAfterFirst = JSON.parse(await readFile(repairStatePath, "utf8"));
    expect(stateAfterFirst.repairs).toHaveLength(1);
    expect(stateAfterFirst.repairs[0].target).toBe("design_spec");

    // Re-invoking without the worker acting re-emits the SAME repair step
    // without recording another iteration.
    const repeatStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(await promptOf(repeatStep!)).toMatch(/Contract Repair: design_spec/);
    const stateAfterRepeat = JSON.parse(await readFile(repairStatePath, "utf8"));
    expect(stateAfterRepeat.repairs).toHaveLength(1);
  });

  it("a completed repair invalidates downstream artifacts and the loop converges", async () => {
    await writeRawChainThroughJudge({ judge: NEEDS_REPAIR_JUDGE });

    // Invocation 1: repair step (also ingests the raw chain into envelopes).
    await buildNextContractPipelineStep(STEP_OPTIONS);

    // The repair worker rewrites design_spec with new content (raw payload).
    await writeRawArtifact(
      "design_spec",
      payloads({ designNarrative: "Refactor the auth flow, preserving sessions across refresh." }).design_spec,
    );

    // Invocation 2: the repaired design is ingested with a new content hash;
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
    const all = payloads({ designNarrative: "Refactor the auth flow, preserving sessions across refresh." });
    for (const name of CHAIN_THROUGH_JUDGE.slice(3)) {
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
          { judge_hash: "prior-judge-1", target: "design_spec", at: CREATED_AT },
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
    expect(prompt).toMatch(/Traceability Errors From the Previous Attempt/);
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
    expect(await promptOf(blocked!)).toMatch(/Failed Traceability/);
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
        contract_version: "remediate-code-contract-pipeline/judge-report/v1alpha1",
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
