/**
 * Single authority for "is this UNIT excluded by the host's STRUCTURED intent
 * scope" — the per-unit disposition derived from the shared per-file exclusion
 * predicate (`fileExclusionReason` in `audit-tools/shared`, which both orchestrators
 * consume so their scope coverage can't drift). A pure leaf module (no artifact /
 * extractor imports) so every consumer can depend on it without an import cycle:
 *
 *   - the design-review prompt's per-unit `[in scope]` / `[excluded: reason]`
 *     annotation (`designReviewPrompt.ts`), and
 *   - the design-review staleness projection (`designReviewProjection.ts`),
 *     which captures the disposition KIND so a scope change re-stales the review.
 *
 * Reads ONLY the structured IntentCheckpoint scope fields via the shared authority
 * (`excluded_scope` / `disposition_overrides` / `must_not_touch`) — never
 * `free_form_intent` (interpreted into priority/lens signals, never threaded
 * verbatim, INV-S04). Co-locating the unit derivation here means the consumers can
 * never disagree on what "excluded" means.
 */
import { fileExclusionReason, type IntentCheckpoint } from "audit-tools/shared";

/**
 * The structured scope disposition of one design-review unit: `in_scope`, or
 * `excluded` with the human reason. A unit counts as excluded only when EVERY one
 * of its files is excluded; a unit with any in-scope file stays in scope so the
 * reviewer is never told to skip a unit that still carries reviewable code.
 */
export type UnitScopeDisposition =
  | { kind: "in_scope" }
  | { kind: "excluded"; reason: string };

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
