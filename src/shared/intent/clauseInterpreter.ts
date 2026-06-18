/**
 * Per-clause intent interpreter.
 *
 * Extends the free-form intent pipeline with per-clause encodability assessment.
 * Fixes CE-005 (compound intent silently drops unrecognised directives) and
 * CE-206 (total-encoding-failure check too coarse — single bad clause blocks
 * all encodable clauses). Satisfies OBL-S10 / OBL-X07.
 *
 * Key invariant: ANY clause that cannot be encoded independently triggers a
 * blocking checkpoint question; encodable clauses proceed regardless.
 *
 * All logic is pure and synchronous — no I/O, no LLM calls.
 */

import { LENS_KEYWORD_MAP, SCOPE_PATTERNS, PRIORITY_PATTERNS } from "./sharedIntentData.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three signal kinds a clause can encode to. */
export type IntentClauseKind = "lens_weight" | "priority_signal" | "scope_emphasis";

/** Result of decomposing and assessing a single clause. */
export interface IntentClause {
  /** The original clause text (trimmed). */
  text: string;
  /** Whether this clause maps to at least one recognised signal. */
  encodable: boolean;
  /** Present when encodable is true. */
  encoded_as?: {
    kind: IntentClauseKind;
    detail: string;
  };
  /** Present when encodable is false — a human/host-answerable blocking question. */
  checkpoint_question?: string;
}

/** Output of interpretIntent — the top-level clause-aware result. */
export interface ClauseInterpretResult {
  /** One entry per discrete clause in the input. */
  clauses: IntentClause[];
  /**
   * Subset of clauses that could not be encoded, promoted to blocking
   * checkpoint questions that must be answered before planning proceeds.
   */
  checkpoint_questions: string[];
  /** True when at least one clause could not be encoded. */
  has_unencodable: boolean;
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

/**
 * Split a compound free-form intent string into discrete single-purpose
 * clauses. Splits on semicolons, " and ", newlines, and sentence boundaries
 * (". " followed by an uppercase letter or end-of-string). Returns an empty
 * array for empty/whitespace-only input.
 *
 * **Why commas do NOT split here:**
 * This function is used in the *blocking-checkpoint* intent pipeline where
 * each clause must be an independently assessable directive. A comma within a
 * clause (e.g. "focus on modules A, B, and C") is part of that directive, not
 * a clause separator. Splitting on commas would fragment such directives into
 * unrecognisable pieces, producing spurious unencodable clauses.
 *
 * **Compare with `freeFormIntentInterpreter.decomposeClauses`:**
 * That function splits on commas because it processes brief hint lists where
 * commas are the primary separator (e.g. "security, performance"). Its output
 * is a set of keyword-match inputs, not independently assessable directives.
 *
 * The two functions intentionally have different splitting rules. See
 * `tests/maintainability-split-rules.test.mjs` for a regression assertion.
 */
export function decomposeIntent(free_form_intent: string): IntentClause[] {
  if (!free_form_intent || !free_form_intent.trim()) {
    return [];
  }

  // Split on `;`, ` and ` (word boundary), newlines, and `. ` sentence breaks.
  // We use a multi-step split so we can preserve ordering without a complex regex.
  const raw = free_form_intent
    // Normalise newlines
    .replace(/\r\n/g, "\n")
    // Split on semicolons
    .split(/;/)
    .flatMap((seg) =>
      // Split each segment on " and " (word-boundary variant)
      seg.split(/\band\b/i)
    )
    .flatMap((seg) =>
      // Split on newlines
      seg.split(/\n/)
    )
    .flatMap((seg) => {
      // Split on ". " sentence boundaries (keep the remainder)
      const parts: string[] = [];
      let remaining = seg;
      let match: RegExpExecArray | null;
      const sentenceRe = /\.\s+/g;
      let lastIndex = 0;
      sentenceRe.lastIndex = 0;
      while ((match = sentenceRe.exec(remaining)) !== null) {
        parts.push(remaining.slice(lastIndex, match.index + 1));
        lastIndex = match.index + match[0].length;
        // sentenceRe.lastIndex is already at lastIndex after exec; no reassignment needed.
      }
      parts.push(remaining.slice(lastIndex));
      return parts;
    })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Assess each raw clause
  return raw.map((text) => assessClauseEncodabilityAsClause(text));
}

// ---------------------------------------------------------------------------
// Encodability assessment (internal helpers)
// ---------------------------------------------------------------------------

/** Return matched lens names for a clause. */
function matchLenses(clause: string): string[] {
  const lower = clause.toLowerCase();
  const matched: string[] = [];
  for (const { keywords, lens } of LENS_KEYWORD_MAP) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(lens);
        break;
      }
    }
  }
  return matched;
}

/** Return true if the clause matches a scope-emphasis pattern. */
function matchesScopeEmphasis(clause: string): boolean {
  return SCOPE_PATTERNS.some((p) => p.test(clause));
}

/** Return true if the clause signals urgency / priority. */
function matchesPriority(clause: string): boolean {
  return PRIORITY_PATTERNS.some((p) => p.test(clause));
}

/** Generate a checkpoint question for an unencodable clause. */
function generateCheckpointQuestion(clause: string): string {
  return (
    `The intent clause "${clause}" could not be encoded as a lens weight, ` +
    `priority signal, or scope emphasis. How should this directive be applied ` +
    `during planning and review? Please clarify the concrete action expected.`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assess whether a single clause can be encoded as a planning signal.
 *
 * Returns a structured assessment — encodable: true if it maps to at least
 * one signal kind; encodable: false with a checkpoint_question if it cannot.
 */
export function assessClauseEncodability(clause: string): {
  encodable: boolean;
  kind?: IntentClauseKind;
  detail?: string;
  checkpoint_question?: string;
} {
  const text = clause.trim();

  const lenses = matchLenses(text);
  if (lenses.length > 0) {
    return {
      encodable: true,
      kind: "lens_weight",
      detail: `Matches lens(es): ${lenses.join(", ")}`,
    };
  }

  if (matchesPriority(text)) {
    return {
      encodable: true,
      kind: "priority_signal",
      detail: `Contains urgency/priority keyword`,
    };
  }

  if (matchesScopeEmphasis(text)) {
    return {
      encodable: true,
      kind: "scope_emphasis",
      detail: `Matches scope-emphasis pattern`,
    };
  }

  return {
    encodable: false,
    checkpoint_question: generateCheckpointQuestion(text),
  };
}

/** Internal variant that returns a full IntentClause object. */
function assessClauseEncodabilityAsClause(text: string): IntentClause {
  const result = assessClauseEncodability(text);
  if (result.encodable && result.kind && result.detail) {
    return {
      text,
      encodable: true,
      encoded_as: { kind: result.kind, detail: result.detail },
    };
  }
  return {
    text,
    encodable: false,
    checkpoint_question: result.checkpoint_question,
  };
}

/**
 * Top-level clause-aware intent interpretation.
 *
 * Decomposes the free-form intent into clauses, assesses each independently,
 * and promotes any unencodable clauses to blocking checkpoint questions.
 * Encodable clauses proceed regardless of whether other clauses fail.
 */
export function interpretIntent(free_form_intent: string): ClauseInterpretResult {
  const clauses = decomposeIntent(free_form_intent);
  const checkpoint_questions: string[] = [];

  for (const clause of clauses) {
    if (!clause.encodable && clause.checkpoint_question) {
      checkpoint_questions.push(clause.checkpoint_question);
    }
  }

  return {
    clauses,
    checkpoint_questions,
    has_unencodable: checkpoint_questions.length > 0,
  };
}
