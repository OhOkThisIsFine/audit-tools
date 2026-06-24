/**
 * The shared content-key seam (O2 ↔ F1).
 *
 * Three pure, deterministic functions — no IO, clock, or randomness. They derive
 * the canonical keys both O2's append-only results ledger (re-association) and
 * F1's element-staleness gate import, so the two cannot drift.
 *
 * Keys (see plan-of-record CE-001 / FC-001 / FC-002):
 *
 *  - `buildTaskContentSignature` (TOOL-OWNED, FC-002): the signature recipe lives
 *    HERE, never in callers. It is derived ONLY from task-defining content and
 *    MUST exclude `task_id` and any timestamp/provenance field — a caller-built
 *    signature is a false-fresh latent bug.
 *
 *  - `identityKey` (INV-CK-3): sha256 over the canonical {unit_id, lens, pass_id}
 *    tuple. EXCLUDES task_id. It is a ONE-TO-MANY GROUPING key (INV-CK-3b) used to
 *    re-associate ledger records — NEVER a primary key. `{unit_id, lens, pass_id}`
 *    is not unique within a pass (base vs. deepening/steward, or an O3 re-dispatch),
 *    so multiple distinct results legitimately share one identityKey.
 *
 *  - `contentKey`: sha256 over {identity_key, task_content_signature,
 *    result_content_discriminator}. It BUMPS when task content OR the discriminator
 *    changes, so two genuinely-different results that share {unit_id, lens, pass_id}
 *    get DIFFERENT content_keys (CE-001). This is the idempotency key the ledger
 *    appends on.
 *
 * Relating invariant (C-006): contentKey is a pure function of (identity_key,
 * task_content_signature, result_content_discriminator). Since identity_key is one
 * of those inputs, equal contentKey ⟹ equal identityKey. One canonical input
 * yields both keys with this documented relation — re-association stability and
 * staleness-on-change are reconciled, not in tension.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "./stableStringify.js";

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

export interface ContentKeyInput extends IdentityKeyInput {
  task_content_signature: string;
  result_content_discriminator: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Provenance / non-content fields stripped before signing. Renumbering a task,
// or restamping it, must not change the task-content signature (FC-002).
const NON_CONTENT_SIGNATURE_FIELDS: ReadonlySet<string> = new Set([
  "task_id",
  "generated_at",
  "created_at",
  "updated_at",
  "timestamp",
  "provenance",
]);

/**
 * TOOL-OWNED task-content signature (FC-002). Derives a stable signature from the
 * task-defining content ONLY — `task_id` and timestamp/provenance fields are
 * stripped, and the remaining fields are serialized with the single canonical
 * `stableStringify`, so reordered keys produce an identical signature.
 */
export function buildTaskContentSignature(
  input: TaskContentSignatureInput,
): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "buildTaskContentSignature: input must be a plain object of task-defining content",
    );
  }
  const content = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !NON_CONTENT_SIGNATURE_FIELDS.has(key),
    ),
  );
  return sha256(stableStringify(content));
}

function requireField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    // No silent colliding key (content-key-seam-fail-3): a missing component
    // would otherwise hash to the same key for distinct coordinates.
    throw new Error(
      `contentKey: ${name} is required and must be a non-empty string`,
    );
  }
  return value;
}

/**
 * sha256 over the canonical {unit_id, lens, pass_id} tuple (INV-CK-3). EXCLUDES
 * task_id. ONE-TO-MANY grouping key (INV-CK-3b) — never a primary key. Throws if
 * any component is missing (content-key-seam-fail-3).
 */
export function identityKey(input: IdentityKeyInput): string {
  const unit_id = requireField(input?.unit_id, "unit_id");
  const lens = requireField(input?.lens, "lens");
  const pass_id = requireField(input?.pass_id, "pass_id");
  return sha256(stableStringify({ unit_id, lens, pass_id }));
}

/**
 * sha256 over {identity_key, task_content_signature, result_content_discriminator}.
 * Bumps when task content OR the discriminator changes (CE-001). equal contentKey
 * ⟹ equal identityKey, since identity_key is one of the signed inputs.
 */
export function contentKey(input: ContentKeyInput): string {
  const identity_key = identityKey(input);
  const task_content_signature = requireField(
    input?.task_content_signature,
    "task_content_signature",
  );
  const result_content_discriminator = requireField(
    input?.result_content_discriminator,
    "result_content_discriminator",
  );
  return sha256(
    stableStringify({
      identity_key,
      task_content_signature,
      result_content_discriminator,
    }),
  );
}
