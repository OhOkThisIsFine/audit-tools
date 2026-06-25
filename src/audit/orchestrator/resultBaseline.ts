/**
 * O2 ↔ F1 residual-risk fix for judge-accepted CE-011: element-staleness for an
 * already-ingested logical result must compare a FRESHLY-COMPUTED current
 * `contentKey` (derived from the LIVE `task_content_signature` at advance time)
 * against a prior BASELINE `contentKey` — and that baseline must live OUTSIDE the
 * immutable per-record ledger instance.
 *
 * Why not read the contentKey off the ledger record? The append-only ledger
 * (INV-O2-1) keys records on `idempotency_key`, which is signature-STABLE: a
 * benign content edit (C1 → C2) does NOT move it, so idempotent re-ingest of the
 * already-ingested result stays a no-op (no duplicate record is appended). If
 * staleness ALSO read its prior contentKey from that same immutable record, the
 * record would still carry C1 and a benign edit could never fire staleness — the
 * exact CE-011 residual hole. So the baseline contentKey is persisted in a
 * SEPARATE store (`artifact_metadata.result_baselines`, keyed by
 * `idempotency_key`) that the staleness gate updates as the live signature moves,
 * while the ledger record itself is never mutated. Append-only ledger invariants
 * are therefore untouched.
 *
 * The comparison driver is the seam's `contentKey` (signature-SENSITIVE), so:
 *   live C2 != baseline C1  ⟹  staleness FIRES,
 * while the seam's signature-STABLE `idempotencyKey` keeps idempotent re-ingest a
 * no-op. The two are reconciled by construction (see src/shared/contentKey.ts).
 */
import {
  buildResultContentDiscriminator,
  contentKey,
  idempotencyKey,
  type ResultEmitSource,
} from "audit-tools/shared";
import {
  METADATA_SCHEMA_VERSION,
  type ArtifactMetadataManifest,
} from "../types/artifactMetadata.js";

/**
 * The baseline store — the per-logical-result contentKey snapshot, keyed by the
 * signature-STABLE `idempotency_key`. Persisted in `artifact_metadata` OUTSIDE
 * the per-record ledger, so updating a baseline never mutates an immutable ledger
 * record (INV-O2-1 untouched).
 */
export type ResultBaselineStore = Record<string, string>;

/** The live coordinate + signature needed to freshly compute the current keys. */
export interface LiveResultKeyInput {
  unit_id: string;
  lens: string;
  pass_id: string;
  /** Tool-owned emit source (base | deepening | steward | redispatch). */
  source: ResultEmitSource;
  /** Required when `source === 'redispatch'`. */
  attempt?: number;
  /**
   * The LIVE task-content signature derived from the current task content at
   * advance time — NEVER a value read off a stored ledger record.
   */
  task_content_signature: string;
}

/**
 * Freshly derive the {idempotency_key, content_key} pair for a live result from
 * the seam — both computed from the live `task_content_signature` at advance
 * time. `idempotency_key` is the baseline-store key (signature-STABLE);
 * `content_key` is the staleness driver (signature-SENSITIVE).
 */
export function deriveLiveResultKeys(input: LiveResultKeyInput): {
  idempotency_key: string;
  content_key: string;
} {
  const discriminator = buildResultContentDiscriminator({
    source: input.source,
    attempt: input.attempt,
  });
  const coordinate = {
    unit_id: input.unit_id,
    lens: input.lens,
    pass_id: input.pass_id,
    result_content_discriminator: discriminator,
  };
  return {
    idempotency_key: idempotencyKey(coordinate),
    content_key: contentKey({
      ...coordinate,
      task_content_signature: input.task_content_signature,
    }),
  };
}

/**
 * Is the already-ingested logical result stale, given its LIVE keys? Stale iff a
 * baseline exists for the idempotency_key AND the freshly-computed live
 * content_key differs from it. A result with no recorded baseline is NOT stale —
 * it has simply never been compared (the first ingest establishes the baseline).
 *
 * The caller supplies live keys via `deriveLiveResultKeys` (freshly computed from
 * the live signature) — this function NEVER reads a contentKey off a ledger
 * record.
 */
export function isResultStaleAgainstBaseline(
  baselines: ResultBaselineStore | undefined,
  liveKeys: { idempotency_key: string; content_key: string },
): boolean {
  const baseline = baselines?.[liveKeys.idempotency_key];
  if (baseline === undefined) return false;
  return baseline !== liveKeys.content_key;
}

/**
 * Return an updated baseline store with this logical result's baseline set to its
 * live content_key. Pure: returns a new object, never mutates the input — so a
 * caller persists the result through the normal artifact_metadata write path.
 * Idempotent: recording the same content_key again yields an equal store.
 */
export function recordResultBaseline(
  baselines: ResultBaselineStore | undefined,
  liveKeys: { idempotency_key: string; content_key: string },
): ResultBaselineStore {
  return {
    ...(baselines ?? {}),
    [liveKeys.idempotency_key]: liveKeys.content_key,
  };
}

/**
 * The FULL per-result staleness coordinate (F1). The grouping fields
 * {unit_id, lens, pass_id} (and even with task_id) are NON-UNIQUE per pass —
 * base vs deepening/steward, or an O3 stage-3 re-dispatch reuse the same
 * coordinate — so the `result_content_discriminator` (tool-owned,
 * buildResultContentDiscriminator) MUST be part of the key (CE-009). It is
 * carried here as `source` (+ `attempt` for re-dispatch); a caller that cannot
 * supply the discriminating source is handled by the fail-safe path below.
 */
export interface ElementCoordinate {
  unit_id: string;
  lens: string;
  pass_id: string;
  task_id?: string;
  /**
   * Tool-owned emit source feeding the discriminator. OMITTED ⇒ the coordinate
   * is under-discriminated and the element fails safe to stale (CE-009) — it is
   * NEVER silently keyed at the non-unique grouping granularity.
   */
  source?: ResultEmitSource;
  /** Required when `source === 'redispatch'`. */
  attempt?: number;
  /** LIVE task-content signature derived at advance time (never off a record). */
  task_content_signature: string;
}

export type ElementVerdict = 'skipped' | 're-derive';

/**
 * Per-element (per discriminated-result-coordinate) staleness verdict (F1). The
 * driver is the CONSUMED contentKey seam (FC-002 tool-owned signatures) over the
 * DISCRIMINATED coordinate — never the bare grouping/identity_key, and never a
 * parallel hashing of element identity here.
 *
 * Fail-safe to `re-derive` (CE-009 / fail-safe staleness) when:
 *  - the coordinate lacks a discriminating `source` (under-discriminated), OR
 *  - the live keys cannot be derived (e.g. a missing/empty signature throws in
 *    the seam), OR
 *  - the freshly-computed live content_key differs from the persisted baseline.
 *
 * `skipped` ONLY when a baseline exists for the idempotency_key AND the live
 * content_key equals it (unchanged element ⇒ skipped by construction). An
 * element with no recorded baseline is `re-derive` (first compare establishes it
 * — never a false skip).
 */
export function perElementStalenessVerdict(
  baselines: ResultBaselineStore | undefined,
  coordinate: ElementCoordinate,
): ElementVerdict {
  if (coordinate.source === undefined) {
    // Under-discriminated coordinate (CE-009): refuse to compare at the
    // non-unique grouping granularity — fail safe to re-derive.
    return 're-derive';
  }
  let liveKeys: { idempotency_key: string; content_key: string };
  try {
    liveKeys = deriveLiveResultKeys({
      unit_id: coordinate.unit_id,
      lens: coordinate.lens,
      pass_id: coordinate.pass_id,
      source: coordinate.source,
      attempt: coordinate.attempt,
      task_content_signature: coordinate.task_content_signature,
    });
  } catch {
    // Uncomparable element state (missing/unreadable signature) ⇒ fail safe.
    return 're-derive';
  }
  const baseline = baselines?.[liveKeys.idempotency_key];
  if (baseline === undefined) return 're-derive';
  return baseline === liveKeys.content_key ? 'skipped' : 're-derive';
}

/**
 * Metadata-migration fail-safe (CE-007). An on-disk manifest is recognized as
 * F1-current ONLY when it carries `metadata_schema_version >= METADATA_SCHEMA_VERSION`.
 * An absent/older tag (a pre-F1, whole-artifact-only manifest) is NOT recognized,
 * so its still-matching whole-artifact hashes must NEVER be trusted to skip a
 * changed element — every element is treated as stale (all re-derived). Pure
 * predicate; never throws.
 */
export function isMetadataManifestCurrent(
  manifest: ArtifactMetadataManifest | undefined,
): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const version = (manifest as { metadata_schema_version?: unknown })
    .metadata_schema_version;
  return typeof version === 'number' && version >= METADATA_SCHEMA_VERSION;
}
