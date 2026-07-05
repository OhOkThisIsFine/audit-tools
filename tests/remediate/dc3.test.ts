/**
 * DC-3: parallel per-module contract drafting + deterministic finalization.
 *
 * `module_contract_drafting` (→ module_contracts) fans out to ONE agent per
 * module through the shared wave scheduler (`scheduleWave`), replacing the former
 * single sequential agent. The orchestrator merges the per-module shards into the
 * aggregated artifact — byte-identical in shape to the single-agent output — and
 * guarantees the merge is COMPLETE (every decomposed module present) before any
 * downstream derivation runs. A missing shard re-emits the wave; the
 * seam_reconciliation / contract_finalization / critique pass downstream stays the
 * consistency gate.
 *
 * `contract_finalization` (→ finalized_module_contracts) is NOT a wave: it is
 * DERIVED deterministically from the drafts + seam report (carry each draft
 * verbatim, attach the agreed_interface of every touching seam as a
 * seam_adjustment), so no per-module LLM fan-out is dispatched.
 *
 * Verifies:
 *   inv-1/inv-2  drafting wave: one shard path per module, capped by the host
 *                concurrency the shared scheduler derives.
 *   inv-3        merge waits for completeness, then advances downstream.
 *   inv-4        merged aggregate passes the validator and is byte-identical in
 *                shape (same envelope keys, decomposition module order).
 *   inv-5        source partition: single-module decompositions keep the single
 *                aggregated step; the dc5 obligation-ledger derivation is untouched.
 *   inv-6        the merged module_contracts route to seam_reconciliation (the gate).
 *   fail-1..4    a missing shard never promotes a partial aggregate; the wave is
 *                re-emitted instead.
 *   finalization deterministic derive (no wave), seam-adjustment attach, and the
 *                module_contracts write-through revert-prevention.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNextContractPipelineStep,
  ingestContractArtifacts,
  isParallelModulePhase,
  nextMissingContractPhase,
  archiveContractArtifact,
} from "../../src/remediate/steps/contractPipeline.js";
import {
  contractInputFilePath,
  contractPipelineDir,
  contractArtifactExists,
  isEnvelope,
  readContractArtifact,
  writeContractArtifact,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import type { ContractPipelineArtifactName } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
  CONTRACT_PIPELINE_VALIDATORS,
  validateReconciliationDerivation,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
} from "audit-tools/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-dc3");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

// quota disabled in session config → scheduleWave takes the deterministic
// host-cap path (cap = parallel_workers, capped to module count) with no quota
// state on disk: the cap is reproducible without touching the global quota dir.
const STEP_OPTIONS = {
  root: TEST_DIR,
  artifactsDir: ARTIFACTS_DIR,
  runId: "DC3-TEST",
  sessionConfig: { parallel_workers: 2, quota: { enabled: false } } as any,
};

async function writeRaw(
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<void> {
  const path = contractInputFilePath(ARTIFACTS_DIR, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  // D3: the host writes a plain payload to the input path; the tool derives the
  // canonical envelope at ingest. Run ingest so the completion gate sees the
  // upstream phase as done (mirrors what buildNextContractPipelineStep does).
  await ingestContractArtifacts(ARTIFACTS_DIR);
}

function makeGoalSpec() {
  return {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Improve.",
    non_goals: [],
    success_criteria: ["Improved."],
    source_type: "conversation",
    created_at: CREATED_AT,
  };
}

function makeContextBundle() {
  return {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "G1",
    entries: [],
    context_summary: "ctx",
    created_at: CREATED_AT,
  };
}

const THREE_MODULE_NAMES = ["mod-alpha", "mod-beta", "mod gamma/extra"] as const;

function makeThreeModuleDecomposition() {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: THREE_MODULE_NAMES.map((name, i) => ({
      name,
      responsibilities: `Does ${name}.`,
      file_scope: [`src/${i}.ts`],
    })),
    created_at: CREATED_AT,
  };
}

function makeSingleModuleDecomposition() {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [{ name: "mod-only", responsibilities: "Does it.", file_scope: ["src/a.ts"] }],
    created_at: CREATED_AT,
  };
}

/** The bare per-module drafting-contract shard a worker would write. */
function draftingShard(name: string) {
  return {
    name,
    inputs: ["x"],
    outputs: ["y"],
    invariants: [],
    side_effects: [],
    validation_boundary: `validates ${name}`,
    failure_modes: [],
    neighbor_needs: [],
  };
}

/** The bare per-module finalized-contract shard a worker would write. */
function finalizedShard(name: string) {
  return {
    name,
    inputs: ["x"],
    outputs: ["y"],
    invariants: [],
    side_effects: [],
    validation_boundary: `validates ${name}`,
    failure_modes: [],
    seam_adjustments: [],
  };
}

/**
 * Write a per-module shard to the exact path the emitted wave prompt declares.
 * The prompt lists every module's shard path verbatim, so the test parses those
 * paths out of the rendered prompt rather than re-implementing the slug+hash.
 */
async function writeShardFromPrompt(
  prompt: string,
  moduleName: string,
  payload: unknown,
): Promise<void> {
  const path = shardPathFromPrompt(prompt, moduleName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/** Extract the declared shard path for a module from the rendered wave prompt. */
function shardPathFromPrompt(prompt: string, moduleName: string): string {
  // Each assignment renders: "**<name>** ... Write this module's contract to
  // exactly: `<path>`". Find the module's block, then the backticked path on the
  // following "exactly:" line.
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\*\\*${escaped}\\*\\*[\\s\\S]*?exactly:\\s*\`([^\`]+)\``,
  );
  const m = prompt.match(re);
  if (!m) {
    throw new Error(`shard path for "${moduleName}" not found in prompt`);
  }
  return m[1];
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

describe("isParallelModulePhase", () => {
  it("recognizes exactly the one parallel module phase (drafting)", () => {
    expect(isParallelModulePhase("module_contract_drafting")).toBe(true);
    // contract_finalization is deterministically derived, NOT a per-module wave.
    expect(isParallelModulePhase("contract_finalization")).toBe(false);
    expect(isParallelModulePhase("seam_reconciliation")).toBe(false);
    expect(isParallelModulePhase("implementation_planning")).toBe(false);
  });
});

describe("DC-3 module_contract_drafting — per-module wave fan-out", () => {
  beforeEach(async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeThreeModuleDecomposition());
  });

  it("inv-1: emits ONE shard assignment per decomposed module (not a single aggregate)", async () => {
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("module_contract_drafting");
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);

    // One declared shard path per module — discoverable for every module name.
    for (const name of THREE_MODULE_NAMES) {
      expect(() => shardPathFromPrompt(prompt, name)).not.toThrow();
    }
    // Distinct shard paths (the fan-out is per module, not one shared file).
    const paths = THREE_MODULE_NAMES.map((n) => shardPathFromPrompt(prompt, n));
    expect(new Set(paths).size).toBe(THREE_MODULE_NAMES.length);
    // Explicitly a parallel wave, not the single aggregated artifact step.
    expect(prompt).toMatch(/ONE sub-agent PER MODULE/);
    expect(prompt).toMatch(/do NOT write that file yourself/i);
  });

  it("inv-2: the wave is concurrency-capped by the shared scheduler (parallel_workers=2)", async () => {
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    // scheduleWave caps the wave at parallel_workers (2), below the 3 modules.
    expect(prompt).toMatch(/waves of at most \*\*2\*\* concurrent agents/);
  });

  it("inv-2: the cap collapses to the module count when host concurrency is higher", async () => {
    const step = await buildNextContractPipelineStep({
      ...STEP_OPTIONS,
      sessionConfig: { parallel_workers: 10, quota: { enabled: false } } as any,
    });
    const prompt = await promptOf(step!);
    // max_concurrent never exceeds itemCount (3 modules).
    expect(prompt).toMatch(/waves of at most \*\*3\*\* concurrent agents/);
  });

  it("fail-1: an incomplete shard set never promotes a partial aggregate; the wave re-emits", async () => {
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    // Only TWO of three shards written.
    await writeShardFromPrompt(prompt, "mod-alpha", draftingShard("mod-alpha"));
    await writeShardFromPrompt(prompt, "mod-beta", draftingShard("mod-beta"));

    const next = await buildNextContractPipelineStep(STEP_OPTIONS);
    // No aggregated artifact was written from a partial set.
    expect(contractArtifactExists(ARTIFACTS_DIR, "module_contracts")).toBe(false);
    // The same per-module wave is re-emitted (still drafting).
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("module_contract_drafting");
    const nextPrompt = await promptOf(next!);
    expect(nextPrompt).toMatch(/ONE sub-agent PER MODULE/);
  });

  it("inv-3/inv-4: a COMPLETE shard set merges into a validator-clean aggregate", async () => {
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    for (const name of THREE_MODULE_NAMES) {
      await writeShardFromPrompt(prompt, name, draftingShard(name));
    }

    // The next next-step merges + advances past drafting.
    await buildNextContractPipelineStep(STEP_OPTIONS);

    expect(contractArtifactExists(ARTIFACTS_DIR, "module_contracts")).toBe(true);
    const env = await readContractArtifact(ARTIFACTS_DIR, "module_contracts");
    expect(env && isEnvelope(env)).toBe(true);
    const merged = (env as any).payload;

    // inv-4: byte-identical SHAPE — same envelope keys as the single-agent output.
    expect(Object.keys(merged).sort()).toEqual(
      ["contract_version", "created_at", "goal_id", "module_contracts"].sort(),
    );
    expect(merged.contract_version).toBe(CP_MODULE_CONTRACTS_VERSION);
    expect(merged.goal_id).toBe("G1");
    // One entry per module, in DECOMPOSITION order (deterministic, not dir order).
    expect(merged.module_contracts.map((m: any) => m.name)).toEqual([
      ...THREE_MODULE_NAMES,
    ]);
    // inv-4: the merged aggregate passes the real validator.
    const issues = CONTRACT_PIPELINE_VALIDATORS.module_contracts(
      merged,
      "module_contracts",
    ).filter((i) => i.severity === "error");
    expect(issues).toEqual([]);
  });

  it("inv-6: the merged module_contracts route to seam_reconciliation (the consistency gate)", async () => {
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    for (const name of THREE_MODULE_NAMES) {
      await writeShardFromPrompt(prompt, name, draftingShard(name));
    }
    const next = await buildNextContractPipelineStep(STEP_OPTIONS);
    // After the merge, the next missing phase is seam_reconciliation — the gate
    // is not skipped by the fan-out.
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("seam_reconciliation");
    const nextPrompt = await promptOf(next!);
    expect(nextPrompt).toMatch(/Seam Reconciliation/);
  });

  it("fail-2: a stray shard for the WRONG module never satisfies completeness", async () => {
    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    // Write all three shard FILES, but one carries a mismatched `name`.
    await writeShardFromPrompt(prompt, "mod-alpha", draftingShard("mod-alpha"));
    await writeShardFromPrompt(prompt, "mod-beta", draftingShard("mod-beta"));
    await writeShardFromPrompt(prompt, "mod gamma/extra", draftingShard("WRONG-NAME"));

    await buildNextContractPipelineStep(STEP_OPTIONS);
    // The mismatched shard does not count → no aggregate, still drafting.
    expect(contractArtifactExists(ARTIFACTS_DIR, "module_contracts")).toBe(false);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("module_contract_drafting");
  });
});

describe("contract_finalization — deterministic derivation (no wave)", () => {
  beforeEach(async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeThreeModuleDecomposition());
  });

  it("derives finalized_module_contracts deterministically and advances past finalization (no per-module wave)", async () => {
    await writeRaw("module_contracts", {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: THREE_MODULE_NAMES.map((name) => draftingShard(name)),
      created_at: CREATED_AT,
    });
    await writeRaw("seam_reconciliation_report", {
      contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
      goal_id: "G1",
      mismatches: [],
      created_at: CREATED_AT,
    });
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("contract_finalization");

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    // The tool derived the artifact itself — no per-module finalization wave.
    expect(contractArtifactExists(ARTIFACTS_DIR, "finalized_module_contracts")).toBe(true);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).not.toBe("contract_finalization");
    const prompt = await promptOf(step!);
    expect(prompt).not.toMatch(/Per-Module Contract Finalization/);
    // No finalization wave directory is ever created.
    expect(
      existsSync(
        join(contractPipelineDir(ARTIFACTS_DIR), "module-waves", "contract_finalization"),
      ),
    ).toBe(false);

    // The derived aggregate passes the real validator, in decomposition order.
    const env = await readContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts");
    const finalized = (env as any).payload;
    expect(finalized.contract_version).toBe(CP_FINALIZED_MODULE_CONTRACTS_VERSION);
    expect(finalized.module_contracts.map((m: any) => m.name)).toEqual([
      ...THREE_MODULE_NAMES,
    ]);
    const issues = CONTRACT_PIPELINE_VALIDATORS.finalized_module_contracts(
      finalized,
      "finalized_module_contracts",
    ).filter((i) => i.severity === "error");
    expect(issues).toEqual([]);
  });

  it("carries the draft interface verbatim, preserves neighbor_needs, and attaches touching-seam adjustments", async () => {
    // A drafting contract with a neighbor edge, to prove neighbor_needs survives.
    await writeRaw("module_contracts", {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: THREE_MODULE_NAMES.map((name) =>
        name === "mod-alpha"
          ? { ...draftingShard(name), neighbor_needs: [{ neighbor: "mod-beta", needs: "y" }] }
          : draftingShard(name),
      ),
      created_at: CREATED_AT,
    });
    const AGREED = "mod-beta emits a validated roster payload";
    await writeRaw("seam_reconciliation_report", {
      contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
      goal_id: "G1",
      mismatches: [
        {
          seam_id: "S1",
          module_a: "mod-alpha",
          module_b: "mod-beta",
          description: "alpha input vs beta output",
          resolution: { decision: "both", agreed_interface: AGREED },
        },
      ],
      created_at: CREATED_AT,
    });

    await buildNextContractPipelineStep(STEP_OPTIONS);
    const env = await readContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts");
    const finalized = (env as any).payload;
    const byName = (n: string) =>
      finalized.module_contracts.find((m: any) => m.name === n);

    // Interface fields copied verbatim from the draft.
    expect(byName("mod-alpha").inputs).toEqual(["x"]);
    expect(byName("mod-alpha").outputs).toEqual(["y"]);
    // neighbor_needs preserved for the phase-cut / DAG ordering derivation.
    expect(byName("mod-alpha").neighbor_needs).toEqual([
      { neighbor: "mod-beta", needs: "y" },
    ]);
    // The seam's agreed interface is attached to BOTH touched modules...
    expect(byName("mod-alpha").seam_adjustments.some((s: string) => s.includes(AGREED))).toBe(
      true,
    );
    expect(byName("mod-beta").seam_adjustments.some((s: string) => s.includes(AGREED))).toBe(
      true,
    );
    // ...and to no others.
    expect(byName("mod gamma/extra").seam_adjustments).toEqual([]);

    // The attach satisfies the reconciliation-derivation gate (INV-CO-12).
    const seamEnv = await readContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report");
    const derivationIssues = validateReconciliationDerivation(
      (seamEnv as any).payload,
      finalized,
    ).filter((i) => i.severity === "error");
    expect(derivationIssues).toEqual([]);
  });
});

describe("module_contracts write-through (revert-prevention)", () => {
  beforeEach(async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeThreeModuleDecomposition());
  });

  it("a directly-ingested module_contracts aggregate writes through to the per-module shards, so a re-merge reproduces the edit (not the stale shards)", async () => {
    // 1. Drive drafting → merged module_contracts.
    const draftStep = await buildNextContractPipelineStep(STEP_OPTIONS);
    const draftPrompt = await promptOf(draftStep!);
    for (const name of THREE_MODULE_NAMES) {
      await writeShardFromPrompt(draftPrompt, name, draftingShard(name));
    }
    await buildNextContractPipelineStep(STEP_OPTIONS); // merge module_contracts
    expect(contractArtifactExists(ARTIFACTS_DIR, "module_contracts")).toBe(true);

    // 2. A direct aggregate edit (one module's validation_boundary rewritten).
    //    writeRaw runs ingest, which must write the edit THROUGH to the shard.
    const edited = draftingShard("mod-alpha");
    edited.validation_boundary = "EDITED boundary for mod-alpha";
    await writeRaw("module_contracts", {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: [
        edited,
        draftingShard("mod-beta"),
        draftingShard("mod gamma/extra"),
      ],
      created_at: CREATED_AT,
    });
    const alphaShardPath = shardPathFromPrompt(draftPrompt, "mod-alpha");
    const alphaShard = JSON.parse(await readFile(alphaShardPath, "utf8"));
    expect(alphaShard.validation_boundary).toBe("EDITED boundary for mod-alpha");

    // 3. Archive the aggregate (input + canonical) and re-run: the re-merge from
    //    shards reproduces the edit because the shard carries it.
    await archiveContractArtifact(ARTIFACTS_DIR, "module_contracts", "stale");
    expect(contractArtifactExists(ARTIFACTS_DIR, "module_contracts")).toBe(false);
    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("module_contract_drafting");

    await buildNextContractPipelineStep(STEP_OPTIONS); // re-merge from shards
    expect(contractArtifactExists(ARTIFACTS_DIR, "module_contracts")).toBe(true);
    const env = await readContractArtifact(ARTIFACTS_DIR, "module_contracts");
    const remerged = (env as any).payload;
    const alpha = remerged.module_contracts.find((m: any) => m.name === "mod-alpha");
    expect(alpha.validation_boundary).toBe("EDITED boundary for mod-alpha");
  });
});

describe("DC-3 source partition (inv-5)", () => {
  it("a single-module decomposition keeps the single aggregated step (no shard fan-out)", async () => {
    await writeRaw("goal_spec", makeGoalSpec());
    await writeRaw("context_bundle", makeContextBundle());
    await writeRaw("module_decomposition", makeSingleModuleDecomposition());

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);
    const prompt = await promptOf(step!);
    // The role-title prompt (single agent), not the per-module fan-out.
    expect(prompt).toMatch(/Per-Module Contract Drafting/);
    expect(prompt).not.toMatch(/ONE sub-agent PER MODULE/);
    // No module-waves directory is created for the degenerate single-module case.
    expect(existsSync(join(contractPipelineDir(ARTIFACTS_DIR), "module-waves"))).toBe(
      false,
    );
  });

  it("inv-5: the dc5 obligation-ledger derivation is untouched — it still runs deterministically", async () => {
    // Drive the chain (multi-module, merged) through finalization, then write
    // critique so obligation_ledger is the next phase. The tool DERIVES the
    // ledger from finalized contracts (dc5's partition) — the DC-3 change must
    // not disturb that intercept.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(
      ARTIFACTS_DIR,
      "module_decomposition",
      makeThreeModuleDecomposition(),
    );
    await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
      contract_version: CP_MODULE_CONTRACTS_VERSION,
      goal_id: "G1",
      module_contracts: THREE_MODULE_NAMES.map((name) => draftingShard(name)),
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
      module_contracts: THREE_MODULE_NAMES.map((name) => finalizedShard(name)),
      created_at: CREATED_AT,
    });
    await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
      contract_version:
        "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
      goal_id: "G1",
      items: [],
      verdict: "approved",
      created_at: CREATED_AT,
    });

    expect(nextMissingContractPhase(ARTIFACTS_DIR)).toBe("obligation_ledger");
    // next-step derives the ledger deterministically and re-derives forward.
    await buildNextContractPipelineStep(STEP_OPTIONS);
    expect(contractArtifactExists(ARTIFACTS_DIR, "obligation_ledger")).toBe(true);
    const env = await readContractArtifact(ARTIFACTS_DIR, "obligation_ledger");
    const ledger = (env as any).payload;
    // One invariant-bearing obligation set derived from the 3 module contracts.
    expect(Array.isArray(ledger.obligations)).toBe(true);
    expect(ledger.goal_id).toBe("G1");
  });
});
