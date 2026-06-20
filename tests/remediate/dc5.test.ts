/**
 * DC-5: change-vs-addition classification + paired/scoped-negative test specs.
 *
 * Each obligation is classified change-vs-addition with a deterministic
 * touches-an-existing-symbol heuristic FIRST (recorded on the ledger), then an
 * LLM may confirm/override (also recorded). A behavior CHANGE requires a PAIRED
 * positive+negative test spec whose negative is SCOPED to the changed
 * symbol/file via an anti-rot scope predicate — an unscoped repo-wide-grep
 * negative is rejected (CE-006), not merely keyword-checked. A pure ADDITION is
 * never forced to pair. The pair is enforced at BOTH test-plan derivation
 * (`validatePairedObligations`) and the `mergeImplementResults` verify gate
 * (only-one-polarity → blocked). Fixes CE-013 (render-only misclassification).
 *
 * Verifies:
 *   inv-1  deterministic classifier: touches-existing-symbol → change (+anchors);
 *          no-existing-symbol → addition (no anchors).
 *   inv-2  LLM confirm vs. override is recorded on `determined_by` (never silent).
 *   inv-3  the deriver attaches the classification to every testable obligation,
 *          deterministically, from the finalized-contract symbol baseline.
 *   inv-4  test-plan gate: a change needs a paired positive+scoped-negative; a
 *          pure addition needs neither half.
 *   inv-5  scope predicate: a negative naming the changed symbol/file is scoped;
 *          an unscoped repo-wide negative is rejected even with a polarity keyword.
 *   inv-6  verify-gate helper: only-one-polarity (or unscoped negative) for a
 *          change → block reason; a full scoped pair → null; addition → null.
 *   inv-7  the test-plan gate and the verify gate share one evaluation (parity).
 *   fail-1..6 / merge: mergeImplementResults blocks a resolved change finding
 *          whose covered obligation has only one polarity (positive-only,
 *          negative-only, unscoped-negative), and resolves it once fully paired;
 *          a pure addition resolves without a pair.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  classifyObligationChange,
  applyLlmConfirmation,
  buildBaselineSymbolCorpus,
  negativeAssertionIsScoped,
  evaluatePairing,
  verifyPairingForFinding,
  obligationScopeAnchors,
  readObligationChangeClassification,
} from "../../src/remediate/contractPipeline/changeClassification.js";
import { deriveObligationLedger } from "../../src/remediate/contractPipeline/derive.js";
import { validatePairedObligations } from "../../src/remediate/validation/contractPipeline.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";
import { mergeImplementResults } from "../../src/remediate/steps/dispatch.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";
import {
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "audit-tools/shared";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CP_FINALIZED_MODULE_CONTRACTS_VERSION =
  "remediate-code-contract-pipeline/finalized-module-contracts/v1alpha1" as const;

// ── inv-1: deterministic touches-an-existing-symbol classifier ─────────────────

describe("classifyObligationChange (deterministic FIRST pass)", () => {
  const baseline = new Set(["writerecord", "flush_buffer", "src/store.ts"]);

  it("inv-1: classifies a change when the obligation references an existing symbol", () => {
    const cls = classifyObligationChange(
      "writeRecord must return an ack token after the write",
      baseline,
    );
    expect(cls.change_kind).toBe("change");
    expect(cls.determined_by).toBe("touches_existing_symbol");
    // The matched existing symbol becomes a scope anchor for the paired negative.
    expect(cls.touched_symbols).toContain("writerecord");
  });

  it("inv-1: classifies a pure addition when no existing symbol is referenced", () => {
    const cls = classifyObligationChange(
      "A brand new metricsEmitter publishes counters",
      baseline,
    );
    expect(cls.change_kind).toBe("addition");
    expect(cls.determined_by).toBe("no_existing_symbol");
    expect(cls.touched_symbols).toEqual([]);
  });

  it("inv-1: matches a touched FILE path, not only a function symbol", () => {
    const cls = classifyObligationChange(
      "Records are appended to src/store.ts on commit",
      baseline,
    );
    expect(cls.change_kind).toBe("change");
    expect(cls.touched_symbols).toContain("src/store.ts");
  });

  it("inv-1: a plain prose word that happens to be in the baseline is not treated as a symbol", () => {
    // "rejects" is prose (no code-ish shape), so even if a baseline had it, the
    // obligation text yields no symbol tokens and stays an addition.
    const cls = classifyObligationChange("malformed input is rejected", new Set(["rejects"]));
    expect(cls.change_kind).toBe("addition");
  });

  it("builds the baseline corpus from the finalized-contract interface surface", () => {
    const corpus = buildBaselineSymbolCorpus({
      module_contracts: [
        {
          name: "store-module",
          inputs: ["record"],
          outputs: ["writeRecord ack"],
          side_effects: ["mutates src/store.ts"],
          validation_boundary: "validates at flushBuffer",
          invariants: [],
          failure_modes: [],
        },
      ],
    });
    expect(corpus.has("writerecord")).toBe(true);
    expect(corpus.has("flushbuffer")).toBe(true);
    expect(corpus.has("src/store.ts")).toBe(true);
  });
});

// ── inv-2: LLM confirmation / override is recorded ─────────────────────────────

describe("applyLlmConfirmation (recorded judgment)", () => {
  it("inv-2: records an LLM confirmation that agrees with the deterministic verdict", () => {
    const det = classifyObligationChange("writeRecord returns ack", new Set(["writerecord"]));
    const merged = applyLlmConfirmation(det, { change_kind: "change", rationale: "agreed" });
    expect(merged.change_kind).toBe("change");
    expect(merged.determined_by).toBe("llm_confirmed");
    expect(merged.rationale).toBe("agreed");
    // Deterministically-found anchors are preserved through a confirmation.
    expect(merged.touched_symbols).toContain("writerecord");
  });

  it("inv-2: records an LLM override that disagrees, and clears anchors for an addition", () => {
    const det = classifyObligationChange("writeRecord returns ack", new Set(["writerecord"]));
    const merged = applyLlmConfirmation(det, {
      change_kind: "addition",
      rationale: "the symbol is newly introduced in this change",
    });
    expect(merged.change_kind).toBe("addition");
    expect(merged.determined_by).toBe("llm_override");
    expect(merged.touched_symbols).toEqual([]);
  });

  it("inv-2: an override TO a change merges the LLM's anchors with the deterministic ones", () => {
    const det = classifyObligationChange("adds a new flag", new Set()); // addition
    const merged = applyLlmConfirmation(det, {
      change_kind: "change",
      touched_symbols: ["parseFlags"],
    });
    expect(merged.change_kind).toBe("change");
    expect(merged.determined_by).toBe("llm_override");
    expect(merged.touched_symbols).toContain("parseflags");
  });
});

// ── inv-3: the deriver attaches the classification ─────────────────────────────

describe("deriveObligationLedger attaches change_classification (CE-013 fix)", () => {
  function finalized() {
    return {
      contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        {
          name: "store-module",
          inputs: ["record"],
          outputs: ["writeRecord ack"],
          invariants: ["writeRecord is idempotent for a duplicate record"],
          side_effects: [],
          validation_boundary: "validates record",
          failure_modes: ["a brand new audit trail is appended"],
        },
      ],
      created_at: CREATED_AT,
    };
  }

  it("inv-3: testable obligations carry a recorded, deterministic classification", () => {
    const ledger = deriveObligationLedger(finalized(), { created_at: CREATED_AT });
    const inv = ledger.obligations.find((o) => o.kind === "invariant")!;
    const fail = ledger.obligations.find((o) => o.kind === "behavioral")!;

    // The invariant references writeRecord (an existing output symbol) → change.
    expect(inv.change_classification?.change_kind).toBe("change");
    expect(inv.change_classification?.determined_by).toBe("touches_existing_symbol");
    // The failure mode introduces a brand-new audit trail (no existing symbol) → addition.
    expect(fail.change_classification?.change_kind).toBe("addition");

    // Structural obligations get no classification (no test burden).
    const structural = ledger.obligations.find((o) => o.kind === "structural")!;
    expect(structural.change_classification).toBeUndefined();
  });

  it("inv-3: derivation stays deterministic with the classification attached", () => {
    const a = deriveObligationLedger(finalized(), { created_at: CREATED_AT });
    const b = deriveObligationLedger(finalized(), { created_at: CREATED_AT });
    expect(a).toEqual(b);
  });
});

// ── inv-5: anti-rot scope predicate (CE-006) ───────────────────────────────────

describe("negativeAssertionIsScoped (anti-rot scope predicate, CE-006)", () => {
  const anchors = ["writerecord", "src/store.ts"];

  it("inv-5: a negative naming the changed symbol is scoped", () => {
    expect(
      negativeAssertionIsScoped("writeRecord rejects a record with no id", anchors),
    ).toBe(true);
  });

  it("inv-5: a negative naming the changed FILE is scoped", () => {
    expect(
      negativeAssertionIsScoped("src/store.ts throws on a duplicate append", anchors),
    ).toBe(true);
  });

  it("inv-5: an unscoped repo-wide negative is rejected even though it has a negative keyword", () => {
    // Keyword matching alone ("no ... anywhere") would have accepted this — the
    // predicate rejects it because it names no anchor and scans the whole repo.
    expect(
      negativeAssertionIsScoped("no file anywhere in the repo contains a raw write", anchors),
    ).toBe(false);
  });

  it("inv-5: a global-scan negative is rejected even when it also names the anchor", () => {
    // Naming the symbol is necessary but not sufficient: the repo-wide scan, not
    // the symbol, is what the assertion actually checks.
    expect(
      negativeAssertionIsScoped("grep the repo to prove writeRecord appears in no file", anchors),
    ).toBe(false);
  });

  it("inv-5: a scoped negative with no recognizable anchor is rejected (fail-closed)", () => {
    expect(negativeAssertionIsScoped("throws on bad input", anchors)).toBe(false);
  });
});

// ── inv-4 + inv-7: test-plan derivation gate ───────────────────────────────────

describe("validatePairedObligations (change-scoped, CE-013/CE-006)", () => {
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
  const changeObl = (id: string, anchor: string) => ({
    id,
    description: `${anchor} must hold`,
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    change_classification: {
      change_kind: "change",
      touched_symbols: [anchor],
      determined_by: "touches_existing_symbol",
    },
  });
  const additionObl = (id: string) => ({
    id,
    description: "a brand new capability",
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    change_classification: { change_kind: "addition", touched_symbols: [], determined_by: "no_existing_symbol" },
  });

  it("inv-4: a CHANGE passes with a positive + a scoped negative", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("O-1", "writerecord")]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["writeRecord returns the ack on success", "writeRecord rejects a missing id"],
        },
      ]),
    );
    expect(issues).toHaveLength(0);
  });

  it("inv-4: a CHANGE with a positive but an UNSCOPED negative fails (CE-006)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("O-1", "writerecord")]),
      plan([
        {
          obligation_id: "O-1",
          name: "t",
          kind: "unit",
          assertions: ["writeRecord returns the ack", "throws on a duplicate anywhere in the repo"],
        },
      ]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.message.includes("CE-006"))).toBe(true);
  });

  it("inv-4: a CHANGE with only a positive fails (missing negative half)", () => {
    const issues = validatePairedObligations(
      ledger([changeObl("O-1", "writerecord")]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns the ack"] }]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(false);
  });

  it("inv-4: a pure ADDITION needs neither a negative nor a pair", () => {
    const issues = validatePairedObligations(
      ledger([additionObl("O-2")]),
      plan([{ obligation_id: "O-2", name: "t", kind: "unit", assertions: ["emits a new counter"] }]),
    );
    expect(issues).toHaveLength(0);
  });

  it("inv-4: an UNCLASSIFIED testable obligation is treated as a change (fail-closed)", () => {
    // No change_classification → fail-closed change → a positive-only spec fails.
    const issues = validatePairedObligations(
      ledger([{ id: "writeRecord-O", description: "writeRecord stays consistent", kind: "behavioral", depends_on: [], status: "pending" }]),
      plan([{ obligation_id: "writeRecord-O", name: "t", kind: "unit", assertions: ["writeRecord returns the ack"] }]),
    );
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(true);
  });

  it("inv-4: an addition still fails when it has NO covering spec at all", () => {
    const issues = validatePairedObligations(ledger([additionObl("O-2")]), plan([]));
    expect(issues.some((i) => i.message.includes("no test spec"))).toBe(true);
  });
});

// ── inv-6 + inv-7: verify-gate helper (parity with the test-plan gate) ──────────

describe("verifyPairingForFinding (mergeImplementResults verify gate)", () => {
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
  const changeObl = {
    id: "O-1",
    description: "writeRecord must hold",
    kind: "behavioral",
    depends_on: [],
    status: "pending",
    change_classification: { change_kind: "change", touched_symbols: ["writerecord"], determined_by: "touches_existing_symbol" },
  };

  it("inv-6: returns null when the change obligation is fully scoped-paired", () => {
    const reason = verifyPairingForFinding(
      ["O-1"],
      ledger([changeObl]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack", "writeRecord rejects missing id"] }]),
    );
    expect(reason).toBeNull();
  });

  it("inv-6: blocks (only one polarity) when the negative half is missing", () => {
    const reason = verifyPairingForFinding(
      ["O-1"],
      ledger([changeObl]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack"] }]),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("only one polarity");
  });

  it("inv-6: blocks when the negative is unscoped (CE-006)", () => {
    const reason = verifyPairingForFinding(
      ["O-1"],
      ledger([changeObl]),
      plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack", "fails for a raw write anywhere in the repo"] }]),
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("CE-006");
  });

  it("inv-6: returns null for a pure addition (never paired)", () => {
    const additionObl = { ...changeObl, id: "O-2", change_classification: { change_kind: "addition", touched_symbols: [], determined_by: "no_existing_symbol" } };
    const reason = verifyPairingForFinding(
      ["O-2"],
      ledger([additionObl]),
      plan([{ obligation_id: "O-2", name: "t", kind: "unit", assertions: ["emits a counter"] }]),
    );
    expect(reason).toBeNull();
  });

  it("inv-6: returns null when the finding covers no obligation (audit-findings intake)", () => {
    expect(verifyPairingForFinding([], ledger([changeObl]), plan([]))).toBeNull();
  });

  it("inv-7: the verify gate and the test-plan gate agree on the same only-one-polarity case", () => {
    const onlyPositive = plan([{ obligation_id: "O-1", name: "t", kind: "unit", assertions: ["writeRecord returns ack"] }]);
    const verifyReason = verifyPairingForFinding(["O-1"], ledger([changeObl]), onlyPositive);
    const planIssues = validatePairedObligations(ledger([changeObl]), onlyPositive).filter(
      (i) => i.severity === "error",
    );
    // Both gates flag the same gap (parity): one blocks, the other errors.
    expect(verifyReason).not.toBeNull();
    expect(planIssues.length).toBeGreaterThan(0);
  });
});

describe("obligationScopeAnchors fallback", () => {
  it("falls back to the obligation id + description symbols when no classification anchors", () => {
    const anchors = obligationScopeAnchors("OBL-store-inv-1", "writeRecord stays consistent", undefined);
    expect(anchors).toContain("obl-store-inv-1");
    expect(anchors).toContain("writerecord");
  });

  it("prefers the classification's recorded touched_symbols when present", () => {
    const cls = readObligationChangeClassification({
      change_classification: { change_kind: "change", touched_symbols: ["flushbuffer"], determined_by: "touches_existing_symbol" },
    });
    const anchors = obligationScopeAnchors("O-1", "whatever else", cls);
    expect(anchors).toEqual(["flushbuffer"]);
  });
});

// ── evaluatePairing primitive directness ───────────────────────────────────────

describe("evaluatePairing primitive", () => {
  it("reports negativeUnscoped when the sole negative failed scoping", () => {
    const v = evaluatePairing(
      ["writeRecord returns ack", "fails for any input anywhere in the repo"],
      ["writerecord"],
    );
    expect(v.hasPositive).toBe(true);
    expect(v.hasNegative).toBe(false);
    expect(v.negativeUnscoped).toBe(true);
    expect(v.ok).toBe(false);
  });

  it("is ok only with a positive AND a scoped negative", () => {
    const v = evaluatePairing(
      ["writeRecord returns ack", "writeRecord rejects an empty id"],
      ["writerecord"],
    );
    expect(v.ok).toBe(true);
  });
});

// ── fail-1..6 / merge: mergeImplementResults verify gate end-to-end ────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-dc5-merge");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

function makeStoreFinding(): Finding {
  return {
    id: "N-store",
    title: "Store node",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "Change writeRecord.",
    affected_files: [{ path: "src/store.ts" }],
    evidence: ["e"],
    contract_obligation_ids: ["OBL-store-01"],
    verification_obligation_ids: [],
  } as Finding;
}

function makeStoreNodeState(): RemediationState {
  const finding = makeStoreFinding();
  const block: RemediationBlock = {
    block_id: "CP-BLOCK-N-store",
    items: [finding.id],
    parallel_safe: true,
  };
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-DC5",
      findings: [finding],
      blocks: [block],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      [finding.id]: {
        finding_id: finding.id,
        status: "pending",
        block_id: block.block_id,
        item_spec: {
          finding_id: finding.id,
          concrete_change: "change writeRecord",
          tests_to_write: [{ name: "t", assertions: ["passes"] }],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

/**
 * Seed the obligation_ledger + test_validator_plan the DC-5 verify gate reads.
 * `assertions` are the covering test spec's assertions for OBL-store-01.
 */
async function seedContractArtifacts(
  changeKind: "change" | "addition",
  assertions: string[],
): Promise<void> {
  await writeContractArtifact(ARTIFACTS_DIR, "obligation_ledger", {
    contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
    goal_id: "G1",
    obligations: [
      {
        id: "OBL-store-01",
        description: "writeRecord must stay consistent",
        kind: "behavioral",
        depends_on: [],
        status: "pending",
        change_classification: {
          change_kind: changeKind,
          touched_symbols: changeKind === "change" ? ["writerecord"] : [],
          determined_by: changeKind === "change" ? "touches_existing_symbol" : "no_existing_symbol",
        },
      },
    ],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "test_validator_plan", {
    contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
    goal_id: "G1",
    test_specs: [{ obligation_id: "OBL-store-01", name: "t", kind: "unit", assertions }],
    created_at: CREATED_AT,
  });
}

async function mergeResolved(): Promise<RemediationState> {
  const runId = "PLAN-DC5";
  const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
  await mkdir(resultDir, { recursive: true });
  const resultPath = join(resultDir, "implement-CP-BLOCK-N-store.result.json");
  await writeFile(
    join(resultDir, "dispatch-plan.json"),
    JSON.stringify({
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: runId,
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [
        {
          task_id: "implement-CP-BLOCK-N-store",
          block_id: "CP-BLOCK-N-store",
          prompt_path: join(resultDir, "implement-CP-BLOCK-N-store.md"),
          result_path: resultPath,
          access: { read_paths: ["src/store.ts"], write_paths: ["src/store.ts", resultPath] },
        },
      ],
    }),
  );
  await writeFile(
    resultPath,
    JSON.stringify({
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [
        { finding_id: "N-store", status: "resolved", evidence: ["check passed: vitest run -> 3 pass"] },
      ],
    }),
  );
  return mergeImplementResults({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId);
}

describe("mergeImplementResults — DC-5 verify gate (only-one-polarity → blocked)", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("fail-1: blocks a resolved CHANGE finding whose obligation has only a positive", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeStoreNodeState());
    await seedContractArtifacts("change", ["writeRecord returns the ack"]);
    const merged = await mergeResolved();
    expect(merged.items!["N-store"].status).toBe("blocked");
    expect(merged.items!["N-store"].failure_reason).toContain("only one polarity");
  });

  it("fail-2: blocks a resolved CHANGE finding whose negative half is unscoped (CE-006)", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeStoreNodeState());
    await seedContractArtifacts("change", ["writeRecord returns ack", "throws on a duplicate anywhere in the repo"]);
    const merged = await mergeResolved();
    expect(merged.items!["N-store"].status).toBe("blocked");
    expect(merged.items!["N-store"].failure_reason).toContain("CE-006");
  });

  it("fail-3: resolves a CHANGE finding once it carries a positive + scoped negative", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeStoreNodeState());
    await seedContractArtifacts("change", ["writeRecord returns ack", "writeRecord rejects a missing id"]);
    const merged = await mergeResolved();
    expect(merged.items!["N-store"].status).toBe("resolved");
  });

  it("fail-4: resolves a pure ADDITION finding without requiring a pair", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeStoreNodeState());
    await seedContractArtifacts("addition", ["emits a new counter"]);
    const merged = await mergeResolved();
    expect(merged.items!["N-store"].status).toBe("resolved");
  });

  it("fail-5: the verify gate is inert when no contract artifacts exist (audit-findings intake)", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeStoreNodeState());
    // No obligation_ledger / test_validator_plan written.
    const merged = await mergeResolved();
    expect(merged.items!["N-store"].status).toBe("resolved");
  });

  it("fail-6: a blocked finding never writes a verify-passed sidecar artifact", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeStoreNodeState());
    await seedContractArtifacts("change", ["writeRecord returns the ack"]);
    await mergeResolved();
    expect(
      existsSync(join(ARTIFACTS_DIR, "result_N-store_verify_code_against_documentation.json")),
    ).toBe(false);
  });
});
