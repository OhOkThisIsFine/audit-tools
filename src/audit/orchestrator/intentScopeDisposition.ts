/**
 * Single authority for "is this file / unit excluded by the host's STRUCTURED
 * intent scope" — the path-exclusion predicate plus the per-unit disposition
 * derived from it. A pure leaf module (no artifact / extractor imports) so every
 * consumer can depend on it without an import cycle:
 *
 *   - coverage application (`scope.ts`: `applyIntentExclusionsToCoverage`),
 *   - the design-review prompt's per-unit `[in scope]` / `[excluded: reason]`
 *     annotation (`designReviewPrompt.ts`), and
 *   - the design-review staleness projection (`designReviewProjection.ts`),
 *     which captures the disposition KIND so a scope change re-stales the review.
 *
 * Reads ONLY the structured IntentCheckpoint scope fields (`excluded_scope` /
 * `disposition_overrides`) — never `free_form_intent` (interpreted into
 * priority/lens signals, never threaded verbatim, INV-S04). Co-locating the
 * predicate and the unit derivation here means the three consumers can never
 * disagree on what "excluded" means.
 */
import type { IntentCheckpoint } from "audit-tools/shared";

/**
 * True when `filePath` is covered by an `excluded_scope` entry path — an exact
 * match or a directory-prefix match (path separators normalized to `/` so the
 * predicate is OS-agnostic).
 */
export function pathMatchesExclusion(filePath: string, entryPath: string): boolean {
  const f = filePath.replace(/\\/g, "/");
  const p = entryPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p) return false;
  return f === p || f.startsWith(`${p}/`);
}

/**
 * The structured scope disposition of one design-review unit: `in_scope`, or
 * `excluded` with the human reason. Derived from the STRUCTURED IntentCheckpoint
 * scope fields ONLY — `excluded_scope` (path/prefix + reason) and an `excluded`
 * `disposition_overrides` entry — never from `free_form_intent` (which is
 * interpreted into priority/lens signals, never threaded verbatim, INV-S04). A
 * unit counts as excluded only when EVERY one of its files is excluded; a unit
 * with any in-scope file stays in scope so the reviewer is never told to skip a
 * unit that still carries reviewable code.
 */
export type UnitScopeDisposition =
  | { kind: "in_scope" }
  | { kind: "excluded"; reason: string };

/** Statuses a `disposition_overrides` entry can carry that mean "out of scope". */
const EXCLUDED_OVERRIDE_STATUSES: ReadonlySet<string> = new Set([
  "excluded",
  "generated",
  "vendor",
]);

/**
 * Resolve a single file's structured exclusion (path match wins over override),
 * returning the reason when excluded or null when in scope. Reads only the
 * structured `excluded_scope` / `disposition_overrides` fields.
 */
function fileExclusionReason(
  filePath: string,
  checkpoint: IntentCheckpoint | undefined,
): string | null {
  const excludedScope = checkpoint?.excluded_scope ?? [];
  for (const entry of excludedScope) {
    if (pathMatchesExclusion(filePath, entry.path)) return entry.reason;
  }
  const overrides = checkpoint?.disposition_overrides ?? [];
  for (const ov of overrides) {
    if (EXCLUDED_OVERRIDE_STATUSES.has(ov.status) && pathMatchesExclusion(filePath, ov.path)) {
      return ov.reason;
    }
  }
  return null;
}

/**
 * Disposition of a whole unit: excluded only when every file is excluded by the
 * structured scope, carrying the first file's reason (units are excluded as a
 * directory in practice, so one reason is representative). No checkpoint, or any
 * in-scope file ⇒ `in_scope`.
 */
export function deriveUnitScopeDisposition(
  files: readonly string[],
  checkpoint: IntentCheckpoint | undefined,
): UnitScopeDisposition {
  if (!checkpoint || files.length === 0) return { kind: "in_scope" };
  let firstReason: string | null = null;
  for (const file of files) {
    const reason = fileExclusionReason(file, checkpoint);
    if (reason === null) return { kind: "in_scope" };
    if (firstReason === null) firstReason = reason;
  }
  return { kind: "excluded", reason: firstReason ?? "out of scope" };
}
