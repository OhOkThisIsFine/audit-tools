/**
 * Shared content-hash primitive.
 *
 * `hashContent` is the single source for SHA-256 content hashing across both
 * orchestrators — file-integrity snapshots, intake source idempotency keys,
 * contract-pipeline staleness envelopes, and finding-identity digests all route
 * through it. Centralizing it kills the prior drift where each call site picked
 * its own ad-hoc `.slice(0, N)` length (full / 32 / 16 / 8) on an inline
 * `createHash("sha256")` chain.
 *
 * Callers that want a truncated digest pass `length` EXPLICITLY (e.g. the
 * finding-identity digest uses `{ length: 8 }`). No call site should carry a
 * bare `.slice(0, N)` literal on a hash result anymore.
 */
import { createHash } from "node:crypto";

export interface HashContentOptions {
  /**
   * Truncate the hex digest to this many leading characters. Omit for the full
   * 64-char SHA-256 hex string. Must be a positive integer when provided.
   */
  length?: number;
}

/**
 * Compute a SHA-256 hex digest of `content` (a string or raw bytes). Returns the
 * full 64-char hex digest by default, or the leading `length` characters when
 * `length` is given.
 *
 * Strings are hashed as UTF-8 (matching the prior call-site convention).
 */
export function hashContent(
  content: string | Uint8Array,
  options: HashContentOptions = {},
): string {
  const digest =
    typeof content === "string"
      ? createHash("sha256").update(content, "utf8").digest("hex")
      : createHash("sha256").update(content).digest("hex");

  const { length } = options;
  if (length === undefined) {
    return digest;
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(
      `hashContent: length must be a positive integer, got ${String(length)}`,
    );
  }
  return digest.slice(0, length);
}
