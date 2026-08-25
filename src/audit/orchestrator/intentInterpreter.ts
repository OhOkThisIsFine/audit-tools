/**
 * audit-code free_form_intent interpreter consumer.
 *
 * Bridges the audit-tools/shared clause interpreter to the pinned
 * FreeFormIntentInterpretation seam contract (N-X06).
 *
 * INV-S04: the WHOLE verbatim free_form_intent string is never emitted, and
 * worker/dispatch prompt material never carries it in any form. Individual
 * clause substrings DO ride derived fields (clause text, checkpoint
 * questions, the remediate sidecar, run-log notes) — that is inside the
 * charge's plan/prompt/workload scope, and the guarded boundary is the
 * worker-facing prompt surface, not every derived field.
 */

import {
  interpretIntent,
  unresolvedFromClauses,
  FREE_FORM_INTENT_INTERPRETATION_VERSION,
} from "audit-tools/shared";
import type {
  ConstraintClauseRecord,
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

/**
 * A blocking checkpoint question that the host has not yet answered.
 * Alias of the shared {@link ConstraintClauseRecord}: the identity-keyed
 * resolution semantics (CE-004) live in audit-tools/shared
 * (`intent/constraintClauses.ts`) so remediate's sidecar consumer and this
 * gate cannot drift.
 */
export type UnresolvedConstraintClause = ConstraintClauseRecord;

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

  const records: ConstraintClauseRecord[] = [];
  for (const clause of result.clauses) {
    if (clause.encodable || !clause.checkpoint_question) continue;
    records.push({
      clause_id: clause.clause_id,
      text: clause.text,
      checkpoint_question: clause.checkpoint_question,
    });
  }
  // Identity-keyed resolution (CE-004) is the shared core — one matcher for
  // this gate and remediate's sidecar consumer.
  return unresolvedFromClauses(records, checkpoint);
}
