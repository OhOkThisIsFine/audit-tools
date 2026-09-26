// sites-pinned: tests/remediate/intent-constraint-clauses.test.ts
/**
 * Constraint-clause resolution — the SHARED half of the blocking-escalation
 * gate for unencodable free_form_intent clauses.
 *
 * One core, two draws: audit derives the clause list via `interpretIntent`
 * and calls {@link unresolvedFromClauses}; remediate reads its persisted
 * intent-interpretation sidecar (repairing by re-derivation when missing or
 * stale) and calls the same function. Resolution is keyed on CLAUSE IDENTITY
 * (`clause_id`, CE-004) — never on the rendered `checkpoint_question`, which
 * is a derived, non-injective presentation string: keying on it collapses two
 * distinct directives that render identically, so answering one silently
 * resolves both. A legacy `constraint_clauses` entry written before clause
 * ids existed (no `clause_id`) still resolves by `checkpoint_question` so old
 * checkpoints keep working.
 */

import type { IntentCheckpoint } from "../types/intentCheckpoint.js";

/** One unencodable clause with its identity and blocking question. */
export interface ConstraintClauseRecord {
  /** Stable clause identity — the resolution key (CE-004). */
  clause_id: string;
  /** The original unencodable clause text. */
  text: string;
  /** The blocking question that must be answered before planning proceeds. */
  checkpoint_question: string;
}

/**
 * The clauses from `clauses` that the checkpoint has NOT yet resolved via a
 * `constraint_clauses` entry carrying a non-empty `host_answer`.
 */
export function unresolvedFromClauses(
  clauses: readonly ConstraintClauseRecord[],
  checkpoint: IntentCheckpoint | undefined,
): ConstraintClauseRecord[] {
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

  return clauses.filter(
    (clause) =>
      !answeredIds.has(clause.clause_id) &&
      !answeredQuestions.has(clause.checkpoint_question),
  );
}

/**
 * Project unencodable clauses from an interpreted intent clause list into
 * {@link ConstraintClauseRecord}s. Unencodable clauses with a blocking
 * checkpoint question become records; encodable or question-less clauses are skipped.
 */
export function projectUnencodableConstraintClauses(
  clauses: readonly {
    clause_id: string;
    text: string;
    encodable: boolean;
    checkpoint_question?: string;
  }[],
): ConstraintClauseRecord[] {
  const records: ConstraintClauseRecord[] = [];
  for (const clause of clauses) {
    if (clause.encodable || !clause.checkpoint_question) continue;
    records.push({
      clause_id: clause.clause_id,
      text: clause.text,
      checkpoint_question: clause.checkpoint_question,
    });
  }
  return records;
}
