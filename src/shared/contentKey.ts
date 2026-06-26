/**
 * The shared content-key seam (O2 ↔ F1) — the SOLE definition of the workflow's
 * derived keys (INV-CK-1). O2's append-only results ledger (re-association +
 * append-time idempotency) and F1's element-staleness gate both import their keys
 * from HERE, so the two cannot drift.
 *
 * THREE derived keys, one canonical-input derivation chain (OBL-content-key-seam-contract):
 *
 *  - `identityKey` (INV-CK-3 / INV-CK-4): sha256 over the canonical
 *    {unit_id, lens, pass_id} tuple. EXCLUDES task_id and every volatile/provenance
 *    field (INV-CK-3). It is a ONE-TO-MANY GROUPING key (INV-CK-4 / CE-001) used to
 *    re-associate ledger records — NEVER a primary key. `{unit_id, lens, pass_id}` is
 *    not unique within a pass (base vs. deepening/steward, or an O3 re-dispatch), so
 *    multiple distinct results legitimately share one identityKey.
 *
 *  - `idempotencyKey` (INV-CK-7, signature-STABLE): sha256 over
 *    {identity_key, result_content_discriminator}. It is the anchor O2 ingests on:
 *    a replay of the *same* logical result is a no-op (CE-001b / fail-4), because a
 *    benign edit to the task content (which only moves the task_content_signature)
 *    does NOT move the idempotencyKey. Two genuinely-different same-coordinate
 *    results carry distinct discriminators → distinct idempotencyKeys → both persist
 *    (CE-001). This is signature-STABLE by construction: task_content_signature is
 *    not one of its inputs.
 *
 *  - `contentKey` (INV-CK-5, signature-SENSITIVE): sha256 over
 *    {idempotency_key, task_content_signature}. It BUMPS when the idempotencyKey OR
 *    the task_content_signature changes, so it is the correct driver for staleness:
 *    a benign content edit (idempotencyKey fixed, signature C1→C2) bumps ONLY the
 *    contentKey (fail-4), letting idempotent re-ingest stay a no-op while staleness
 *    still fires.
 *
 *  - `newInstanceId`: a per-record unique id (INV-CK / CE-001). The ledger is keyed
 *    by this — every appended record is distinct — so identityKey/idempotencyKey are
 *    grouping/idempotency keys, never primary keys (fail-2). This is the ONLY
 *    non-pure helper here (it mints randomness); the three key derivations above are
 *    pure and deterministic (INV-CK-2).
 *
 * Tool-owned inputs (never caller discretion):
 *  - `buildTaskContentSignature` (FC-002 / fail-1): the signature recipe lives HERE.
 *    Derived ONLY from task-defining content; `task_id` and timestamp/provenance
 *    fields are STRIPPED — a caller-built signature is a false-fresh latent bug.
 *  - `buildResultContentDiscriminator` (C-002 / fail-3): the discriminator recipe
 *    lives HERE too, keyed off the emit-source enum (base | deepening | steward |
 *    redispatch). Because the discriminator feeds the signature-STABLE
 *    idempotencyKey, a caller-chosen discriminator is a correctness hazard (a wrongly
 *    identical one collapses two distinct results; a wrongly distinct one on a replay
 *    mints a duplicate). The recipe is owned, never operator-chosen.
 *
 * Relating invariant (INV-CK-6, OBL-content-key-seam-inv-7/inv-8):
 *   equal contentKey ⟹ equal idempotencyKey ⟹ equal identityKey
 * (NOT the converses), and `idempotencyKey` is invariant under a change to
 * `task_content_signature` alone. The chain holds because each key nests the prior
 * one as a signed input: contentKey signs idempotency_key, which signs identity_key.
 * One canonical input thus yields all three keys with this documented relation —
 * re-association stability (idempotencyKey) and staleness-on-change (contentKey) are
 * reconciled, not in tension.
 */
import { createHash, randomUUID } from "node:crypto";

import { stableStringify } from "./stableStringify.js";
import { normalizeForMetadataHash } from "../audit/orchestrator/artifactFreshness.js";

/** Coordinate that groups results: {unit_id, lens, pass_id}. */
export interface IdentityKeyInput {
  unit_id: string;
  lens: string;
  pass_id: string;
}

/**
 * Inputs to `buildTaskContentSignature`. Any task-defining content may be passed;
 * `task_id` and provenance/timestamp fields are accepted but explicitly STRIPPED
 * (FC-002) so renumbering a task id never changes the signature.
 */
export interface TaskContentSignatureInput {
  [key: string]: unknown;
  task_id?: unknown;
}

/**
 * The closed set of emit paths a result can originate from. The discriminator
 * recipe is keyed off this enum (C-002) — callers pick the source, never the
 * discriminator string.
 */
export type ResultEmitSource = 'base' | 'deepening' | 'steward' | 'redispatch';

/** Inputs to `buildResultContentDiscriminator`. */
export interface ResultContentDiscriminatorInput {
  source: ResultEmitSource;
  /**
   * Required for (and ONLY meaningful for) `source: 'redispatch'`: the 1-based
   * attempt counter that distinguishes an O3 re-dispatch from the result it
   * replaces (R2 advisory). A re-dispatch carries a distinct discriminator so its
   * idempotencyKey differs from the prior attempt.
   */
  attempt?: number;
  /**
   * Per-split discriminator (N-IDEMPOTENCY). File-split sibling tasks of one
   * unit+lens+pass legitimately share the {unit_id, lens, pass_id} grouping
   * coordinate but carry DISTINCT task_ids (`…:part-N`, or `…:<filePath>` for a
   * large-file split). Without a per-split component every sibling base result
   * would derive the SAME idempotencyKey, so `appendResultsToLedger`'s INV-2 gate
   * would silently no-op all but the first sibling — dropping the others'
   * findings. This component (the split's task_id, canonicalized OS-agnostically
   * via `canonicalSplitDiscriminator`) folds into the discriminator so siblings
   * get distinct idempotencyKeys and all persist.
   *
   * Contract (fold-rule): an EMPTY component (the lone, non-split base task)
   * yields a discriminator BYTE-IDENTICAL to the legacy lone-base value, so
   * existing ledger / baseline keys are unchanged. A non-empty component appends
   * it, so siblings diverge. Tool-owned, never caller-chosen — callers pass the
   * raw task_id and the canonicalization + emptiness rule live HERE.
   */
  split_discriminator?: string;
}

/** Inputs to `idempotencyKey`: the identity coordinate + the result discriminator. */
export interface IdempotencyKeyInput extends IdentityKeyInput {
  result_content_discriminator: string;
}

/** Inputs to `contentKey`: everything `idempotencyKey` needs + the task signature. */
export interface ContentKeyInput extends IdempotencyKeyInput {
  task_content_signature: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Provenance / non-content fields stripped before signing. Renumbering a task,
// or restamping it, must not change the task-content signature (FC-002). The
// artifact name routes through the shared normalizeForMetadataHash so the same
// non-semantic-stripping discipline is reused (INV-CK-2), never re-implemented.
const TASK_SIGNATURE_ARTIFACT = 'task_content_signature';
const NON_CONTENT_SIGNATURE_FIELDS: ReadonlySet<string> = new Set([
  'task_id',
  'generated_at',
  'created_at',
  'updated_at',
  'timestamp',
  'provenance',
]);

/**
 * TOOL-OWNED task-content signature (FC-002 / fail-1). Derives a stable signature
 * from the task-defining content ONLY — `task_id` and timestamp/provenance fields
 * are stripped, then the remaining fields are run through the shared
 * `normalizeForMetadataHash` + canonical `stableStringify` (the single serializer,
 * INV-CK-2), so reordered keys produce an identical signature.
 */
export function buildTaskContentSignature(
  input: TaskContentSignatureInput,
): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      'buildTaskContentSignature: input must be a plain object of task-defining content',
    );
  }
  const content = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !NON_CONTENT_SIGNATURE_FIELDS.has(key),
    ),
  );
  return sha256(
    stableStringify(normalizeForMetadataHash(TASK_SIGNATURE_ARTIFACT, content)),
  );
}

/**
 * Canonicalize a split-discriminator component OS-agnostically (N-IDEMPOTENCY).
 * A large-file split task_id embeds the file path (`…:<filePath>`), so the raw
 * value carries the host's path separator — `unit/a.ts` on POSIX vs `unit\a.ts`
 * on win32 for the SAME logical split. Backslashes are normalized to forward
 * slashes so the idempotencyKey is byte-identical cross-platform (a win32 run and
 * a POSIX run of the same split must NOT mint two records). An empty/whitespace
 * component canonicalizes to the empty string (the lone-base sentinel). This is
 * the SOLE canonicalization point — callers pass the raw component.
 */
export function canonicalSplitDiscriminator(component: string | undefined): string {
  if (typeof component !== 'string') return '';
  const trimmed = component.trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/\\/g, '/');
}

/**
 * TOOL-OWNED result-content discriminator (C-002 / fail-3). The discriminator
 * string is derived from the emit-source enum (plus the attempt counter for a
 * re-dispatch), never chosen by a caller — because it feeds the signature-STABLE
 * idempotencyKey, an operator-chosen value would be a correctness hazard.
 *
 * The per-split component (N-IDEMPOTENCY) folds in identically for every emit
 * source: an EMPTY canonical component reproduces the legacy lone-base /
 * lone-source string BYTE-FOR-BYTE (no key churn for non-split tasks), while a
 * non-empty component appends a `#split:<canonical>` suffix so file-split sibling
 * tasks sharing a {unit_id, lens, pass_id} coordinate diverge into distinct
 * idempotencyKeys instead of colliding through the INV-2 gate.
 */
export function buildResultContentDiscriminator(
  input: ResultContentDiscriminatorInput,
): string {
  const base = baseDiscriminator(input);
  const split = canonicalSplitDiscriminator(input?.split_discriminator);
  return split.length === 0 ? base : `${base}#split:${split}`;
}

function baseDiscriminator(input: ResultContentDiscriminatorInput): string {
  const source = input?.source;
  if (source === 'base' || source === 'deepening' || source === 'steward') {
    return source;
  }
  if (source === 'redispatch') {
    const attempt = input.attempt;
    if (!Number.isInteger(attempt) || (attempt as number) < 1) {
      // Without a distinct attempt counter two re-dispatches would collide
      // (fail-3) — refuse rather than mint a colliding discriminator.
      throw new Error(
        "buildResultContentDiscriminator: source 'redispatch' requires an integer attempt >= 1",
      );
    }
    return `redispatch-attempt-${attempt}`;
  }
  throw new Error(
    `buildResultContentDiscriminator: unknown emit source ${JSON.stringify(source)}`,
  );
}

/**
 * Derive the per-split discriminator component from a task_id (N-IDEMPOTENCY).
 * Split sibling task_ids are `${scope}:${lens}:part-N` or `${scope}:${lens}:<filePath>`;
 * a lone (non-split) task is exactly `${scope}:${lens}`. The component is the
 * suffix AFTER the trailing `:${lens}` segment — empty for a lone task (⇒
 * byte-identical lone-base key), the split-distinguishing tail otherwise. Returns
 * empty when the task_id/lens are missing or the expected shape is absent (fail
 * safe to the legacy lone key rather than mint a spurious split). The result is
 * the RAW tail; `buildResultContentDiscriminator` canonicalizes it.
 */
export function splitDiscriminatorFromTaskId(
  task_id: string | undefined,
  lens: string | undefined,
): string {
  if (typeof task_id !== 'string' || typeof lens !== 'string' || lens.length === 0) {
    return '';
  }
  const marker = `:${lens}`;
  const at = task_id.lastIndexOf(marker);
  if (at < 0) return '';
  const tail = task_id.slice(at + marker.length);
  // Lone task ends exactly at the lens segment ⇒ no split suffix.
  if (!tail.startsWith(':')) return '';
  return tail.slice(1);
}

function requireField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    // No silent colliding key (fail-3): a missing component would otherwise hash
    // to the same key for distinct coordinates.
    throw new Error(
      `contentKey: ${name} is required and must be a non-empty string`,
    );
  }
  return value;
}

/**
 * sha256 over the canonical {unit_id, lens, pass_id} tuple (INV-CK-3). EXCLUDES
 * task_id and all volatile fields. ONE-TO-MANY grouping key (INV-CK-4) — never a
 * primary key. Throws if any component is missing (fail-3).
 */
export function identityKey(input: IdentityKeyInput): string {
  const unit_id = requireField(input?.unit_id, 'unit_id');
  const lens = requireField(input?.lens, 'lens');
  const pass_id = requireField(input?.pass_id, 'pass_id');
  return sha256(stableStringify({ unit_id, lens, pass_id }));
}

/**
 * sha256 over {identity_key, result_content_discriminator} (INV-CK-7). SIGNATURE-
 * STABLE: the task_content_signature is deliberately NOT an input, so a benign
 * content edit does not move it (fail-4). This is the key O2 ingests on. equal
 * idempotencyKey ⟹ equal identityKey, since identity_key is a signed input.
 */
export function idempotencyKey(input: IdempotencyKeyInput): string {
  const identity_key = identityKey(input);
  const result_content_discriminator = requireField(
    input?.result_content_discriminator,
    'result_content_discriminator',
  );
  return sha256(
    stableStringify({ identity_key, result_content_discriminator }),
  );
}

/**
 * sha256 over {idempotency_key, task_content_signature} (INV-CK-5). SIGNATURE-
 * SENSITIVE: bumps when the idempotencyKey OR the task_content_signature changes,
 * so it drives staleness (CE-001 / inv-5). equal contentKey ⟹ equal idempotencyKey
 * ⟹ equal identityKey, since each is a signed input of the next.
 */
export function contentKey(input: ContentKeyInput): string {
  const idempotency_key = idempotencyKey(input);
  const task_content_signature = requireField(
    input?.task_content_signature,
    'task_content_signature',
  );
  return sha256(
    stableStringify({ idempotency_key, task_content_signature }),
  );
}

/**
 * Mint a fresh per-record instance id (CE-001 / fail-2). The ledger keys on this,
 * so every appended record is distinct and identityKey/idempotencyKey are never
 * primary keys. This is the ONLY non-deterministic helper in the seam — the three
 * key derivations above are pure.
 */
export function newInstanceId(): string {
  return randomUUID();
}
