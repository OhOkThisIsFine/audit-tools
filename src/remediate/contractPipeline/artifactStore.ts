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
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  hashContent,
  isRecord,
  readOptionalJsonFile,
  stableStringify,
  writeJsonFile,
} from "audit-tools/shared";
import {
  semanticProjection,
  stableStringifyProjection,
} from "./semanticProjection.js";

// ── Artifact names ────────────────────────────────────────────────────────────
// Defined in ./artifactNames.js (below both this module and semanticProjection,
// which needs the name type — declaring it here closed a type-only cycle).
// Re-exported so existing importers are unchanged.

import { CP_ARTIFACT_NAMES } from "./artifactNames.js";
import type { ContractPipelineArtifactName } from "./artifactNames.js";
export { CP_ARTIFACT_NAMES };
export type { ContractPipelineArtifactName };

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
  /**
   * Identity of this exact emission: `hashContent(stableStringify(payload))`.
   * KEY-ORDER INDEPENDENT — the same payload assembled in a different field
   * order hashes identically (see `computeHash`).
   *
   * A stored header that disagrees with the payload it sits beside is CORRECTED
   * IN MEMORY on read and NOT persisted: `readContractArtifact` recomputes,
   * returns the recomputed value, and emits a
   * `contract_artifact_content_hash_mismatch` warning naming both hashes. The
   * file on disk keeps whatever it was written with, so this field is the
   * identity of the payload AS READ, never a claim about the stored bytes.
   */
  content_hash: string;
  /** Semantic-projection hashes of upstream dependency artifacts at write time. */
  dependency_hashes: Partial<Record<ContractPipelineArtifactName, string>>;
  payload: unknown;
}

/**
 * Surface a `content_hash` header that no longer describes its payload.
 *
 * The correction itself is silent-by-design (the payload is authoritative and
 * the read still returns), but a disagreement between a stored header and the
 * bytes beside it is a FACT someone needs: it means the envelope was edited in
 * place, copied, or written by an older hash definition, and the recorded value
 * is the identity the judge/critique repair ledger keys on. A silent in-memory
 * rewrite turns that into a run that behaves correctly and explains nothing.
 *
 * Same shape as the repository's other structured warnings
 * (`file_integrity_io_error` in `utils/fileIntegrity.ts`,
 * `truncated_verification_file_list` in the audit side): one `level: "warn"`
 * JSON object per line on stderr, so a log reader that already parses these
 * needs no new case.
 */
function reportContentHashMismatch(
  name: ContractPipelineArtifactName,
  stored: string,
  recomputed: string,
): void {
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      event: "contract_artifact_content_hash_mismatch",
      artifact_name: name,
      stored_content_hash: stored,
      recomputed_content_hash: recomputed,
      ts: new Date().toISOString(),
    }) + "\n",
  );
}

/** One dependency hash entry: a contract-pipeline artifact name → sha. */
function isDependencyHashes(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, hash]) =>
        (CP_ARTIFACT_NAMES as readonly string[]).includes(key) &&
        typeof hash === "string",
    )
  );
}

/**
 * Canonical predicate for a stored content-hash envelope. Single-sourced here so
 * any consumer (the contract-pipeline ingest path, the `validate-artifact` CLI)
 * unwraps with identical structural rules and cannot drift. A plain payload that
 * happens to carry an `artifact_name` but no `content_hash` is NOT an envelope.
 *
 * The THREE-KEY test this used to be (`artifact_name` string, `content_hash`
 * string, `"payload" in value`) was a cast wearing a predicate's name: it admits
 * a bare payload that carries `await`-shaped fields, and — more to the point —
 * it does not check that `artifact_name` is one of the fifteen names the
 * dependency DAG and the semantic projection are keyed by. An envelope whose
 * `artifact_name` was misspelled passes `isEnvelope`, then reads a projection
 * table with an absent key. See {@link readContractArtifact}, which is where
 * that binding is now enforced.
 */
export function isEnvelope(
  value: unknown,
): value is ContractPipelineArtifactEnvelope {
  return (
    isRecord(value) &&
    (CP_ARTIFACT_NAMES as readonly string[]).includes(value.artifact_name as string) &&
    typeof value.content_hash === "string" &&
    value.content_hash.length > 0 &&
    "payload" in value &&
    isDependencyHashes(value.dependency_hashes)
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
 * Where a review artifact's diff-based re-review snapshot lives.
 *
 * Single-sourced here, beside the artifact path helpers, because the ARCHIVE
 * boundary has to reach it from a module that must not import the snapshot
 * module's own read/write surface. Kept as a filename rather than a computed
 * `join` in each caller so the two can never disagree about the directory.
 */
export const REVIEW_SNAPSHOT_DIRNAME = "review-snapshots";

export function reviewSnapshotDirPath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), REVIEW_SNAPSHOT_DIRNAME);
}

export function reviewSnapshotFilePath(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): string {
  return join(reviewSnapshotDirPath(artifactsDir), `${name}.json`);
}

/**
 * Drop a review artifact's diff-based re-review snapshot.
 *
 * Called when the artifact's INPUT is destroyed — the ordinary re-emit after an
 * archive, and the promotion rejection that rolls a promoted plan back. The
 * snapshot holds the verdict a re-review would re-affirm, and its whole value
 * depends on being the LAST verdict for THAT input. Left in place across a
 * rewrite it becomes worse than absent: `captureReviewSnapshot` runs at INGEST,
 * which happens AFTER ingest's own staleness pass, so the archive pass inside
 * THIS invocation has already gone by — a snapshot surviving the intervening
 * call would be diffed against the NEW payload while claiming to be the prior
 * verdict, and the worker would be told to re-affirm a verdict about content it
 * never saw. With none present, `buildReReviewSection` renders no section and
 * the phase runs as an ordinary full review, which is correct.
 *
 * Deliberately NOT called for the `stale` archive: that path re-opens a
 * DOWNSTREAM artifact, which by construction has no snapshot of its own (its
 * producer never ran), so there is nothing there to drop and the call would be
 * noise in a hot loop.
 */
export async function dropReviewSnapshot(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): Promise<void> {
  await rm(reviewSnapshotFilePath(artifactsDir, name), { force: true });
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

/**
 * The content hash of a payload — the artifact's IDENTITY, and the value the
 * judge/critique repair ledger keys on.
 *
 * `stableStringify`, not `JSON.stringify`. The hash must depend on the payload's
 * CONTENT and on nothing else, and raw `JSON.stringify` makes it depend on KEY
 * INSERTION ORDER as well: the same contract assembled in a different field
 * order hashes differently. That was latent while the only reader of the header
 * was the writer's own round trip, but the moment a read RECOMPUTES and compares
 * (see {@link readContractArtifact}) it becomes a false tamper report on a file
 * nobody touched. The single deterministic serializer is the shared one
 * (INV-CK-2: "there must be exactly ONE such serializer — never write a second"),
 * so write and read agree by construction rather than by both happening to call
 * the same expression.
 */
function computeHash(value: unknown): string {
  return hashContent(stableStringify(value), { length: 32 });
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

/**
 * Write a TOOL-DERIVED artifact to BOTH path roles: the plain payload at the
 * host-input path `<name>.input.json` and the canonical envelope at
 * `<name>.json`.
 *
 * Why the input path too. Every host-facing artifact path the pipeline renders —
 * both where a role WRITES its output and where it READS its upstreams — is
 * `<name>.input.json` (D3: the host's world is entirely plain input files). An
 * artifact the TOOL derives (the obligation ledger, the finalized contracts, a
 * degenerate seam report, a no-cycles seam resolution, a merged shard aggregate)
 * used to land only in the canonical envelope, so any downstream prompt naming
 * it pointed a worker at a file that never existed. Materializing it here makes
 * that ENOENT class unrepresentable: the write map and the prompts' input map
 * are the same map.
 *
 * Deliberately NOT folded into `writeContractArtifact`: that one is also how
 * INGEST wraps a host-authored payload, and writing back there would mutate the
 * host's own input file in place — the exact separation D3 exists to keep. The
 * derived input file is idempotent for ingest: its semantic projection matches
 * the canonical envelope's, so the ingest idempotency guard skips it on every
 * later pass rather than re-deriving.
 */
export async function writeDerivedContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<ContractPipelineArtifactEnvelope> {
  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(contractInputFilePath(artifactsDir, name), payload);
  return writeContractArtifact(artifactsDir, name, payload);
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

/**
 * Read a stored artifact envelope, or null if absent.
 *
 * Three checks, all of them about IDENTITY — the file at `<name>.json` must BE
 * the artifact `<name>`, not merely a JSON document that was found there:
 *
 *  1. **Shape.** Parsed against {@link isEnvelope}, never cast. The previous
 *     body was `readOptionalJsonFile<ContractPipelineArtifactEnvelope>` — a
 *     generic TYPE PARAMETER, which is an assertion the compiler erases. A file
 *     containing `{"hello":1}` came back typed as an envelope, and every
 *     downstream `.artifact_name` / `.payload` read was an unchecked property
 *     access on `unknown`-shaped data.
 *  2. **Binding.** `artifact_name` must equal the name that was REQUESTED. The
 *     two are the same value by construction on the write path
 *     ({@link writeContractArtifact} passes one name to both), so a disagreement
 *     means the file was written by something else — a hand edit, a copy, a
 *     rename that missed the header. This is not cosmetic: `artifact_name` is
 *     the key into `DEPENDENCY_MAP` and `semanticProjection`, and a mismatched
 *     name silently reads another artifact's projection table. A mismatched
 *     envelope reads as ABSENT, so the caller's staleness DAG re-opens the
 *     producing phase rather than consuming bytes that cannot be trusted.
 *  3. **Content hash.** Recomputed from the payload and, when it disagrees with
 *     the recorded one, the envelope is returned with
 *     {@link ContractPipelineArtifactEnvelope.content_hash} rewritten to the
 *     RECOMPUTED value. The payload is authoritative — it is what every
 *     consumer reads and what `envelopeSemanticHash` projects — so a header
 *     that no longer describes its payload must not be allowed to keep
 *     speaking. Reading the payload but reporting the stale header's hash is
 *     exactly the failure `detectStaleArtifacts`'s recompute-on-read exists to
 *     prevent (see its note on in-place edits), and the hash is the identity
 *     the judge/critique repair ledger keys on (`judge_hash` /
 *     `critique_hash` in repairState.ts), so a drifted value would make
 *     "already repaired for this report" answer about the wrong report.
 *
 *     Deliberately NOT a null: treating a payload edit as an absent artifact
 *     would erase the distinction the caller needs (absent ⇒ re-emit the
 *     producer; edited ⇒ re-stale the downstreams), and it is a real thing
 *     hosts and tests do.
 *
 * A shape or binding refusal is silent-by-return (null), not a throw: every
 * caller already handles absent (that IS the fresh-run case), and throwing here
 * would turn one damaged file into a failed `next-step` rather than a re-emitted
 * phase.
 */
export async function readContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
): Promise<ContractPipelineArtifactEnvelope | null> {
  const raw = await readOptionalJsonFile<unknown>(
    contractArtifactFilePath(artifactsDir, name),
  );
  if (raw === undefined || raw === null) return null;
  if (!isEnvelope(raw)) return null;
  if (raw.artifact_name !== name) return null;
  // Recompute through the SAME `computeHash` the writer used — one serializer
  // for both directions (`stableStringify`, key-order independent), so a
  // round-trip through disk always agrees and only a real payload edit fails.
  // Re-deriving the expression here instead of calling the writer's would be a
  // second copy of the hash definition, which is how a write and a read come to
  // disagree about what "the same payload" means.
  const actualHash = computeHash(raw.payload);
  if (actualHash !== raw.content_hash) {
    reportContentHashMismatch(name, raw.content_hash, actualHash);
    return { ...raw, content_hash: actualHash };
  }
  return raw;
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
