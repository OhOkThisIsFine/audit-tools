/**
 * C2 (sol-10 / P35) — a contract-pipeline prompt may only name inputs that a
 * producer actually WROTE to disk.
 *
 * The ENOENT class this pins: every host-facing artifact path the pipeline
 * renders is `<name>.input.json` (D3 — the host's world is entirely plain input
 * files), but five artifacts are DERIVED by the tool and were written only to
 * the canonical envelope `<name>.json`. Any prompt listing one of them under
 * "## Required Inputs" therefore pointed a worker at a file that never existed.
 *
 * This is the INTEGRATION half: drive the real pipeline from host-authored
 * inputs through the deterministic obligation-ledger / cyclic-seam / seam
 * intercepts, and assert that every path the NEXT single-phase step names as a
 * required input is present on disk. The map-level properties (derivation,
 * producer ordering, materialization, lane capability) live in
 * `tests/shared/prompt-capability.test.ts`.
 *
 * Deliberately scoped to a SINGLE-phase step: a collapsed framing step
 * legitimately names paths written later in the same round-trip, so a blanket
 * disk-existence rule would be a false positive there.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import {
  contractInputFilePath,
  contractPipelineDir,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import type { ContractPipelineArtifactName } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  writeJsonFile,
} from "audit-tools/shared";
import { scratchDir } from "../helpers/scratch.js";

const TEST_DIR = scratchDir(".test-cp-required-inputs");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const STEP_OPTIONS = {
  root: TEST_DIR,
  artifactsDir: ARTIFACTS_DIR,
  runId: "CONTRACT-REQUIRED-INPUTS",
};

/**
 * Seed one artifact the way a HOST does: a plain payload at the input path. The
 * tool's own ingest derives the canonical envelope, so nothing here pre-empts
 * the production path.
 */
async function seedHostArtifact(
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<void> {
  await mkdir(contractPipelineDir(ARTIFACTS_DIR), { recursive: true });
  await writeJsonFile(contractInputFilePath(ARTIFACTS_DIR, name), payload);
}

function moduleContractEntries() {
  return [
    {
      name: "auth-module",
      inputs: ["credentials"],
      outputs: ["session"],
      invariants: [
        "A session is issued only for validated credentials.",
        "Sessions expire after the configured TTL.",
      ],
      side_effects: ["writes session store"],
      validation_boundary: "validates credentials at the boundary",
      failure_modes: ["malformed credentials are rejected"],
    },
    {
      name: "logging-module",
      inputs: ["event"],
      outputs: ["log line"],
      invariants: ["Every log line names its module."],
      side_effects: [],
      validation_boundary: "n/a",
      failure_modes: [],
    },
  ];
}

/**
 * Everything a host authors before the first tool-derived artifact. The tool
 * derives finalized_module_contracts, obligation_ledger and
 * cyclic_seam_resolution from here on — exactly the artifacts whose input files
 * never used to exist.
 */
async function seedHostAuthoredUpstreams(): Promise<void> {
  await seedHostArtifact("goal_spec", {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Harden the auth flow.",
    non_goals: [],
    success_criteria: ["Auth flow is hardened."],
    source_type: "document",
    created_at: CREATED_AT,
  });
  await seedHostArtifact("context_bundle", {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "G1",
    entries: [],
    context_summary: "Auth context.",
    created_at: CREATED_AT,
  });
  await seedHostArtifact("module_decomposition", {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [
      { name: "auth-module", responsibilities: "Auth.", file_scope: ["src/auth.ts"] },
      { name: "logging-module", responsibilities: "Logs.", file_scope: ["src/log.ts"] },
    ],
    created_at: CREATED_AT,
  });
  await seedHostArtifact("module_contracts", {
    contract_version: CP_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
    module_contracts: moduleContractEntries(),
    created_at: CREATED_AT,
  });
  await seedHostArtifact("seam_reconciliation_report", {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches: [],
    created_at: CREATED_AT,
  });
}

/**
 * The conceptual critique the host authors from the step the FIRST call emits —
 * after `finalized_module_contracts` has been derived, exactly as production
 * orders it.
 */
async function seedConceptualCritique(): Promise<void> {
  await seedHostArtifact("conceptual_design_critique", {
    contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
    goal_id: "G1",
    items: [],
    verdict: "approved",
    created_at: CREATED_AT,
  });
}

/** The `- \`<path>\` (<key>)` entries a rendered "## Required Inputs" block lists. */
export function requiredInputPathsIn(prompt: string): string[] {
  const section = prompt.split(/^## Required Inputs$/m)[1];
  if (section === undefined) return [];
  const body = section.split(/^## /m)[0]!;
  return [...body.matchAll(/^- `([^`]+)` \(([a-z_]+)\)$/gm)].map((m) => m[1]!);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/** Emit the next step and return its rendered prompt. */
async function nextPrompt(): Promise<string> {
  const step = await buildNextContractPipelineStep(STEP_OPTIONS);
  expect(step, "the pipeline must emit a step, not complete").toBeTruthy();
  return readFile((step as { prompt_path: string }).prompt_path, "utf8");
}

function expectEveryRequiredInputOnDisk(prompt: string): void {
  const named = requiredInputPathsIn(prompt);
  expect(
    named.length,
    "the step must actually render a Required Inputs block",
  ).toBeGreaterThan(0);
  const missing = named.filter((path) => !existsSync(path));
  expect(
    missing,
    "a prompt may not name an input path no producer ever wrote (the ENOENT class)",
  ).toEqual([]);
}

describe("C2: a rendered Required Input names a file some producer wrote", () => {
  it("the critique step's inputs — incl. the DERIVED finalized contracts — exist on disk", async () => {
    await seedHostAuthoredUpstreams();

    // One call: ingest the host inputs, run the deterministic
    // contract_finalization intercept, land on the first phase that genuinely
    // needs a host. That step is SINGLE-phase, so every input it names must
    // already be on disk (a collapsed framing step legitimately would not).
    const prompt = await nextPrompt();
    expect(prompt).toMatch(/# Conceptual Design Critique/);
    expectEveryRequiredInputOnDisk(prompt);
  });

  it("the test-plan step's inputs — incl. the DERIVED obligation ledger — exist on disk", async () => {
    await seedHostAuthoredUpstreams();
    await buildNextContractPipelineStep(STEP_OPTIONS);
    await seedConceptualCritique();

    // The obligation_ledger + cyclic_seam_resolution intercepts both run inside
    // this call, landing on the test/validator plan.
    const prompt = await nextPrompt();
    expect(prompt).toMatch(/# Test and Validator Plan/);
    expectEveryRequiredInputOnDisk(prompt);
  });

  it("a tool-derived artifact is readable as a PLAIN payload at the path the prompt names", async () => {
    await seedHostAuthoredUpstreams();
    await buildNextContractPipelineStep(STEP_OPTIONS);
    await seedConceptualCritique();
    await buildNextContractPipelineStep(STEP_OPTIONS);

    for (const name of [
      "finalized_module_contracts",
      "obligation_ledger",
      "cyclic_seam_resolution",
    ] as const) {
      const inputPath = contractInputFilePath(ARTIFACTS_DIR, name);
      expect(existsSync(inputPath), `${name}.input.json must exist`).toBe(true);
      const payload = JSON.parse(await readFile(inputPath, "utf8")) as Record<
        string,
        unknown
      >;
      // The host's world is the PLAIN payload — never the tool's envelope.
      expect(payload.content_hash, `${name} input must not be an envelope`).toBeUndefined();
      expect(typeof payload.contract_version).toBe("string");
    }
  });
});
