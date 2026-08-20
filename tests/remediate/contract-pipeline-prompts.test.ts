import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "../../src/remediate/steps/contractPipelinePrompts.js";
import {
  buildNextContractPipelineStep,
  writePathASeedFromFindings,
} from "../../src/remediate/steps/contractPipeline.js";
import { buildAuditFindingsDeliverable, type Finding } from "audit-tools/shared";
import {
  DEPENDENCY_MAP,
  contractPipelineDir,
  writeContractArtifact,
} from "../../src/remediate/contractPipeline/artifactStore.js";

const FAKE_ARTIFACTS_DIR = "/project/.audit-tools/remediation";
const FAKE_REPO_ROOT = "/project";

function cpPath(name: string): string {
  return join(contractPipelineDir(FAKE_ARTIFACTS_DIR), `${name}.json`);
}

/** The artifact keys a rendered "## Required Inputs" block lists, in order. */
function requiredInputKeysIn(prompt: string): string[] {
  const section = prompt.split(/^## Required Inputs$/m)[1];
  if (section === undefined) return [];
  const body = section.split(/^## /m)[0]!;
  return [...body.matchAll(/^- `[^`]+` \(([a-z_]+)\)$/gm)].map((match) => match[1]!);
}

const ALL_PATHS = {
  goal_spec: cpPath("goal_spec"),
  context_bundle: cpPath("context_bundle"),
  module_decomposition: cpPath("module_decomposition"),
  module_contracts: cpPath("module_contracts"),
  seam_reconciliation_report: cpPath("seam_reconciliation_report"),
  finalized_module_contracts: cpPath("finalized_module_contracts"),
  conceptual_design_critique: cpPath("conceptual_design_critique"),
  obligation_ledger: cpPath("obligation_ledger"),
  cyclic_seam_resolution: cpPath("cyclic_seam_resolution"),
  test_validator_plan: cpPath("test_validator_plan"),
  contract_assessment_report: cpPath("contract_assessment_report"),
  counterexample: cpPath("counterexample"),
  judge_report: cpPath("judge_report"),
  implementation_dag: cpPath("implementation_dag"),
  verification_report: cpPath("verification_report"),
} as const;

describe("contract pipeline prompt renderer — all roles", () => {
  const EXPECTED_ROLES = [
    "goal_normalization",
    "context_collection",
    "decomposition",
    "module_contract_drafting",
    "seam_reconciliation",
    "contract_finalization",
    "critique",
    "obligation_ledger",
    "cyclic_seam_resolution",
    "test_validator_plan",
    "assessment",
    "critic",
    "judge",
    "implementation_planning",
    "closing",
  ];

  it("phase order covers all expected roles", () => {
    for (const role of EXPECTED_ROLES) {
      expect(CONTRACT_PIPELINE_PHASE_ORDER).toContain(role);
    }
  });

  for (const role of EXPECTED_ROLES) {
    describe(`role: ${role}`, () => {
      it("renders a prompt that includes the role title", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt.length).toBeGreaterThan(0);
        // Title should appear in the prompt.
        expect(result.prompt).toMatch(/^#\s/m);
      });

      it("prompt includes the exact output path", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt).toContain(result.outputPath);
      });

      it("prompt lists exactly the DEPENDENCY_MAP inputs of its output artifact", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        // C2: the input list is DERIVED from the artifact store's dependency
        // DAG, so a prompt cannot name an input nothing produces and cannot
        // withhold one the DAG added. (The prior assertion only checked that the
        // literal heading appeared — true for every role even with an empty or
        // wrong list, so it could not fail.)
        const expected = DEPENDENCY_MAP[result.role.outputKey];
        expect(requiredInputKeysIn(result.prompt)).toEqual([...expected]);
        for (const key of expected) {
          expect(result.prompt).toContain(ALL_PATHS[key]);
        }
      });

      it("prompt includes stop-after-writing instructions", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt.toLowerCase()).toMatch(/stop after writing/);
      });

      it("prompt includes the expected JSON schema or contract shape", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        // Contract version string should appear in the prompt.
        expect(result.prompt).toContain("contract_version");
      });

      it("includes the repo root workdir note", () => {
        const result = renderContractPipelinePrompt({
          role,
          artifactPaths: ALL_PATHS,
          repoRoot: FAKE_REPO_ROOT,
        });
        expect(result.prompt).toContain(FAKE_REPO_ROOT);
      });
    });
  }
});

describe("contract pipeline prompt renderer — missing required artifacts", () => {
  it("throws a descriptive error when a required artifact path is missing", () => {
    // context_collection requires goal_spec.
    expect(() =>
      renderContractPipelinePrompt({
        role: "context_collection",
        artifactPaths: {
          // goal_spec deliberately omitted
          context_bundle: cpPath("context_bundle"),
        },
      }),
    ).toThrow(/goal_spec/);
  });

  it("throws a descriptive error when the output path is missing", () => {
    // goal_normalization has no required inputs but does need an output path.
    expect(() =>
      renderContractPipelinePrompt({
        role: "goal_normalization",
        artifactPaths: {
          // goal_spec (output) deliberately omitted
          context_bundle: cpPath("context_bundle"),
        },
      }),
    ).toThrow(/goal_spec/);
  });

  it("throws for an unknown role name", () => {
    expect(() =>
      renderContractPipelinePrompt({
        role: "does_not_exist",
        artifactPaths: ALL_PATHS,
      }),
    ).toThrow(/does_not_exist/);
  });
});

describe("adversarial critic and judge roles", () => {
  it("critic consumes the assessment and produces the counterexample report", () => {
    const result = renderContractPipelinePrompt({
      role: "critic",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.outputPath).toBe(ALL_PATHS.counterexample);
    expect(result.prompt).toMatch(/counterexample/i);
    expect(result.prompt).toContain(ALL_PATHS.contract_assessment_report);
  });

  it("judge consumes the counterexample report and emits the classification taxonomy", () => {
    const result = renderContractPipelinePrompt({
      role: "judge",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.outputPath).toBe(ALL_PATHS.judge_report);
    expect(result.prompt).toContain(ALL_PATHS.counterexample);
    expect(result.prompt).toMatch(/accepted \| out_of_scope \| duplicate \| invalid \| residual_risk/);
    expect(result.prompt).toMatch(/repair_directive/);
  });

  it("implementation_planning requires the judge report and states the traceability rule", () => {
    expect(() =>
      renderContractPipelinePrompt({
        role: "implementation_planning",
        artifactPaths: { ...ALL_PATHS, judge_report: undefined },
        repoRoot: FAKE_REPO_ROOT,
      }),
    ).toThrow(/judge_report/);

    const result = renderContractPipelinePrompt({
      role: "implementation_planning",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toMatch(/addresses_counterexamples/);
    expect(result.prompt).toMatch(/Traceability is mandatory/);
  });

  it("phase order runs critic then judge between assessment and implementation planning", () => {
    const order = CONTRACT_PIPELINE_PHASE_ORDER;
    expect(order.indexOf("critic")).toBeGreaterThan(order.indexOf("assessment"));
    expect(order.indexOf("judge")).toBe(order.indexOf("critic") + 1);
    expect(order.indexOf("implementation_planning")).toBe(order.indexOf("judge") + 1);
  });
});

describe("test_validator_plan role", () => {
  it("renders a valid prompt for test_validator_plan", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.outputPath).toBe(ALL_PATHS.test_validator_plan);
  });

  it("prompt includes test_validator_plan output path", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain(ALL_PATHS.test_validator_plan);
  });

  it("prompt includes goal_spec and obligation_ledger as required inputs", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain(ALL_PATHS.goal_spec);
    expect(result.prompt).toContain(ALL_PATHS.obligation_ledger);
  });

  it("prompt contains obligation_id field description", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain("obligation_id");
  });

  it("prompt contains inapplicable_claim description requiring ledger citation", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain("inapplicable_claim");
  });

  it("prompt contains contract_version schema shape", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt).toContain("contract_version");
  });

  it("prompt matches stop after writing instruction", () => {
    const result = renderContractPipelinePrompt({
      role: "test_validator_plan",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    expect(result.prompt.toLowerCase()).toMatch(/stop after writing/i);
  });

  it("CONTRACT_PIPELINE_PHASE_ORDER places test_validator_plan correctly", () => {
    const order = CONTRACT_PIPELINE_PHASE_ORDER;
    const tvpIdx = order.indexOf("test_validator_plan");
    const critiqueIdx = order.indexOf("critique");
    const assessmentIdx = order.indexOf("assessment");
    expect(tvpIdx).toBeGreaterThan(-1);
    expect(assessmentIdx).toBeGreaterThan(tvpIdx);
    expect(tvpIdx).toBeGreaterThan(critiqueIdx);
  });

  it("throws when obligation_ledger path missing for test_validator_plan", () => {
    expect(() =>
      renderContractPipelinePrompt({
        role: "test_validator_plan",
        artifactPaths: { ...ALL_PATHS, obligation_ledger: undefined },
        repoRoot: FAKE_REPO_ROOT,
      }),
    ).toThrow(/obligation_ledger/);
  });
});

describe("contract repair prompt", () => {
  it("renders a full-rewrite prompt for each repair target", () => {
    for (const target of [
      "finalized_module_contracts",
      "obligation_ledger",
      "contract_assessment_report",
    ] as const) {
      const result = renderContractRepairPrompt({
        target,
        instruction: "Address the accepted counterexamples.",
        artifactPaths: ALL_PATHS,
        repoRoot: FAKE_REPO_ROOT,
      });
      expect(result.outputPath).toBe(ALL_PATHS[target]);
      expect(result.prompt).toContain(`Contract Repair: ${target}`);
      expect(result.prompt).toContain("Address the accepted counterexamples.");
      expect(result.prompt).toContain(ALL_PATHS.judge_report);
      expect(result.prompt).toContain("contract_version");
      expect(result.prompt).toContain(FAKE_REPO_ROOT);
    }
  });

  it("throws when the target artifact path is missing", () => {
    expect(() =>
      renderContractRepairPrompt({
        target: "finalized_module_contracts",
        instruction: "Fix.",
        artifactPaths: { ...ALL_PATHS, finalized_module_contracts: undefined },
      }),
    ).toThrow(/finalized_module_contracts/);
  });

  it("throws when contract_assessment_report path is absent (TST-5ddb69b9)", () => {
    // renderContractRepairPrompt validates all requiredInputs before emitting the prompt.
    // contract_assessment_report is one of those required inputs regardless of target.
    expect(() =>
      renderContractRepairPrompt({
        target: "finalized_module_contracts",
        instruction: "Fix contract.",
        artifactPaths: { ...ALL_PATHS, contract_assessment_report: undefined },
      }),
    ).toThrow(/contract_assessment_report/);
  });
});

describe("contract pipeline prompt renderer — isolation", () => {
  it("does not include unrelated artifact paths from other roles", () => {
    // goal_normalization requires no inputs; its prompt should not embed
    // context_bundle or finalized_module_contracts paths in the input section.
    const result = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: ALL_PATHS,
    });
    // The output section will reference goal_spec (the output).
    // The required inputs section should say "No artifact inputs required".
    expect(result.prompt).toContain("No artifact inputs required");
  });

  it("source paths are not included when not provided", () => {
    const result = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: ALL_PATHS,
    });
    expect(result.prompt).not.toContain("Source Inputs");
  });

  it("source paths appear when provided", () => {
    const result = renderContractPipelinePrompt({
      role: "goal_normalization",
      artifactPaths: ALL_PATHS,
      sourcePaths: ["/project/.audit-tools/remediation/intake/remediation-brief.md"],
    });
    expect(result.prompt).toContain("Source Inputs");
    expect(result.prompt).toContain("remediation-brief.md");
  });
});

describe("contract pipeline — mandatory independent critic (lane-class-conditional)", () => {
  // Adversarial review phases keyed strictly off phase identity. The judge
  // adjudicates the critic's counterexamples, so it too must be independent of
  // the design author (memory: delegate the judge too). The mandate is
  // LANE-CLASS-conditional, never capability-conditional (design resolution 2,
  // gate-resolved 2026-08-05): one capability-neutral text carries both the
  // mandate and the explicitly-degraded no-subagent fallback on every host.
  for (const role of ["critique", "critic", "judge"] as const) {
    it(`${role} carries the capability-neutral independence MANDATE`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
      });
      expect(result.prompt).toContain("Independent Review — MANDATORY");
      expect(result.prompt).toContain("MUST be executed by an agent that did not author");
      expect(result.prompt).toContain("independent sub-agent");
      // The same text carries the degraded fallback; the retired
      // capability-branch wording must not resurface as a second form.
      expect(result.prompt).toContain("explicitly-degraded fallback");
      expect(result.prompt).not.toContain("degraded to inline self-review");
      expect(result.prompt).not.toContain("This host reported it cannot dispatch");
    });

    it(`${role} at light adversarial depth keeps the proportionate inline self-check floor`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
        adversarialDepth: "light",
      });
      expect(result.prompt).toContain("light inline self-check");
      expect(result.prompt).not.toContain("Independent Review — MANDATORY");
    });
  }

  // The assessment phase is the author's OWN coverage self-assessment, not an
  // adversarial review of someone else's work, so it must NOT carry the
  // independent-critic mandate.
  for (const role of ["assessment"] as const) {
    it(`${role} carries no independent-critic directive`, () => {
      const result = renderContractPipelinePrompt({
        role,
        artifactPaths: ALL_PATHS,
      });
      expect(result.prompt).not.toContain("Independent Review — MANDATORY");
      expect(result.prompt).not.toContain("explicitly-degraded fallback");
    });
  }
});

// ---------------------------------------------------------------------------
// CP-NODE-13 — the prompts the contract-pipeline GATES emit inline.
//
// Two prompts in the pipeline are not rendered by the role renderer above: the
// cyclic-seam resolution step and the seed-digest refusal, both built inside
// the gate that emits them. They carry contract obligations of their own, so
// they are pinned here alongside the rendered roles.
// ---------------------------------------------------------------------------
describe("CP-NODE-13: inline gate prompts", () => {
  const CREATED_AT = "2026-01-01T00:00:00.000Z";
  let tmpDir: string;
  let artifactsDir: string;

  const cyclicLedger = {
    contract_version: "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
    goal_id: "goal-test",
    obligations: [
      { id: "OBL-A", description: "A", kind: "invariant", depends_on: ["OBL-B"], status: "pending" },
      { id: "OBL-B", description: "B", kind: "behavioral", depends_on: ["OBL-A"], status: "pending" },
    ],
    created_at: CREATED_AT,
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cp-node-13-prompts-"));
    artifactsDir = join(tmpDir, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seedThroughCritique(): Promise<void> {
    const base = { goal_id: "goal-test", created_at: CREATED_AT };
    const moduleContract = {
      name: "mod-a",
      inputs: ["x"],
      outputs: ["y"],
      invariants: ["inv"],
      side_effects: [],
      validation_boundary: "validates x",
      failure_modes: [],
    };
    for (const [name, payload] of [
      ["goal_spec", { contract_version: "remediate-code-contract-pipeline/goal-spec/v1alpha1", ...base, objective: "o", non_goals: [], success_criteria: ["s"], source_type: "conversation" }],
      ["context_bundle", { contract_version: "remediate-code-contract-pipeline/context-bundle/v1alpha1", ...base, entries: [], context_summary: "c" }],
      ["module_decomposition", { contract_version: "remediate-code-contract-pipeline/module-decomposition/v1alpha1", ...base, modules: [{ name: "mod-a", responsibilities: "does A", file_scope: [] }] }],
      ["module_contracts", { contract_version: "remediate-code-contract-pipeline/module-contracts/v1alpha1", ...base, module_contracts: [moduleContract] }],
      ["seam_reconciliation_report", { contract_version: "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1", ...base, mismatches: [] }],
      ["finalized_module_contracts", { contract_version: "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1", ...base, module_contracts: [moduleContract] }],
      ["conceptual_design_critique", { contract_version: "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1", ...base, items: [], verdict: "approved" }],
      ["obligation_ledger", cyclicLedger],
    ] as const) {
      await writeContractArtifact(artifactsDir, name, payload);
    }
  }

  it("the cyclic-seam resolution prompt demands BOTH the ledger rewrite and the designated obligation", async () => {
    await seedThroughCritique();
    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "prompt-test",
    });
    const prompt = await readFile(step!.prompt_path, "utf8");

    expect(prompt).toContain("Cyclic Seam Resolution");
    // The record alone is not a break: HEAD's prompt said "Do not edit source
    // files" and never asked for the ledger rewrite the re-check now validates.
    expect(prompt).toContain("Rewrite");
    expect(prompt).toContain("obligation_ledger.input.json");
    expect(prompt).toContain("designated_obligation_id");
    expect(prompt).toMatch(/re-check re-runs cycle detection over the ledger/);

  });

  it("PINS the renderer's known-STALE copy of the same record schema by content hash", () => {
    // The role renderer carries a SECOND, older copy of the cyclic-seam record
    // schema — it has no `designated_obligation_id`, so it describes a record
    // the re-check now rejects. It is NOT the prompt the pipeline dispatches for
    // this phase (the gate above is), and `contractPipelinePrompts.ts` is
    // outside CP-NODE-13's write scope, so it survives as stale documentation.
    //
    // Pinned by CONTENT HASH, deliberately, rather than by asserting the field
    // is absent: an absence assertion is GREEN while the copy is wrong and goes
    // RED the moment someone repairs it — it defends the drift. A hash is red on
    // ANY change in either direction, which is what routes the decision to the
    // file's owner instead of to whoever happens to touch it next.
    const rendered = renderContractPipelinePrompt({
      role: "cyclic_seam_resolution",
      artifactPaths: ALL_PATHS,
      repoRoot: FAKE_REPO_ROOT,
    });
    const schema = rendered.prompt.match(
      /```json\n([\s\S]*?cyclic-seam-resolution\/v1alpha1[\s\S]*?)\n```/,
    )?.[1];
    expect(schema, "the renderer must still emit a cyclic-seam record schema").toBeDefined();
    expect(
      createHash("sha256").update(schema!, "utf8").digest("hex"),
      [
        "The renderer's cyclic_seam_resolution schema changed.",
        "This copy is KNOWN-STALE: it omits `designated_obligation_id`, which the",
        "cycle-break re-check requires, so it documents a record that is rejected.",
        "It is not dispatched (the gate's inline prompt is), and it was outside",
        "CP-NODE-13's write scope.",
        "If you REPAIRED it: good — re-record the hash here and delete this note.",
        "If you changed it for another reason: the staleness above is still open,",
        "so fix it in the same edit rather than re-pinning around it.",
      ].join(" "),
    ).toBe("3eef044a17d85d8eeef02290b30dd02e443102e124731d5cd054d32d7ef4d3a5");
  });

  it("the seed-digest refusal names the mismatched path and the recovery", async () => {
    const report = buildAuditFindingsDeliverable([
      {
        id: "F-1",
        title: "t",
        category: "General",
        severity: "medium",
        confidence: "high",
        lens: "correctness",
        summary: "s",
        affected_files: [{ path: "src/seeded.ts" }],
      } as Finding,
    ]);
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src", "seeded.ts"), "before\n", "utf8");
    const reportPath = join(tmpDir, "audit-findings.json");
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    await writePathASeedFromFindings(artifactsDir, reportPath, report);
    await writeFile(join(tmpDir, "src", "seeded.ts"), "after\n", "utf8");

    const step = await buildNextContractPipelineStep({
      root: tmpDir,
      artifactsDir,
      runId: "prompt-test",
    });
    expect(step?.status).toBe("blocked");
    const prompt = await readFile(step!.prompt_path, "utf8");
    expect(prompt).toContain("Source Content Changed Since the Audit Seed Was Built");
    expect(prompt).toContain("src/seeded.ts");
    expect(prompt).toContain("path_a_seed.json");
  });
});
