import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Single-step bootstrap writer for `intake/conversation-start.md`, shared by both
 * orchestrators (audit-code + remediate-code) so the idempotency + collision
 * contract can never drift between them.
 *
 * Sole writer + idempotent-on-target (INV-CC-03): re-applying the identical
 * guidance is a byte-identical no-op (the existing file is left untouched, never
 * appended to), and a pre-existing file with DIFFERING content is never silently
 * clobbered — that case fails loudly so host/conversation-authored guidance can't
 * be lost. The guidance file's bytes are written verbatim.
 */
export function applyGuidanceFile(
  artifactsDir: string,
  guidanceFilePath: string,
): string {
  const target = join(artifactsDir, "intake", "conversation-start.md");
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
