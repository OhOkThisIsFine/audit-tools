/**
 * Phase-cut sidecar artifact (remediator auto-phasing, T3).
 *
 * The foundations→consumers phase cut derived by {@link derivePhaseCut} is a
 * DERIVED, deterministic artifact (a pure function of the finalized module
 * contracts' module-dependency DAG — producer/consumer `artifact:<name>` tokens
 * in `inputs`/`outputs`, unioned with any `neighbor_needs`). It is persisted as a
 * first-class sidecar —
 * `intake/contract/phase_cut.json` — so the cut the conceptual critique sees and
 * the cut the implementation-DAG promotion enforces are ONE source, inspectable
 * on disk, not two inline recomputations that could drift.
 *
 * It is deliberately NOT a member of `CP_ARTIFACT_NAMES`: that enum drives the
 * LLM-phase staleness DAG and the phase-progression completeness checks, where an
 * "absent" entry perturbs sequencing. The cut is re-derivable on demand from
 * `finalized_module_contracts`, so it carries no staleness envelope — it is simply
 * (re)written whenever its single upstream is available, and read by consumers.
 */

import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import {
  contractPipelineDir,
  readContractArtifact,
  envelopePayload,
} from "./artifactStore.js";
import {
  derivePhaseCut,
  phaseCutModulesFromContracts,
  type PhaseCut,
} from "./phaseCut.js";

export const PHASE_CUT_FILE = "phase_cut.json";

export function phaseCutFilePath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), PHASE_CUT_FILE);
}

/** Read the persisted cut, or null if it has not been written yet. */
export async function readPhaseCutArtifact(
  artifactsDir: string,
): Promise<PhaseCut | null> {
  return (await readOptionalJsonFile<PhaseCut>(phaseCutFilePath(artifactsDir))) ?? null;
}

/**
 * Derive the cut from the on-disk `finalized_module_contracts` and (re)write the
 * sidecar. Idempotent: a finalized-contracts payload that yields the same DAG
 * yields byte-identical JSON. Returns the derived cut, or null when there are no
 * in-scope modules to phase (no finalized contracts on disk yet).
 */
export async function ensurePhaseCutArtifact(
  artifactsDir: string,
): Promise<PhaseCut | null> {
  const finalized = envelopePayload(
    await readContractArtifact(artifactsDir, "finalized_module_contracts"),
  );
  const modules = phaseCutModulesFromContracts(finalized);
  if (modules.length === 0) return null;
  const cut = derivePhaseCut(modules);
  await writeJsonFile(phaseCutFilePath(artifactsDir), cut);
  return cut;
}
