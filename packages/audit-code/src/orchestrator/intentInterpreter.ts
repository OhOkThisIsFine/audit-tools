/**
 * audit-code free_form_intent interpreter consumer.
 *
 * Bridges the @audit-tools/shared clause interpreter to the pinned
 * FreeFormIntentInterpretation seam contract (N-X06).
 *
 * INV-S04: the verbatim free_form_intent string MUST NOT appear in any output
 * field. All fields are derived signals only.
 */

import {
  interpretIntent,
  FREE_FORM_INTENT_INTERPRETATION_VERSION,
} from "@audit-tools/shared";
import type {
  FreeFormIntentInterpretation,
  EncodedClause,
} from "@audit-tools/shared";
import type { Lens } from "@audit-tools/shared";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LENS_DETAIL_RE = /Matches lens\(es\): ([^,]+(?:, [^,]+)*)/;

/** Extract the first lens name from a "Matches lens(es): ..." detail string. */
function extractLens(detail: string): Lens | undefined {
  const m = LENS_DETAIL_RE.exec(detail);
  if (!m || !m[1]) return undefined;
  // Only take the first lens if multiple are listed; callers iterate encoded_clauses.
  const first = m[1].split(",")[0]?.trim();
  return first as Lens | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interpret a free-form intent string into the versioned seam contract shape.
 *
 * Delegates to interpretIntent (clause-aware) from @audit-tools/shared and
 * maps the output onto FreeFormIntentInterpretation.
 *
 * @param freeFormIntent - Raw free_form_intent from IntentCheckpoint (may be empty).
 */
export function interpretFreeFormIntentForAudit(
  freeFormIntent: string,
): FreeFormIntentInterpretation {
  const result = interpretIntent(freeFormIntent);

  const encoded_clauses: EncodedClause[] = [];

  for (const clause of result.clauses) {
    if (!clause.encodable || !clause.encoded_as) continue;
    const entry: EncodedClause = {
      text: clause.text,
      kind: clause.encoded_as.kind,
      detail: clause.encoded_as.detail,
    };
    if (entry.kind === "lens_weight") {
      const lens = extractLens(entry.detail);
      if (lens) entry.lens = lens;
    }
    encoded_clauses.push(entry);
  }

  return {
    schema_version: FREE_FORM_INTENT_INTERPRETATION_VERSION,
    encoded_clauses,
    checkpoint_questions: result.checkpoint_questions,
    has_unencodable: result.has_unencodable,
  };
}
