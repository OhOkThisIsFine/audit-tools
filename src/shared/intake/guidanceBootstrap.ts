// sites-pinned: tests/remediate/intake-starting-point-contract.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Single-step bootstrap writer for `intake/conversation-start.md`, shared by both
 * orchestrators (audit-code + remediate-code) so the idempotency + collision
 * contract can never drift between them.
 *
 * This module OWNS guidance-file creation and selection: it is the sole writer of
 * the conversation-start target and the sole authority on which path that target
 * is. No user-facing prompt names a guidance file of its own — the emitted
 * starting-point prompt points the host at `--guidance-file` with the exact target
 * this module defines, and the loader states only that the flag exists (P2.1).
 *
 * Sole writer + idempotent-on-target (INV-CC-03): re-applying the identical
 * guidance is a byte-identical no-op (the existing file is left untouched, never
 * appended to), and a pre-existing file with DIFFERING content is never silently
 * clobbered — that case fails loudly so host/conversation-authored guidance can't
 * be lost. The guidance file's bytes are written verbatim.
 */
/**
 * The ONE canonical guidance-file target path: `intake/conversation-start.md`
 * under the artifacts dir. Exported so the starting-point prompt and any other
 * site that must point the host at the target names this function's result
 * rather than re-deriving the join literal (a second join is how the target
 * drifts between the writer and the prompt that tells the host where it is).
 */
export function guidanceFilePathUnder(artifactsDir: string): string {
  return join(artifactsDir, "intake", "conversation-start.md");
}

export function applyGuidanceFile(
  artifactsDir: string,
  guidanceFilePath: string,
): string {
  const target = guidanceFilePathUnder(artifactsDir);
  const resolvedSource = resolve(guidanceFilePath);
  if (resolve(target) === resolvedSource) {
    // The guidance file already IS the target — nothing to copy, and reading
    // then rewriting it would be a pointless self-write.
    return target;
  }
  const incoming = readFileSync(resolvedSource);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.equals(incoming)) {
      // Identical re-apply: byte-identical no-op, no rewrite, no append.
      return target;
    }
    throw new Error(
      `Refusing to overwrite existing ${target} with differing guidance from ${resolvedSource}. ` +
        `Remove or reconcile the existing conversation-start.md before re-bootstrapping.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, incoming);
  return target;
}
