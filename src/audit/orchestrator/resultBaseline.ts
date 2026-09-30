// sites-pinned: tests/audit/result-baseline-staleness.test.ts, tests/audit/ledger.test.ts, tests/audit/audit-frontier.test.ts
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
  resultDiscriminatorForEmit,
  buildTaskContentSignature,
  contentKey,
  idempotencyKey,
  splitDiscriminatorFromTaskId,
  type ResultEmitSource,
} from "audit-tools/shared";
import {
  METADATA_SCHEMA_VERSION,
  type ArtifactMetadataManifest,
} from "../types/artifactMetadata.js";
import type { AuditResult, AuditTask } from "../types.js";
import { emitSourceFor, maxRedispatchAttempt, selectCurrentResults } from "./ledger.js";

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
  /**
   * The result's task_id — its file-split sibling discriminator is derived from
   * it (INV-CK-2) so split siblings of one {unit_id, lens, pass_id}
   * coordinate freshly compute DISTINCT live keys, matching what
   * `stampLedgerKeys` stamped. Omitted ⇒ lone-base key (no split component).
   */
  task_id?: string;
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
  const discriminator = buildResultContentDiscriminator(
    resultDiscriminatorForEmit(input.source, {
      attempt: input.attempt,
      task_id: input.task_id,
      split_discriminator: splitDiscriminatorFromTaskId(input.task_id, input.lens),
    }),
  );
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

/**
 * The LIVE task-content signature for a result's owning task, derived at advance
 * time from the CURRENT task content (never off a stored ledger record). Only the
 * fields that define the audited material feed the signature — the identity
 * (`task_id`), lifecycle (`status`, `completed_at`, `completion_reason`), and
 * planning metadata (`token_estimate`, `risk_estimate`, `tags`)
 * are deliberately excluded so a benign status flip or estimate refresh never
 * re-fires staleness. A genuine change to the files/ranges/inputs/rationale under
 * review moves the signature and re-fires (CE-011). The basis is single-sourced
 * here so record, consume, and drift-rekey hash identically.
 */
export function taskContentSignatureForTask(task: AuditTask): string {
  return buildTaskContentSignature({
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_paths: task.file_paths,
    line_ranges: task.line_ranges,
    file_line_counts: task.file_line_counts,
    inputs: task.inputs,
    rationale: task.rationale,
  });
}

/**
 * Freshly derive a result's live keys from its owning task's current content and
 * the result's CURRENT emit lineage (`emitSourceFor` reads a persisted
 * `emit_source`/`attempt` first). Returns undefined when the live keys cannot be
 * derived (e.g. empty task content, or a redispatch record missing its attempt) —
 * the caller fails safe.
 */
function liveKeysForResult(
  result: AuditResult,
  task: AuditTask,
): { idempotency_key: string; content_key: string } | undefined {
  try {
    return deriveLiveResultKeys({
      unit_id: result.unit_id,
      lens: result.lens,
      pass_id: result.pass_id,
      task_id: result.task_id,
      source: emitSourceFor(result),
      attempt: result.attempt,
      task_content_signature: taskContentSignatureForTask(task),
    });
  } catch {
    return undefined;
  }
}

/**
 * Record (refresh) the baselines for a batch of just-ingested results to their
 * LIVE content_key, keyed by each result's CURRENT (possibly re-keyed) lineage.
 * Called from the ingestion executor AFTER drift re-keying, so a re-dispatched
 * result refreshes the baseline under its NEW redispatch idempotency_key — which
 * is the lineage `selectCurrentResults` then resolves to, so staleness clears and
 * the loop converges. Pure: returns a new store. A result whose owning task is
 * absent (no derivable live signature) is left untouched.
 */
export function refreshResultBaselines(
  baselines: ResultBaselineStore | undefined,
  results: readonly AuditResult[],
  tasksByTaskId: ReadonlyMap<string, AuditTask>,
): ResultBaselineStore {
  let store: ResultBaselineStore = { ...(baselines ?? {}) };
  for (const result of results) {
    const task = result.task_id
      ? tasksByTaskId.get(result.task_id)
      : undefined;
    if (!task) continue;
    const liveKeys = liveKeysForResult(result, task);
    if (!liveKeys) continue;
    store = recordResultBaseline(store, liveKeys);
  }
  return store;
}

/**
 * The set of task_ids whose CURRENT result has DRIFTED from its recorded baseline
 * — the live task content moved since the result was produced. Consumed by the
 * obligation state and pending-work selection to treat those tasks as
 * not-yet-complete so they return for review. Caller passes the
 * SUPERSESSION-RESOLVED results
 * (`selectCurrentResults`) so a superseded base record never keeps firing after
 * its re-dispatch landed. A result with no matching task, no recorded baseline
 * (never compared), or an underivable signature is not reported stale here.
 */
export function computeStaleResultTaskIds(
  results: readonly AuditResult[],
  tasks: readonly AuditTask[],
  baselines: ResultBaselineStore | undefined,
): Set<string> {
  const stale = new Set<string>();
  if (!baselines) return stale;
  const tasksByTaskId = new Map(tasks.map((task) => [task.task_id, task]));
  for (const result of results) {
    if (!result.task_id) continue;
    const task = tasksByTaskId.get(result.task_id);
    if (!task) continue;
    const liveKeys = liveKeysForResult(result, task);
    if (!liveKeys) continue;
    if (isResultStaleAgainstBaseline(baselines, liveKeys)) {
      stale.add(result.task_id);
    }
  }
  return stale;
}

/**
 * Drift re-keying authority (O3). A just-submitted result whose owning task's
 * live content has drifted from the baseline for its current accepted identity
 * is re-keyed `emit_source: 'redispatch'` with the next 1-based `attempt`, and its
 * stamped ledger keys are cleared so `appendResultsToLedger` re-stamps a DISTINCT
 * idempotency_key (the append-only ledger accepts the fresh findings instead of
 * no-opping on a signature-stable key). Deterministic + fully tool-owned:
 * the host never authors `emit_source`/`attempt`. Unchanged replays retain the
 * current accepted identity; absent tasks or baselines are not invented.
 */
export function rekeyDriftedResults(
  incoming: readonly AuditResult[],
  tasksByTaskId: ReadonlyMap<string, AuditTask>,
  baselines: ResultBaselineStore | undefined,
  existingLedger: readonly AuditResult[],
): AuditResult[] {
  if (!baselines) return [...incoming];
  const currentByTask = new Map(selectCurrentResults(existingLedger).map((result) => [result.task_id, result]));
  return incoming.map((result) => {
    const task = result.task_id ? tasksByTaskId.get(result.task_id) : undefined;
    if (!task) return result;
    // Every task family can be reissued. Compare with the CURRENT accepted
    // attempt, not the original base/deepening key, or replay after one source
    // change would manufacture another attempt forever.
    const current = currentByTask.get(result.task_id);
    const liveKeys = liveKeysForResult(current ?? result, task);
    if (!liveKeys) return result;
    const baseline = baselines[liveKeys.idempotency_key];
    if (baseline === undefined || baseline === liveKeys.content_key) {
      if (current && (emitSourceFor(current) !== emitSourceFor(result) || current.attempt !== result.attempt)) {
        // The host repeats its original envelope, never authors attempt keys.
        // Rebind an unchanged replay to the current accepted identity so the
        // append-only ledger remains idempotent after a redispatch too.
        return { ...result, emit_source: emitSourceFor(current), attempt: current.attempt,
          instance_id: undefined, identity_key: current.identity_key, idempotency_key: current.idempotency_key };
      }
      return result;
    }
    return {
      ...result,
      emit_source: "redispatch",
      attempt: maxRedispatchAttempt(existingLedger, result.task_id) + 1,
      instance_id: undefined,
      identity_key: undefined,
      idempotency_key: undefined,
    };
  });
}
