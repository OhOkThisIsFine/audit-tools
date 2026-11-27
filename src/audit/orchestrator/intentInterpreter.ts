// sites-pinned: tests/audit-smoke.test.mjs
/**
 * audit-code free_form_intent interpreter consumer.
 *
 * Bridges the audit-tools/shared clause interpreter to the pinned
 * FreeFormIntentInterpretation seam contract.
 *
 * INV-S04: the WHOLE verbatim free_form_intent string is never emitted, and
 * worker/dispatch prompt material never carries it in any form. Individual
 * clause substrings DO ride derived fields (clause text, checkpoint
 * questions, the remediate sidecar, run-log notes) — that is inside the
 * charge's plan/prompt/workload scope, and the guarded boundary is the
 * worker-facing prompt surface, not every derived field.
 */

import { interpretIntent, unresolvedFromClauses, constraintClausesFromIntent } from "audit-tools/shared";
import type { ConstraintClauseRecord, IntentCheckpoint } from "audit-tools/shared";

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
 * single shared authority (`interpretIntent`).
 */
export function unresolvedConstraintClauses(
  checkpoint: IntentCheckpoint | undefined,
): ConstraintClauseRecord[] {
  const freeForm = checkpoint?.free_form_intent ?? "";
  if (!freeForm.trim()) return [];

  // Delegate clause decomposition + encodability to the single shared authority.
  const result = interpretIntent(freeForm);
  if (!result.has_unencodable) return [];

  const records = constraintClausesFromIntent(result.clauses);
  // Identity-keyed resolution (CE-004) is the shared core — one matcher for
  // this gate and remediate's sidecar consumer.
  return unresolvedFromClauses(records, checkpoint);
}
