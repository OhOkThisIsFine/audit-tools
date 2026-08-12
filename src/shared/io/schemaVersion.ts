/**
 * Schema-version read policy — the two directions, named so the choice is
 * unmissable at the call site.
 *
 * State written by an older version of the tool is read back under the CURRENT
 * version's semantics. A reader that never compares the stamped version (spelled
 * `schema_version` on artifacts, `contract_version` on contracts — both are read
 * here) silently reinterprets old bytes as new-shape data. Stamping a version on
 * WRITE and not comparing it on READ is therefore not "versioned" at all — it is
 * an unchecked cast wearing a version field.
 *
 * There are exactly two correct policies, and which one applies is a property
 * of the STATE, not of the module:
 *
 *   - **Regenerable state** (a cache, a carry, a snapshot, a derived index —
 *     anything the pipeline can rebuild from its inputs at the cost of some
 *     recompute): a mismatch means TREAT AS ABSENT and rebuild. Throwing here
 *     would strand a run on a file it is perfectly able to reproduce.
 *     → {@link discardOnSchemaVersionMismatch}
 *
 *   - **Costly / authored state** (an operator confirmation, a checkpoint, a
 *     human- or LLM-authored artifact — anything that cannot be recreated
 *     without redoing work or asking a person again): a mismatch means THROW.
 *     Silently discarding it would destroy work and read as "not done yet".
 *     → {@link throwOnSchemaVersionMismatch}
 *
 * Both treat an ABSENT payload (`undefined`/`null`) as absent, not as a
 * mismatch — "not written yet" is a normal state on a fresh run and is the
 * caller's own fail-shape (`?? {}`, `?? null`, `if (!x)`) to express.
 */

/**
 * Thrown when costly/authored state is loaded with a `schema_version` that does
 * not match the expected version constant. The message names the artifact and
 * both versions so the operator has an actionable diagnosis.
 */
export class SchemaVersionMismatchError extends Error {
  constructor(
    public readonly artifactName: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Artifact "${artifactName}" has schema_version "${actual}" but expected "${expected}". ` +
        `This likely means the artifact was produced by an incompatible version of this tool. ` +
        `Delete ${artifactName} from the artifacts directory to regenerate it.`,
    );
    this.name = "SchemaVersionMismatchError";
  }
}

// Both directions accept ANY object — an unstamped payload is a defined input
// (discard: stale; throw: mismatch), and the parameter types state that real
// contract rather than requiring a `schema_version`-bearing shape.
//
// TWO spellings are recognized, because the repo stamps both: `schema_version`
// on artifacts and `contract_version` on contracts (the version-gate scan's own
// version-key family). That is a naming convention of the payload FAMILY, not a
// difference in policy — and a helper that knew only one spelling would return
// `undefined` for every payload of the other, i.e. discard a current file as if
// it were never written, or throw on a correctly-stamped one. A silent
// always-discard is indistinguishable from a working guard in review, so the
// helper resolves the key rather than making each call site remember it.
// `schema_version` wins when a payload carries both.
function stampedVersion(value: object): unknown {
  const record = value as Record<string, unknown>;
  return "schema_version" in record ? record.schema_version : record.contract_version;
}

/**
 * REGENERABLE state: return the payload only when its stamped `schema_version`
 * equals `expected`; otherwise `undefined` — i.e. treat a stale (or unstamped,
 * or non-string-stamped) payload exactly as if the file were not there, so the
 * caller's existing absent-path rebuilds it.
 *
 * Use for caches, carries, snapshots and derived indexes. For state that cannot
 * be rebuilt, use {@link throwOnSchemaVersionMismatch} instead.
 */
export function discardOnSchemaVersionMismatch<T extends object>(
  value: T | undefined | null,
  expected: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return stampedVersion(value) === expected ? value : undefined;
}

/**
 * COSTLY / AUTHORED state: throw {@link SchemaVersionMismatchError} when the
 * stamped `schema_version` is missing, non-string, or not equal to `expected`.
 * Returns silently for an absent payload (`undefined`/`null`) — a not-yet-
 * produced artifact is not a mismatch.
 *
 * Use for operator confirmations, checkpoints and authored artifacts, whose
 * silent loss would destroy work. For rebuildable state, use
 * {@link discardOnSchemaVersionMismatch} instead.
 */
export function throwOnSchemaVersionMismatch(
  value: object | undefined | null,
  artifactName: string,
  expected: string,
): void {
  if (value === undefined || value === null) return;
  const actual = stampedVersion(value);
  if (typeof actual !== "string") {
    throw new SchemaVersionMismatchError(artifactName, expected, String(actual));
  }
  if (actual !== expected) {
    throw new SchemaVersionMismatchError(artifactName, expected, actual);
  }
}
