/**
 * Contract-obligations module gates + derivation
 * (CP-BLOCK-N-contract-obligations).
 *
 * Covers the fail-closed cross-artifact gates, relative-rank model-tier
 * derivation (never a model name), downstream-only repair propagation, and the
 * finding_id → {obligation_ids, node_ids} trace on the promoted extracted plan.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePairedObligations,
  validateEvidenceThreaded,
  validateDigestCoverage,
  validateReconciliationDerivation,
  deriveNodeModelTier,
  deriveNodeModelTierFromNode,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  evaluateContractObligationsPromotionGate,
  evaluatePreCriticStructuralGate,
  promoteImplementationDagToExtractedPlan,
} from "../../src/remediate/steps/contractPipeline.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { intakePaths } from "../../src/remediate/intake.js";
import { writeJsonFile } from "audit-tools/shared";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
} from "audit-tools/shared";
import { scratchDir } from "../helpers/scratch.js";

const CP_SEAM_RECONCILIATION_REPORT_VERSION =
  "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1" as const;
const CP_FINALIZED_MODULE_CONTRACTS_VERSION =
  "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1" as const;

const CREATED_AT = "2026-01-01T00:00:00.000Z";

// ── validatePairedObligations (OBL-CO-01) ─────────────────────────────────────

describe("validatePairedObligations", () => {
  const ledger = (obligations: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations,
    created_at: CREATED_AT,
  });
  const plan = (specs: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "G1",
    test_specs: specs,
    created_at: CREATED_AT,
  });
  // DC-5: a behavior CHANGE obligation classified as touching the symbol `widget`,
  // so its negative half must be SCOPED to `widget` (an unscoped negative fails).
  const changeObl = (kind: "behavioral" | "invariant" = "behavioral") => ({
    id: "O-1",
    description: "widget count stays under the cap",
    kind,
    depends_on: [],
    status: "pending",
    change_classification: {
      change_kind: "change",
      touched_symbols: ["widget"],
      determined_by: "touches_existing_symbol",
    },
  });

  it("passes when a testable change obligation has a positive and a scoped negative", () => {
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["returns the widget on success", "rejects an invalid widget"],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("fails (fail-closed) when a testable obligation has no covering test spec", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("invariant")]),
      plan([]),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues[0].message).toContain("no test spec");
  });

  it("fails when only a positive assertion exists (missing the negative half)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["returns the widget"] }]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(false);
  });

  it("fails when only a (scoped) negative assertion exists (missing the positive half)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["throws on a bad widget"] }]),
    );
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(true);
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(false);
  });

  it("does not require coverage for non-testable (structural) obligations", () => {
    const issues = validatePairedObligations(
      ledger([{ id: "O-1", description: "x", kind: "structural", depends_on: [], status: "pending" }]),
      plan([]),
    );
    expect(issues).toHaveLength(0);
  });

  it("passes with POSITIVE:/NEGATIVE:-labeled assertions whose free text would not match keywords (authoritative label)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          // Neither free text contains a polarity keyword; the labels are
          // authoritative. Both name `widget`, so the negative is scoped.
          assertions: ["POSITIVE: the widget count stays under the cap", "NEGATIVE: the widget count over the cap is caught"],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("treats a POSITIVE: label as authoritative even when the free text matches a negative keyword", () => {
    // "must not exceed N" matches NEGATIVE_ASSERTION_PATTERN, but the POSITIVE:
    // label wins and the keyword regex is skipped for this assertion. With only
    // this one assertion the negative half is therefore missing.
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["POSITIVE: the widget must not exceed N"],
        },
      ]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(false);
  });

  it("recognizes the polarity label with surrounding whitespace and mixed case", () => {
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["  positive : the widget is produced", "\tNegAtIvE: the bad widget path is handled"],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("still fails a one-sided labeled spec (only POSITIVE: labels => negative half missing)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl()]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["POSITIVE: the widget is produced"],
        },
      ]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(false);
  });

  it("accepts an explicit inapplicable_claim as opt-out", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("invariant")]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["n/a"],
          inapplicable_claim: { obligation_id: "O-1", reason: "no code path exists for this in the target" },
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("does not force a pure ADDITION obligation to pair (CE-013)", () => {
    const issues = validatePairedObligations(
      ledger([
        {
          id: "O-1",
          description: "a brand new capability is added",
          kind: "behavioral",
          depends_on: [],
          status: "pending",
          change_classification: { change_kind: "addition", touched_symbols: [], determined_by: "no_existing_symbol" },
        },
      ]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["emits a new counter"] }]),
    );
    expect(issues).toHaveLength(0);
  });
});

// ── validateEvidenceThreaded (OBL-CO-03) ──────────────────────────────────────

describe("validateEvidenceThreaded", () => {
  const judge = (acceptedIds: string[]) => ({
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "G1",
    verdict: acceptedIds.length > 0 ? "needs_repair" : "approved",
    classifications: acceptedIds.map((id) => ({
      counterexample_id: id,
      classification: "accepted",
      rationale: "real",
    })),
    created_at: CREATED_AT,
  });
  const dag = (nodes: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes,
    edges: [],
    created_at: CREATED_AT,
  });

  it("flags a violated assessment finding that carries no evidence", () => {
    const assessment = {
      contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
      goal_id: "G1",
      findings: [{ obligation_id: "O-1", status: "violated", evidence: [], rationale: "r" }],
      verdict: "failed",
      created_at: CREATED_AT,
    };
    const issues = validateEvidenceThreaded(assessment, undefined, undefined);
    expect(issues.some((i) => i.path.includes("evidence"))).toBe(true);
  });

  it("flags an accepted counterexample not threaded into any DAG node", () => {
    const issues = validateEvidenceThreaded(
      undefined,
      judge(["CE-1"]),
      dag([
        {
          id: "N1",
          title: "t",
          description: "d",
          satisfies_obligations: ["O-1"],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ]),
    );
    expect(issues.some((i) => i.message.includes("CE-1"))).toBe(true);
  });

  it("passes when the accepted counterexample is threaded into a node", () => {
    const issues = validateEvidenceThreaded(
      undefined,
      judge(["CE-1"]),
      dag([
        {
          id: "N1",
          title: "t",
          description: "d",
          satisfies_obligations: ["O-1"],
          addresses_counterexamples: ["CE-1"],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("is fail-closed: accepted counterexamples but a missing DAG => violation", () => {
    const issues = validateEvidenceThreaded(undefined, judge(["CE-1"]), undefined);
    expect(issues.some((i) => i.message.includes("CE-1"))).toBe(true);
  });

  it("flags an obligation-satisfying node with an empty description", () => {
    const issues = validateEvidenceThreaded(
      undefined,
      judge([]),
      dag([
        {
          id: "N1",
          title: "t",
          description: "   ",
          satisfies_obligations: ["O-1"],
          depends_on: [],
          verification_obligation_ids: [],
          targeted_commands: [],
          status: "pending",
        },
      ]),
    );
    expect(issues.some((i) => i.path.includes("description"))).toBe(true);
  });
});

// ── validateDigestCoverage (OBL-CO-04, source_type-scoped) ────────────────────

describe("validateDigestCoverage", () => {
  const ledger = (obligations: unknown[]) => ({
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations,
    created_at: CREATED_AT,
  });
  const enumeration = (findings: unknown[], is_enumerable = true) => ({
    is_enumerable,
    findings,
  });

  it("fails for a structured_audit source when a finding maps to no obligation", () => {
    const issues = validateDigestCoverage(
      "structured_audit",
      enumeration([{ id: "FND-1" }, { id: "FND-2" }]),
      ledger([{ id: "O-1", description: "covers FND-1", kind: "behavioral", depends_on: [], status: "pending", source_finding_ids: ["FND-1"] }]),
    );
    expect(issues.some((i) => i.message.includes("FND-2"))).toBe(true);
    expect(issues.some((i) => i.message.includes("FND-1"))).toBe(false);
  });

  it("passes when every enumerated finding maps via source_finding_ids", () => {
    const issues = validateDigestCoverage(
      "structured_audit",
      enumeration([{ id: "FND-1" }]),
      ledger([{ id: "O-1", description: "x", kind: "behavioral", depends_on: [], status: "pending", source_finding_ids: ["FND-1"] }]),
    );
    expect(issues).toHaveLength(0);
  });

  it("maps a finding by word-boundary reference in an obligation description (fallback)", () => {
    const issues = validateDigestCoverage(
      "structured_audit",
      enumeration([{ id: "FND-1" }]),
      ledger([{ id: "O-1", description: "Addresses FND-1 directly.", kind: "behavioral", depends_on: [], status: "pending" }]),
    );
    expect(issues).toHaveLength(0);
  });

  it("passes vacuously for a conversation source (no closed finding set)", () => {
    const issues = validateDigestCoverage(
      "conversation",
      enumeration([{ id: "FND-1" }]),
      ledger([]),
    );
    expect(issues).toHaveLength(0);
  });

  it("passes vacuously when the enumeration is marked is_enumerable:false", () => {
    const issues = validateDigestCoverage(
      "structured_audit",
      enumeration([], false),
      ledger([]),
    );
    expect(issues).toHaveLength(0);
  });
});

// ── validateReconciliationDerivation (OBL-CO-12 / INV-CO-12) ───────────────────

describe("validateReconciliationDerivation", () => {
  const report = (mismatches: unknown[]) => ({
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches,
    created_at: CREATED_AT,
  });
  const finalized = (contracts: unknown[]) => ({
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
    module_contracts: contracts,
    created_at: CREATED_AT,
  });

  it("passes when the agreed interface is derived into a finalized contract", () => {
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "writeRecord returns ack token" },
        },
      ]),
      finalized([
        {
          name: "a",
          inputs: ["record"],
          outputs: ["writeRecord returns ack token"],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("fails (INV-CO-12) when the agreed interface is absent from finalized contracts", () => {
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "writeRecord returns ack token" },
        },
      ]),
      finalized([
        {
          name: "a",
          inputs: ["unrelated"],
          outputs: ["something else entirely"],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
        },
      ]),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues[0].message).toContain("INV-CO-12");
  });

  it("tolerates a faithful paraphrase — filler words and rewording do not fail INV-CO-12", () => {
    // "must"/"an"/"ack" are filler/short; the finalized contract reworded the agreed
    // interface but kept the content terms. The old all-salient-tokens rule failed on
    // "must"; the content-majority rule passes.
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "writeRecord must return an ack token" },
        },
      ]),
      finalized([
        {
          name: "a",
          inputs: ["record"],
          outputs: ["writeRecord returns the acknowledgement token"],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("still fails when most content terms of the agreed interface are absent", () => {
    // Only 1 of 3 content tokens (writeRecord) is reflected; returns/token are gone —
    // below the majority threshold, so INV-CO-12 still fails (fail-closed preserved).
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "writeRecord returns ack token" },
        },
      ]),
      finalized([
        {
          name: "a",
          inputs: ["record"],
          outputs: ["writeRecord accepts a payload"],
          invariants: [],
          side_effects: [],
          validation_boundary: "v",
          failure_modes: [],
        },
      ]),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain("INV-CO-12");
  });

  it("is fail-closed: a reconciled mismatch with no finalized contracts is underived", () => {
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "iface" },
        },
      ]),
      undefined,
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain("INV-CO-12");
  });

  it("passes when there are no mismatches to derive", () => {
    const issues = validateReconciliationDerivation(report([]), finalized([]));
    expect(issues).toHaveLength(0);
  });

  it("derives the agreed interface via seam_adjustments alone (corpus includes seam_adjustments)", () => {
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "writeRecord returns ack token" },
        },
      ]),
      finalized([
        {
          name: "a",
          // The agreed interface text lives ONLY in seam_adjustments; the other
          // fields are unrelated. The gate must still consider it derived.
          inputs: ["unrelated"],
          outputs: ["something else entirely"],
          invariants: [],
          side_effects: [],
          seam_adjustments: ["writeRecord returns ack token"],
          validation_boundary: "v",
          failure_modes: [],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("still fails when the agreed interface appears in no field, including seam_adjustments", () => {
    const issues = validateReconciliationDerivation(
      report([
        {
          seam_id: "S1",
          module_a: "a",
          module_b: "b",
          description: "d",
          resolution: { decision: "A", agreed_interface: "writeRecord returns ack token" },
        },
      ]),
      finalized([
        {
          name: "a",
          inputs: ["unrelated"],
          outputs: ["something else entirely"],
          invariants: [],
          side_effects: [],
          seam_adjustments: ["a totally different adjustment"],
          validation_boundary: "v",
          failure_modes: [],
        },
      ]),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues[0].message).toContain("INV-CO-12");
  });
});

// ── deriveNodeModelTier (relative rank, never a model name) ────────────────────

describe("deriveNodeModelTier", () => {
  it("returns the cheapest rank for a trivial node", () => {
    expect(
      deriveNodeModelTier({
        dependencyCount: 0,
        obligationCount: 1,
        fileScopeSize: 1,
        counterexampleCount: 0,
        highStakesLens: false,
      }),
    ).toBe("small");
  });

  it("returns the middle rank for a moderately complex node", () => {
    expect(
      deriveNodeModelTier({
        dependencyCount: 2,
        obligationCount: 2,
        fileScopeSize: 2,
        counterexampleCount: 0,
        highStakesLens: false,
      }),
    ).toBe("standard");
  });

  it("returns the top rank for a high-complexity node", () => {
    expect(
      deriveNodeModelTier({
        dependencyCount: 3,
        obligationCount: 3,
        fileScopeSize: 5,
        counterexampleCount: 1,
        highStakesLens: true,
      }),
    ).toBe("deep");
  });

  it("only ever returns a relative rank, never a model name", () => {
    const ALLOWED_RANKS = new Set(["small", "standard", "deep"]);
    const ranks = new Set<string>();
    for (let d = 0; d < 6; d++) {
      for (let o = 1; o < 6; o++) {
        ranks.add(
          deriveNodeModelTier({
            dependencyCount: d,
            obligationCount: o,
            fileScopeSize: d,
            counterexampleCount: d % 2,
            highStakesLens: d % 2 === 0,
          }),
        );
      }
    }
    // Universal-membership invariant: every produced rank is one of the three
    // relative ranks — no model name ever leaks. (Asserted as a set-difference so
    // a stray value names itself in the failure rather than hiding in an either-or.)
    const unexpected = [...ranks].filter((r) => !ALLOWED_RANKS.has(r));
    expect(unexpected).toEqual([]);
  });

  it("nudges a high-stakes lens up relative to an otherwise identical node", () => {
    const base = {
      dependencyCount: 1,
      obligationCount: 2,
      fileScopeSize: 2,
      counterexampleCount: 0,
    };
    const low = deriveNodeModelTier({ ...base, highStakesLens: false });
    const high = deriveNodeModelTier({ ...base, highStakesLens: true });
    const order = ["small", "standard", "deep"];
    expect(order.indexOf(high)).toBeGreaterThanOrEqual(order.indexOf(low));
  });

  it("derives the tier from a raw DAG-node payload", () => {
    const tier = deriveNodeModelTierFromNode({
      id: "N1",
      depends_on: ["A", "B", "C"],
      satisfies_obligations: ["O-1", "O-2"],
      verification_obligation_ids: ["O-3"],
      output_files: ["a", "b", "c", "d"],
      addresses_counterexamples: ["CE-1"],
      lens: "security",
    });
    expect(tier).toBe("deep");
  });
});

// ── Promotion gate + extracted-plan trace (integration) ───────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-contract-obligations");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

async function seedChain(): Promise<void> {
  await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Improve.",
    non_goals: [],
    success_criteria: ["Improved."],
    source_type: "conversation",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
    module_contracts: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations: [
      {
        id: "O-1",
        description: "record write stays consistent",
        kind: "behavioral",
        depends_on: [],
        status: "pending",
        // DC-5: a behavior CHANGE touching `record` → its negative must be scoped.
        change_classification: {
          change_kind: "change",
          touched_symbols: ["record"],
          determined_by: "touches_existing_symbol",
        },
      },
    ],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "G1",
    test_specs: [
      {
        obligation_id: "O-1",
        name: "t",
        kind: "unit",
        assertions: ["returns the record on success", "rejects an invalid record"],
      },
    ],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "contract_assessment_report", {
    contract_version: CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
    goal_id: "G1",
    findings: [],
    verdict: "passed",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "judge_report", {
    contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
    goal_id: "G1",
    verdict: "approved",
    classifications: [],
    created_at: CREATED_AT,
  });
}

async function writeDag(nodes: unknown[]): Promise<void> {
  await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
    contract_version: CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
    goal_id: "G1",
    nodes,
    edges: [],
    created_at: CREATED_AT,
  });
}

describe("evaluatePreCriticStructuralGate (S5 pre-adversarial structural floor)", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns null for a structurally-sound chain (the critic only ever sees sound artifacts)", async () => {
    await seedChain();
    expect(await evaluatePreCriticStructuralGate(ARTIFACTS_DIR)).toBeNull();
  });

  it("catches a paired-obligation gap BEFORE the critic and attributes it to test_validator_plan", async () => {
    await seedChain();
    // Positive-only assertion: the negative half is missing for a testable obligation.
    await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        { obligation_id: "O-1", name: "t", kind: "unit", assertions: ["returns the value"] },
      ],
      created_at: CREATED_AT,
    });
    const gate = await evaluatePreCriticStructuralGate(ARTIFACTS_DIR);
    expect(gate).not.toBeNull();
    expect(gate?.phase).toBe("test_validator_plan");
    expect(gate?.errorLines.length).toBeGreaterThan(0);
  });

  it("catches an uncovered enumerated finding (digest coverage) and attributes it to contract_finalization", async () => {
    await seedChain();
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Improve.",
      non_goals: [],
      success_criteria: ["Improved."],
      source_type: "structured_audit",
      created_at: CREATED_AT,
    });
    await writeJsonFile(intakePaths(ARTIFACTS_DIR).findingEnumeration, {
      is_enumerable: true,
      findings: [{ id: "FND-uncovered" }],
    });
    const gate = await evaluatePreCriticStructuralGate(ARTIFACTS_DIR);
    expect(gate).not.toBeNull();
    expect(gate?.phase).toBe("contract_finalization");
  });
});

describe("evaluateContractObligationsPromotionGate + extracted-plan trace", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("passes the gate for a coherent chain", async () => {
    await seedChain();
    await writeDag([
      {
        id: "N1",
        title: "t",
        description: "Implement O-1.",
        satisfies_obligations: ["O-1"],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
    ]);
    const result = await evaluateContractObligationsPromotionGate(ARTIFACTS_DIR);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails the gate when the paired-obligation half is missing", async () => {
    await seedChain();
    // Overwrite the plan with a positive-only assertion.
    await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        { obligation_id: "O-1", name: "t", kind: "unit", assertions: ["returns the value"] },
      ],
      created_at: CREATED_AT,
    });
    await writeDag([
      {
        id: "N1",
        title: "t",
        description: "Implement O-1.",
        satisfies_obligations: ["O-1"],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
    ]);
    const result = await evaluateContractObligationsPromotionGate(ARTIFACTS_DIR);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("negative"))).toBe(true);
  });

  it("emits a finding_id -> {obligation_ids, node_ids} trace on the promoted plan", async () => {
    await seedChain();
    await writeDag([
      {
        id: "N1",
        title: "first",
        description: "Implement O-1.",
        satisfies_obligations: ["O-1"],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
      {
        id: "N2",
        title: "second",
        description: "Verify O-1 downstream.",
        satisfies_obligations: [],
        verification_obligation_ids: ["O-1"],
        depends_on: ["N1"],
        targeted_commands: [],
        status: "pending",
      },
    ]);
    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);

    const plan = JSON.parse(
      await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"),
    ) as {
      traceability: Record<string, { obligation_ids: string[]; node_ids: string[] }>;
      findings: Array<{ id: string; model_tier: string }>;
    };

    expect(plan.traceability).toBeDefined();
    expect(plan.traceability.N1).toEqual({ obligation_ids: ["O-1"], node_ids: ["N1"] });
    expect(plan.traceability.N2.obligation_ids).toEqual(["O-1"]);
    // N2 depends on N1, so its node_ids include the upstream node.
    expect(plan.traceability.N2.node_ids).toEqual(expect.arrayContaining(["N2", "N1"]));

    // Every finding carries a relative model_tier, never a model name. Both
    // fixture nodes score 0/1 (trivial: <=1 obligation, no file scope, no
    // counterexamples, non-high-stakes lens), so each deterministically derives
    // the cheapest "small" rank.
    expect(plan.findings.map((f) => f.model_tier)).toEqual(["small", "small"]);
  });

  it("source_type-scoped digest coverage fails the gate for an enumerable intake with an uncovered finding", async () => {
    await seedChain();
    // Switch the goal to a structured_audit source and write an enumeration
    // with a finding no obligation covers.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "Improve.",
      non_goals: [],
      success_criteria: ["Improved."],
      source_type: "structured_audit",
      created_at: CREATED_AT,
    });
    await writeJsonFile(intakePaths(ARTIFACTS_DIR).findingEnumeration, {
      is_enumerable: true,
      findings: [{ id: "FND-uncovered" }],
    });
    await writeDag([
      {
        id: "N1",
        title: "t",
        description: "Implement O-1.",
        satisfies_obligations: ["O-1"],
        depends_on: [],
        verification_obligation_ids: [],
        targeted_commands: [],
        status: "pending",
      },
    ]);
    const result = await evaluateContractObligationsPromotionGate(ARTIFACTS_DIR);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("FND-uncovered"))).toBe(true);
  });
});
