// sites-pinned: tests/audit/read-file-text.test.ts, tests/audit/bounded-reader-integration.test.ts
import { open } from "node:fs/promises";

/**
 * Default byte cap for a bounded extractor read: a file larger than this is
 * skipped rather than pulled into memory.
 */
export const DEFAULT_MAX_BYTES = 512 * 1024;

type BoundedFileText =
  | { kind: "text"; text: string }
  | { kind: "oversized"; bytes?: number }
  | { kind: "unreadable" };

/**
 * The ONE bounded, non-throwing file read every extractor defaults to. A file
 * that is unreadable, or larger than `maxBytes`, yields `undefined` — extraction
 * degrades to "no content" rather than aborting the whole pass.
 */
export async function defaultReadFileText(
  absPath: string,
  maxBytes: number,
): Promise<string | undefined> {
  const result = await readBoundedFileText(absPath, maxBytes);
  return result.kind === "text" ? result.text : undefined;
}

/** Read complete text or report why none is available. */
export async function readBoundedFileText(
  absPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<BoundedFileText> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return { kind: "unreadable" };
  const cap = Math.floor(maxBytes);
  try {
    const handle = await open(absPath, "r");
    try {
      // Admission and content belong to the same handle. Symlinks to regular
      // files remain supported; ordinary open is not a FIFO/time-bound guard.
      const stat = await handle.stat();
      if (!stat.isFile()) return { kind: "unreadable" };
      if (stat.size > cap) return { kind: "oversized", bytes: stat.size };

      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, cap + 1));
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const length = Math.min(buffer.length, cap - total + 1);
        const { bytesRead } = await handle.read(buffer, 0, length, null);
        if (bytesRead === 0) {
          // Decode once: chunk boundaries may split a UTF-8 sequence.
          return { kind: "text", text: Buffer.concat(chunks, total).toString("utf8") };
        }
        total += bytesRead;
        // The extra byte proves overflow, not the file's exact current size.
        if (total > cap) return { kind: "oversized" };
        // Copy initialized bytes only; short reads must not retain/alias the
        // reusable buffer or consume the unfilled part of their allowance.
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
    } finally {
      // The outer catch also covers close failures, including after success.
      await handle.close();
    }
  } catch {
    return { kind: "unreadable" };
  }
}
