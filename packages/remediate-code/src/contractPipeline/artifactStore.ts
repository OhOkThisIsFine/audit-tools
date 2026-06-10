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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "@audit-tools/shared";

// ── Artifact names ────────────────────────────────────────────────────────────

export const CP_ARTIFACT_NAMES = [
  "goal_spec",
  "context_bundle",
  "design_spec",
  "conceptual_design_critique",
  "obligation_ledger",
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

const DEPENDENCY_MAP: Record<ContractPipelineArtifactName, ContractPipelineArtifactName[]> = {
  goal_spec: [],
  context_bundle: ["goal_spec"],
  design_spec: ["goal_spec", "context_bundle"],
  conceptual_design_critique: ["goal_spec", "design_spec"],
  obligation_ledger: ["goal_spec", "design_spec"],
  contract_assessment_report: ["goal_spec", "design_spec", "obligation_ledger"],
  counterexample: ["goal_spec", "design_spec", "obligation_ledger", "contract_assessment_report"],
  judge_report: ["goal_spec", "design_spec", "obligation_ledger", "contract_assessment_report", "counterexample"],
  implementation_dag: [
    "goal_spec",
    "context_bundle",
    "design_spec",
    "obligation_ledger",
    "contract_assessment_report",
    "counterexample",
    "judge_report",
  ],
  verification_report: [
    "goal_spec",
    "context_bundle",
    "design_spec",
    "obligation_ledger",
    "contract_assessment_report",
    "implementation_dag",
  ],
};

// ── Stored envelope ───────────────────────────────────────────────────────────

export interface ContractPipelineArtifactEnvelope {
  artifact_name: ContractPipelineArtifactName;
  content_hash: string;
  /** Hashes of upstream dependency artifacts at write time. */
  dependency_hashes: Partial<Record<ContractPipelineArtifactName, string>>;
  payload: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function contractPipelineDir(artifactsDir: string): string {
  return join(artifactsDir, "intake", "contract");
}

export function contractArtifactFilePath(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): string {
  return join(contractPipelineDir(artifactsDir), `${name}.json`);
}

function computeHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
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

  // Capture dependency hashes at write time.
  const dependency_hashes: Partial<Record<ContractPipelineArtifactName, string>> = {};
  for (const dep of DEPENDENCY_MAP[name]) {
    const depEnvelope = await readContractArtifact(artifactsDir, dep);
    if (depEnvelope) {
      dependency_hashes[dep] = depEnvelope.content_hash;
    }
  }

  const envelope: ContractPipelineArtifactEnvelope = {
    artifact_name: name,
    content_hash,
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
 * - A dependency artifact's current content hash differs from what was recorded
 *   at write time in this artifact's envelope.
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
      if (recordedHash !== depEnvelope.content_hash) {
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
