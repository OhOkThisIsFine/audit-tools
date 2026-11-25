// sites-pinned: tests/audit/fs-intake.test.ts
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

/** Hash streamed bytes without buffering the complete input in memory. */
export async function hashContentStream(content: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of content) hash.update(chunk);
  return hash.digest("hex");
}

/** Raw evidence hash plus a distinct CRLF-normalized identity where needed.
 * A zero byte is treated as binary; no text decoding or semantic whitespace
 * cleanup occurs. Streaming callers consume one source read, even across CRLF
 * split between two chunks.
 */
export async function hashTextIdentity(content: Buffer | AsyncIterable<Uint8Array>): Promise<{ hash: string; normalized_hash?: string }> {
  if (Buffer.isBuffer(content)) {
    const hash = hashContent(content);
    if (content.includes(0) || !content.includes("\r\n")) return { hash };
    return { hash, normalized_hash: hashContent(Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1")) };
  }
  const raw = createHash("sha256");
  const normalized = createHash("sha256");
  let carry = "";
  let converted = false;
  let nul = false;
  for await (const chunk of content) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    raw.update(bytes);
    if (nul || bytes.includes(0)) { nul = true; continue; }
    let text = carry + bytes.toString("latin1");
    carry = text.endsWith("\r") ? "\r" : "";
    if (carry) text = text.slice(0, -1);
    if (text.includes("\r\n")) { converted = true; text = text.replaceAll("\r\n", "\n"); }
    normalized.update(text, "latin1");
  }
  const hash = raw.digest("hex");
  if (nul || !converted) return { hash };
  return { hash, normalized_hash: normalized.update(carry, "latin1").digest("hex") };
}

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
