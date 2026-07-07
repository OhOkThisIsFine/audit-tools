/**
 * Typed read/write helpers for the contract-pipeline artifacts.
 *
 * Two distinct, non-overlapping path roles live under
 * `<artifactsDir>/intake/contract/` (D3):
 *
 * - **Host input** `<name>.input.json` — the plain payload the host *writes*,
 *   and the plain payload a downstream host *reads* for its upstreams. The
 *   host's world is entirely plain `.input.json` files; it never sees or
 *   touches an envelope.
 * - **Canonical envelope** `<name>.json` — the tool-owned content-hash envelope
 *   the tool derives at ingest. Purely internal bookkeeping (staleness DAG,
 *   dependency hashes); every tool-side read goes through `readContractArtifact`.
 *
 * No file is ever both: the host writes `<name>.input.json`, the tool owns the
 * canonical `<name>.json` envelope. This keeps the host-authored INPUT path and
 * the tool-derived envelope path cleanly separated (no in-place re-wrap).
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

/**
 * Stamp a tool-owned `created_at` onto a raw artifact payload when the host did
 * not provide one. The host has no clock — `created_at` is tool bookkeeping, not
 * a judgment field — so the tool stamps it at the point the payload enters the
 * tool (ingest + the `validate-artifact` self-check), and the host-facing
 * schemas no longer ask for it. A payload that already carries a string
 * `created_at` (e.g. a tool-derived artifact) is returned untouched. The stamp
 * is a universal non-semantic field (`semanticProjection` strips it), so adding
 * it never affects staleness. Non-object payloads pass through unchanged — their
 * own validator reports the shape error.
 */
export function stampToolCreatedAt(payload: unknown, now: string): unknown {
  if (!isRecord(payload)) return payload;
  if (typeof payload.created_at === "string" && payload.created_at.length > 0) {
    return payload;
  }
  return { ...payload, created_at: now };
}

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

/**
 * Canonical envelope path `<name>.json` — the TOOL-owned content-hash envelope.
 * Host code never reads or writes this; every tool-side consumer reaches it
 * through `readContractArtifact`.
 */
export function contractArtifactFilePath(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): string {
  return join(contractPipelineDir(artifactsDir), `${name}.json`);
}

/**
 * Host input path `<name>.input.json` — the plain payload the host writes (and
 * reads for upstreams). The host never sees the tool's canonical envelope; the
 * tool reads this at ingest, validates, and derives the canonical `<name>.json`
 * envelope from it (D3). Keeping the two paths disjoint means the on-disk file
 * the host wrote is never mutated into an envelope in place.
 */
export function contractInputFilePath(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): string {
  return join(contractPipelineDir(artifactsDir), `${name}.input.json`);
}

function computeHash(value: unknown): string {
  return hashContent(JSON.stringify(value), { length: 32 });
}

/**
 * Hash an artifact's semantic projection (order-independent, stamp-stripped).
 * Exported so the ingest idempotency guard can compare a freshly-read host input
 * against the canonical envelope without re-deriving a new (stamp-bearing)
 * content hash on every next-step.
 */
export function payloadSemanticHash(
  name: ContractPipelineArtifactName,
  payload: unknown,
): string {
  return hashContent(
    stableStringifyProjection(semanticProjection(name, payload)),
    { length: 32 },
  );
}

/**
 * The semantic hash to compare a dependency against. ALWAYS recomputed from the
 * envelope's current `payload` — never read from a stored header field — so an
 * in-place edit to a payload (header untouched) reconverges staleness on the next
 * read. Cosmetic edits project to the same hash (see `semanticProjection`) and so
 * still do not re-stale downstreams (B3).
 */
export function envelopeSemanticHash(
  envelope: ContractPipelineArtifactEnvelope,
): string {
  return payloadSemanticHash(envelope.artifact_name, envelope.payload);
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
    dependency_hashes,
    payload,
  };
  await writeJsonFile(contractArtifactFilePath(artifactsDir, name), envelope);
  return envelope;
}

// ── Incremental reconvergence: empty-delta copy-forward (INV-IR-2) ─────────────

/** The branch a re-emit took: a verbatim carry-forward, or a genuine re-emit. */
export type ContractReconvergenceDecision = "carried_forward" | "reemitted";

export interface ContractReconvergenceResult {
  decision: ContractReconvergenceDecision;
  envelope: ContractPipelineArtifactEnvelope;
}

/**
 * Incrementally re-emit a contract artifact (contract-incremental-reconvergence,
 * INV-IR-2). Given a freshly re-derived payload, compare its semantic projection to
 * the PRIOR stored payload's using the SAME `payloadSemanticHash` the DEPENDENCY_MAP
 * staleness walk uses (INV-IR-3):
 *
 *  - **Empty delta** (`payloadSemanticHash(name, prior) === payloadSemanticHash(name,
 *    reDerived)`): a stamp/order-only upstream edit. The PRIOR payload is
 *    re-enveloped forward VERBATIM — its dependency hashes reconverge to the current
 *    upstreams (so the DAG stops reporting it stale) while the payload bytes are
 *    unchanged — with ZERO worker/LLM dispatch. Because the load-bearing statement
 *    prose is RETAINED in the projection (`semanticProjection`), a meaning-changing
 *    reword is NOT an empty delta and therefore never collapses to a carry (CE-006).
 *  - **Non-empty delta**: the re-derived payload is written as a genuine re-emit.
 *
 * The `decision` lets the caller gate any worker dispatch on `"reemitted"` — a
 * carry-forward is guaranteed dispatch-free. (The batched structural gate, owned by
 * contract-validation-gates, still runs over any re-emitted items — this function
 * only decides carry-vs-reemit, it does not bypass validation.)
 */
export async function reconvergeContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  reDerivedPayload: unknown,
): Promise<ContractReconvergenceResult> {
  const prior = await readContractArtifact(artifactsDir, name);
  const priorPayload = envelopePayload(prior);
  if (
    prior &&
    priorPayload !== undefined &&
    payloadSemanticHash(name, priorPayload) === payloadSemanticHash(name, reDerivedPayload)
  ) {
    // Empty delta → carry the prior payload forward verbatim (INV-IR-2/IR-4:
    // identity/order/classification preserved because the exact prior bytes are kept).
    const envelope = await writeContractArtifact(artifactsDir, name, priorPayload);
    return { decision: "carried_forward", envelope };
  }
  const envelope = await writeContractArtifact(artifactsDir, name, reDerivedPayload);
  return { decision: "reemitted", envelope };
}

/**
 * Payload of a stored artifact whether or not it has been enveloped yet. A null
 * envelope (absent on disk) yields undefined; a bare payload that was written
 * without the envelope wrapper is returned as-is. Single-sourced here so every
 * consumer unwraps identically (cannot drift from `isEnvelope`).
 */
export function envelopePayload(
  envelope: ContractPipelineArtifactEnvelope | null,
): unknown {
  if (!envelope) return undefined;
  return isEnvelope(envelope) ? envelope.payload : envelope;
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
      const recordedHash = (envelope.dependency_hashes ?? {})[dep];
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
