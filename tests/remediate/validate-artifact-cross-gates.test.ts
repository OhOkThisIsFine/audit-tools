/**
 * validate-artifact cross-gate coverage (MNT — self-check must not lie).
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
 *   - evaluateContractPipelineCrossGateOutcomes (the single entry point both
 *     the plural sweep and the singular self-check now use) in isolation.
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
import { evaluateContractPipelineCrossGateOutcomes } from "../../src/remediate/validation/contractPipelineGates.js";
import {
  writeContractArtifact,
  contractPipelineDir,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
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

// ── evaluateContractPipelineCrossGateOutcomes — unit ──────────────────────────

describe("evaluateContractPipelineCrossGateOutcomes", () => {
  it("returns 8 outcomes with empty issues for an empty payload map (no false-fail on nothing)", () => {
    const result = evaluateContractPipelineCrossGateOutcomes({
      payloads: new Map(),
      root: "/does/not/matter",
    });
    expect(result).toHaveLength(8);
    for (const outcome of result) {
      expect(outcome.issues).toEqual([]);
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
    const result = evaluateContractPipelineCrossGateOutcomes({ payloads, root: "/does/not/matter" });
    expect(result).toHaveLength(8);
    for (const outcome of result) {
      expect(outcome.issues).toEqual([]);
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
    const result = evaluateContractPipelineCrossGateOutcomes({ payloads, root: "/does/not/matter" });
    expect(result).toHaveLength(8);
    const pairedObligations = result.find((outcome) => outcome.gate === "paired_obligations")!;
    expect(pairedObligations.issues.length).toBeGreaterThan(0);
    expect(pairedObligations.issues.some((i) => i.message.includes("CE-006"))).toBe(true);
    // Nothing else in this narrow payload should be implicated.
    for (const outcome of result.filter((candidate) => candidate.gate !== "paired_obligations")) {
      expect(outcome.issues).toEqual([]);
    }
  });

  it("gate 5 (design_spec invariant-coverage): a RegExp-metacharacter invariant id does not throw and reports coverage correctly (COR-cca3801c)", () => {
    // Before the fix, invId was interpolated into `new RegExp(...)` unescaped.
    // "INV-(1" is an unbalanced group-open — as a literal RegExp fragment it
    // throws a SyntaxError, which previously aborted the WHOLE cross-gate
    // evaluation (losing all 8 gates' results for the call), not just this one.
    const metaCharId = "INV-(1";

    // The obligation id deliberately does NOT match invId exactly, so
    // coverage must be decided by the word-boundary REGEX branch — the exact
    // mechanism this fix touches — rather than short-circuiting on the
    // `oblId === invId` exact-match check.
    const covered = new Map<ContractPipelineArtifactName, unknown>([
      [
        "finalized_module_contracts",
        { invariants: [{ id: metaCharId }] },
      ],
      [
        "obligation_ledger",
        {
          obligations: [
            {
              id: "OBL-1",
              description: `covers invariant ${metaCharId} explicitly`,
              kind: "invariant",
            },
          ],
        },
      ],
    ]);
    // Must not throw — this call itself is the red/green pin.
    const coveredResult = evaluateContractPipelineCrossGateOutcomes({ payloads: covered, root: "/does/not/matter" });
    expect(coveredResult).toHaveLength(8);
    const designSpecCovered = coveredResult.find((outcome) => outcome.gate === "design_spec")!;
    expect(designSpecCovered.issues).toEqual([]); // description reference via regex → covered, no issue

    const uncovered = new Map<ContractPipelineArtifactName, unknown>([
      [
        "finalized_module_contracts",
        { invariants: [{ id: metaCharId }] },
      ],
      [
        "obligation_ledger",
        {
          obligations: [
            { id: "OBL-UNRELATED", description: "talks about something else entirely", kind: "invariant" },
          ],
        },
      ],
    ]);
    const uncoveredResult = evaluateContractPipelineCrossGateOutcomes({ payloads: uncovered, root: "/does/not/matter" });
    expect(uncoveredResult).toHaveLength(8);
    const designSpecUncovered = uncoveredResult.find((outcome) => outcome.gate === "design_spec")!;
    expect(designSpecUncovered.issues.length).toBeGreaterThan(0);
    expect(designSpecUncovered.issues.some((i) => i.message.includes(metaCharId))).toBe(true);
    // The SyntaxError previously aborted the evaluation entirely; pin that
    // every later gate still ran (empty, not thrown-away) alongside this one.
    for (const gateName of [
      "implementation_dag_integrity",
      "decomposition_file_scope",
      "finalized_module_set_preserved",
    ] as const) {
      const outcome = uncoveredResult.find((candidate) => candidate.gate === gateName)!;
      expect(outcome.issues).toEqual([]);
    }
  });

  it("an 8-failing-inputs matrix fails all 8 gates, in the fixed canonical order", async () => {
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

    // gate 8: the drafts name a module the finalized contracts above dropped
    // (they carry only modA), which is the 7→4 collapse shape.
    const draftedContracts = {
      module_contracts: [{ name: "modA" }, { name: "modB" }],
    };

    const payloads = new Map<ContractPipelineArtifactName, unknown>([
      ["goal_spec", { source_type: "structured_audit" }],
      ["obligation_ledger", obligationLedger],
      ["test_validator_plan", testValidatorPlan],
      ["module_contracts", draftedContracts],
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

    const result = evaluateContractPipelineCrossGateOutcomes({ payloads, findingEnumeration, root });
    expect(result).toHaveLength(8);
    result.forEach((outcome) => {
      expect(outcome.issues.length, `gate ${outcome.gate} expected to fail`).toBeGreaterThan(0);
    });
  });
});

// ── evaluateContractPipelineCrossGateOutcomes — per-gate evaluated/skipped ─────

describe("evaluateContractPipelineCrossGateOutcomes", () => {
  it("returns 8 outcomes, all skipped with a reason, for an empty payload map (nothing evaluated)", () => {
    const result = evaluateContractPipelineCrossGateOutcomes({
      payloads: new Map(),
      root: "/does/not/matter",
    });
    expect(result).toHaveLength(8);
    for (const outcome of result) {
      expect(outcome.evaluated).toBe(false);
      expect(outcome.issues).toEqual([]);
      expect(typeof outcome.reason).toBe("string");
      expect(outcome.reason!.length).toBeGreaterThan(0);
    }
  });

  it("a gate whose input is present and clean records evaluated:true with no issues", () => {
    const payloads = new Map<ContractPipelineArtifactName, unknown>([
      ["obligation_ledger", { obligations: [] }],
    ]);
    const result = evaluateContractPipelineCrossGateOutcomes({ payloads, root: "/does/not/matter" });
    const pairedObligations = result.find((o) => o.gate === "paired_obligations")!;
    expect(pairedObligations.evaluated).toBe(true);
    expect(pairedObligations.issues).toEqual([]);
    expect(pairedObligations.reason).toBeUndefined();
  });

  it("a gate whose input is absent records evaluated:false with a reason (skipped, not passing)", () => {
    const result = evaluateContractPipelineCrossGateOutcomes({
      payloads: new Map(),
      root: "/does/not/matter",
    });
    const reconciliation = result.find((o) => o.gate === "reconciliation_derivation")!;
    expect(reconciliation.evaluated).toBe(false);
    expect(reconciliation.issues).toEqual([]);
    expect(reconciliation.reason).toBe(
      "seam_reconciliation_report payload is absent or malformed (not a record with a mismatches array)",
    );
  });

  it("distinguishability: an empty issues array alone cannot tell 'ran clean' from 'never ran' — evaluated does", () => {
    // Same gate (digest_coverage), same empty `issues`, opposite `evaluated`.
    const evaluatedClean = evaluateContractPipelineCrossGateOutcomes({
      payloads: new Map<ContractPipelineArtifactName, unknown>([
        ["goal_spec", { source_type: "structured_audit" }],
      ]),
      findingEnumeration: { is_enumerable: true, findings: [] },
      root: "/does/not/matter",
    }).find((o) => o.gate === "digest_coverage")!;

    const neverRan = evaluateContractPipelineCrossGateOutcomes({
      payloads: new Map<ContractPipelineArtifactName, unknown>([
        ["goal_spec", { source_type: "conversation" }],
      ]),
      root: "/does/not/matter",
    }).find((o) => o.gate === "digest_coverage")!;

    expect(evaluatedClean.issues).toEqual([]);
    expect(neverRan.issues).toEqual([]);
    expect(evaluatedClean.evaluated).toBe(true);
    expect(neverRan.evaluated).toBe(false);
    expect(neverRan.reason).toBe(
      "source not enumerable — source_type is not structured_audit or mixed",
    );
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

  it("RED→GREEN: judge_report with an accepted counterexample self-validates 'ok' pre-DAG (was falsely 'error')", async () => {
    // The OBL-CO-03 evidence-threading gate fail-closes when a judge accepts a
    // counterexample but no implementation_dag threads it. The DAG is authored
    // AFTER the judge, so at judge-authoring time it cannot exist — the judge
    // author could never satisfy "fix issues until ok". A write-time self-check
    // must not report a defect scoped to a DOWNSTREAM (not-yet-authored) artifact.
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const inFlight = {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "needs_repair",
      classifications: [
        {
          counterexample_id: "CE-1",
          classification: "accepted",
          rationale: "the counterexample exposes a real gap the design must address",
        },
      ],
      repair_directive: {
        target: "finalized_module_contracts",
        instruction: "tighten the session contract to reject the accepted counterexample",
      },
    };
    const file = await writeTempFile(repo, "judge.json", inFlight);

    const { result, exitCode } = await runValidateArtifactAction({
      name: "judge_report",
      file,
      root: repo,
      artifactsDir,
    });

    expect(result.status).toBe("ok");
    expect(exitCode).toBe(0);
    expect(
      (result.issues ?? []).some((i) => i.path.startsWith("implementation_dag")),
    ).toBe(false);
  });

  it("non-weakening: self-checking the implementation_dag itself STILL catches an unthreaded accepted counterexample", async () => {
    // The suppression is phase-scoped to the artifact being authored. When the
    // DAG is the in-flight artifact, an `implementation_dag`-scoped defect is NOT
    // downstream of itself — the promotion-boundary self-check must still fire.
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await writeContractArtifact(artifactsDir, "obligation_ledger", {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        { id: "O-1", description: "a structural boundary", kind: "structural", depends_on: [], status: "pending" },
      ],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "counterexample", {
      contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
      goal_id: "G1",
      counterexamples: [{ id: "CE-1", description: "a real gap" }],
      created_at: CREATED_AT,
    });
    await writeContractArtifact(artifactsDir, "judge_report", {
      contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
      goal_id: "G1",
      verdict: "approved",
      classifications: [
        { counterexample_id: "CE-1", classification: "accepted", rationale: "must be addressed downstream" },
      ],
      created_at: CREATED_AT,
    });
    // In-flight DAG: traceable via O-1 but does NOT thread the accepted CE-1.
    const inFlight = {
      contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
      goal_id: "G1",
      nodes: [
        {
          id: "CP-001",
          title: "Do the structural work",
          description: "Apply the structural boundary change.",
          satisfies_obligations: ["O-1"],
          addresses_counterexamples: [],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ],
      edges: [],
    };
    const file = await writeTempFile(repo, "dag.json", inFlight);

    const { result, exitCode } = await runValidateArtifactAction({
      name: "implementation_dag",
      file,
      root: repo,
      artifactsDir,
    });

    expect(result.status).toBe("error");
    expect(exitCode).toBe(1);
    expect(
      (result.issues ?? []).some((i) => i.path.startsWith("implementation_dag")),
    ).toBe(true);
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
