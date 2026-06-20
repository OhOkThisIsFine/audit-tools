/**
 * audit-code free_form_intent interpreter consumer.
 *
 * Bridges the audit-tools/shared clause interpreter to the pinned
 * FreeFormIntentInterpretation seam contract (N-X06).
 *
 * INV-S04: the verbatim free_form_intent string MUST NOT appear in any output
 * field. All fields are derived signals only.
 */

import {
  interpretIntent,
  FREE_FORM_INTENT_INTERPRETATION_VERSION,
} from "audit-tools/shared";
import type {
  FreeFormIntentInterpretation,
  EncodedClause,
  IntentCheckpoint,
} from "audit-tools/shared";
import type { Lens } from "audit-tools/shared";

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
 * Delegates to interpretIntent (clause-aware) from audit-tools/shared and
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

// ---------------------------------------------------------------------------
// Blocking-escalation gate
// ---------------------------------------------------------------------------

/** A blocking checkpoint question that the host has not yet answered. */
export interface UnresolvedConstraintClause {
  /**
   * Stable clause identity — the resolution key (CE-004). A `constraint_clauses`
   * entry resolves this clause when its `clause_id` matches, NOT when its
   * rendered `checkpoint_question` matches (two distinct clauses can render to
   * the same question). The host/headless recorder threads this back so the
   * answer is keyed on identity.
   */
  clause_id: string;
  /** The original unencodable clause text. */
  text: string;
  /** The blocking question that must be answered before planning proceeds. */
  checkpoint_question: string;
}

/**
 * Compute the blocking checkpoint questions raised by an intent checkpoint's
 * `free_form_intent` that the host has NOT yet resolved.
 *
 * An unencodable clause is "resolved" only when the checkpoint carries a
 * `constraint_clauses` entry for it — matched on CLAUSE IDENTITY (`clause_id`),
 * not the rendered `checkpoint_question` (CE-004: the question is a derived,
 * non-injective presentation string, so keying on it collapses two distinct
 * directives that render identically and answering one silently resolves both).
 * A legacy entry written before clause ids existed (no `clause_id`) still
 * resolves by `checkpoint_question` so old checkpoints keep working. Until a
 * clause is resolved it is an unanswered blocking question — returned here so the
 * orchestrator keeps the `intent_checkpoint_current` obligation unsatisfied
 * (re-firing `confirm_intent`) rather than silently dropping the directive at
 * planning time.
 *
 * Deterministic — delegates clause decomposition + encodability + identity to the
 * single shared authority (`interpretFreeFormIntentForAudit` → shared
 * `interpretIntent`).
 */
export function unresolvedConstraintClauses(
  checkpoint: IntentCheckpoint | undefined,
): UnresolvedConstraintClause[] {
  const freeForm = checkpoint?.free_form_intent ?? "";
  if (!freeForm.trim()) return [];

  // Delegate clause decomposition + encodability to the single shared authority.
  const result = interpretIntent(freeForm);
  if (!result.has_unencodable) return [];

  // A clause is answered when an entry with a non-empty host_answer matches it
  // by clause identity (preferred) or, for legacy entries lacking a clause_id,
  // by the rendered checkpoint_question.
  const answeredIds = new Set<string>();
  const answeredQuestions = new Set<string>();
  for (const c of checkpoint?.constraint_clauses ?? []) {
    if (typeof c.host_answer !== "string" || c.host_answer.trim().length === 0) {
      continue;
    }
    if (typeof c.clause_id === "string" && c.clause_id.length > 0) {
      answeredIds.add(c.clause_id);
    } else {
      answeredQuestions.add(c.checkpoint_question);
    }
  }

  const unresolved: UnresolvedConstraintClause[] = [];
  for (const clause of result.clauses) {
    if (clause.encodable || !clause.checkpoint_question) continue;
    if (answeredIds.has(clause.clause_id)) continue;
    if (answeredQuestions.has(clause.checkpoint_question)) continue;
    unresolved.push({
      clause_id: clause.clause_id,
      text: clause.text,
      checkpoint_question: clause.checkpoint_question,
    });
  }
  return unresolved;
}

/**
 * True when the intent checkpoint has at least one unencodable free_form_intent
 * clause the host has not yet answered. The orchestrator treats this as a
 * not-yet-satisfied `intent_checkpoint_current` obligation so the blocking
 * `confirm_intent` step re-fires (no clause silently dropped).
 */
export function hasUnresolvedConstraintClauses(
  checkpoint: IntentCheckpoint | undefined,
): boolean {
  return unresolvedConstraintClauses(checkpoint).length > 0;
}
