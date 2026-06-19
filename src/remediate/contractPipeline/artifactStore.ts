/**
 * Typed read/write helpers for the contract-pipeline artifacts.
 * Each artifact is stored as a JSON file under
 * `<artifactsDir>/intake/contract/`. A content hash is included in the
 * stored envelope so downstream artifacts can detect when an upstream
 * changed, enabling deterministic staleness propagation.
 *
 * Independence from StateStore is intentional: these helpers operate on the
 * contract-pipeline subdirectory only and do not touch the remediation
 * state machine.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hashContent, isRecord, readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import {
  semanticProjection,
  stableStringifyProjection,
} from "./semanticProjection.js";

// ── Artifact names ────────────────────────────────────────────────────────────

export const CP_ARTIFACT_NAMES = [
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
  "implementation_dag",
  "verification_report",
] as const;

export type ContractPipelineArtifactName = (typeof CP_ARTIFACT_NAMES)[number];

// ── Dependency DAG ────────────────────────────────────────────────────────────
// An artifact is stale when any dependency it lists is missing or has a
// different content hash than recorded at write time.

export const DEPENDENCY_MAP: Record<ContractPipelineArtifactName, ContractPipelineArtifactName[]> = {
  goal_spec: [],
  context_bundle: ["goal_spec"],
  module_decomposition: ["goal_spec", "context_bundle"],
  module_contracts: ["goal_spec", "context_bundle", "module_decomposition"],
  seam_reconciliation_report: ["module_decomposition", "module_contracts"],
  finalized_module_contracts: ["module_contracts", "seam_reconciliation_report"],
  conceptual_design_critique: ["goal_spec", "finalized_module_contracts"],
  obligation_ledger: ["goal_spec", "finalized_module_contracts"],
  cyclic_seam_resolution: ["obligation_ledger"],
  test_validator_plan: ["goal_spec", "obligation_ledger"],
  contract_assessment_report: ["goal_spec", "finalized_module_contracts", "obligation_ledger", "cyclic_seam_resolution", "test_validator_plan"],
  counterexample: ["goal_spec", "finalized_module_contracts", "obligation_ledger", "cyclic_seam_resolution", "test_validator_plan", "contract_assessment_report"],
  judge_report: ["goal_spec", "finalized_module_contracts", "obligation_ledger", "cyclic_seam_resolution", "test_validator_plan", "contract_assessment_report", "counterexample"],
  implementation_dag: [
    "goal_spec",
    "context_bundle",
    "finalized_module_contracts",
    "obligation_ledger",
    "cyclic_seam_resolution",
    "test_validator_plan",
    "contract_assessment_report",
    "counterexample",
    "judge_report",
  ],
  verification_report: [
    "goal_spec",
    "context_bundle",
    "finalized_module_contracts",
    "obligation_ledger",
    "contract_assessment_report",
    "implementation_dag",
  ],
};

// ── Stored envelope ───────────────────────────────────────────────────────────

export interface ContractPipelineArtifactEnvelope {
  artifact_name: ContractPipelineArtifactName;
  /** SHA-256 of the raw payload bytes — byte identity of this exact emission. */
  content_hash: string;
  /**
   * SHA-256 of the artifact's SEMANTIC PROJECTION (load-bearing structure only;
   * see `semanticProjection`). This — not `content_hash` — is what staleness
   * records and compares, so a cosmetic upstream edit does not re-stale
   * downstreams (B3). Optional for forward-compat with envelopes written before
   * this field existed; `envelopeSemanticHash` recomputes it on read when absent.
   */
  semantic_hash?: string;
  /** Semantic-projection hashes of upstream dependency artifacts at write time. */
  dependency_hashes: Partial<Record<ContractPipelineArtifactName, string>>;
  payload: unknown;
}

/**
 * Canonical predicate for a stored content-hash envelope. Single-sourced here so
 * any consumer (the contract-pipeline ingest path, the `validate-artifact` CLI)
 * unwraps with identical structural rules and cannot drift. A plain payload that
 * happens to carry an `artifact_name` but no `content_hash` is NOT an envelope.
 */
export function isEnvelope(
  value: unknown,
): value is ContractPipelineArtifactEnvelope {
  return (
    isRecord(value) &&
    typeof value.artifact_name === "string" &&
    typeof value.content_hash === "string" &&
    "payload" in value
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function contractPipelineDir(artifactsDir: string): string {
  return join(artifactsDir, "intake", "contract");
}

/**
 * Path to the optional Path-A seed file. Present only when the intake source
 * is a structured audit-findings report; absent for document/conversation runs.
 */
export function pathASeedFilePath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), "path_a_seed.json");
}

export function contractArtifactFilePath(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): string {
  return join(contractPipelineDir(artifactsDir), `${name}.json`);
}

function computeHash(value: unknown): string {
  return hashContent(JSON.stringify(value), { length: 32 });
}

/** Hash an artifact's semantic projection (order-independent, stamp-stripped). */
function computeSemanticHash(
  name: ContractPipelineArtifactName,
  payload: unknown,
): string {
  return hashContent(
    stableStringifyProjection(semanticProjection(name, payload)),
    { length: 32 },
  );
}

/**
 * The semantic hash to compare a dependency against. Prefers the envelope's
 * recorded `semantic_hash`; recomputes from the payload for envelopes written
 * before the field existed (no migration needed — staleness stays correct on the
 * first read of a legacy envelope).
 */
export function envelopeSemanticHash(
  envelope: ContractPipelineArtifactEnvelope,
): string {
  return (
    envelope.semantic_hash ??
    computeSemanticHash(envelope.artifact_name, envelope.payload)
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Write an artifact envelope. Creates parent directories as needed. */
export async function writeContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<ContractPipelineArtifactEnvelope> {
  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  const content_hash = computeHash(payload);
  const semantic_hash = computeSemanticHash(name, payload);

  // Capture each dependency's SEMANTIC-projection hash at write time, so a later
  // cosmetic edit to that dependency (same projection) does not re-stale this
  // artifact — only a load-bearing change does (B3).
  const dependency_hashes: Partial<Record<ContractPipelineArtifactName, string>> = {};
  for (const dep of DEPENDENCY_MAP[name]) {
    const depEnvelope = await readContractArtifact(artifactsDir, dep);
    if (depEnvelope) {
      dependency_hashes[dep] = envelopeSemanticHash(depEnvelope);
    }
  }

  const envelope: ContractPipelineArtifactEnvelope = {
    artifact_name: name,
    content_hash,
    semantic_hash,
    dependency_hashes,
    payload,
  };
  await writeJsonFile(contractArtifactFilePath(artifactsDir, name), envelope);
  return envelope;
}

/** Read a stored artifact envelope, or null if absent. */
export async function readContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): Promise<ContractPipelineArtifactEnvelope | null> {
  const envelope = await readOptionalJsonFile<ContractPipelineArtifactEnvelope>(
    contractArtifactFilePath(artifactsDir, name),
  );
  if (!envelope) return null;
  return envelope;
}

export interface StalenessResult {
  /** Names of artifacts that are stale (upstream changed) or missing (never written). */
  stale: ContractPipelineArtifactName[];
  /** Names of artifacts that are absent (file does not exist). */
  absent: ContractPipelineArtifactName[];
}

/**
 * Detect stale artifacts by walking the dependency DAG transitively.
 * An artifact is stale when:
 * - A dependency artifact is absent/missing.
 * - A dependency artifact's current SEMANTIC-projection hash differs from what
 *   was recorded at write time in this artifact's envelope. Cosmetic upstream
 *   edits (reworded prose, regenerated timestamps, reordered keys) project to
 *   the same hash and do NOT mark downstreams stale (B3).
 *
 * Absent artifacts (never written) are reported under `absent`, not `stale`.
 */
export async function detectStaleArtifacts(
  artifactsDir: string,
): Promise<StalenessResult> {
  const stale = new Set<ContractPipelineArtifactName>();
  const absent = new Set<ContractPipelineArtifactName>();

  // Read all present envelopes up front to avoid repeated disk reads.
  const envelopes = new Map<ContractPipelineArtifactName, ContractPipelineArtifactEnvelope | null>();
  for (const name of CP_ARTIFACT_NAMES) {
    envelopes.set(name, await readContractArtifact(artifactsDir, name));
  }

  for (const name of CP_ARTIFACT_NAMES) {
    const envelope = envelopes.get(name);
    if (!envelope) {
      absent.add(name);
      continue;
    }

    // Check each immediate dependency.
    for (const dep of DEPENDENCY_MAP[name]) {
      const depEnvelope = envelopes.get(dep);
      if (!depEnvelope) {
        // Dependency is absent — downstream is stale.
        stale.add(name);
        break;
      }
      const recordedHash = envelope.dependency_hashes[dep];
      if (recordedHash !== envelopeSemanticHash(depEnvelope)) {
        stale.add(name);
        break;
      }
    }
  }

  // Propagate transitively: if a dependency is stale, all downstream are stale.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of CP_ARTIFACT_NAMES) {
      if (stale.has(name) || absent.has(name)) continue;
      for (const dep of DEPENDENCY_MAP[name]) {
        if (stale.has(dep) || absent.has(dep)) {
          stale.add(name);
          changed = true;
          break;
        }
      }
    }
  }

  return {
    stale: [...stale],
    absent: [...absent],
  };
}

/** Returns true when the artifact file is present on disk. */
export function contractArtifactExists(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): boolean {
  return existsSync(contractArtifactFilePath(artifactsDir, name));
}
