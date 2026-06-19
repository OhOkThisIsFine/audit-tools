/**
 * Free-form intent interpreter.
 *
 * Converts a free_form_intent string from IntentCheckpoint into structured
 * priority/lens/scope signals consumed at planning time. The verbatim string
 * is NEVER threaded into worker or dispatch prompts (INV-S04).
 *
 * All logic is pure and synchronous — no I/O, no LLM calls.
 */

import { LENS_KEYWORD_MAP, SCOPE_PATTERNS, PRIORITY_PATTERNS } from "./sharedIntentData.js";
import type { Lens } from "../types/lens.js";

// Re-export shared data so callers that only import from this module keep working.
export { LENS_KEYWORD_MAP, SCOPE_PATTERNS, PRIORITY_PATTERNS };

/** Structured output emitted by interpretFreeFormIntent. */
export interface InterpretedIntent {
  /**
   * Per-lens weight multipliers. A lens present here should receive boosted
   * priority during planning (default boost = 1.5). Absent lenses get
   * weight 1.0 (unchanged).
   */
  lensWeights: Partial<Record<Lens, number>>;
  /**
   * Clauses signalling urgency / high importance (e.g. "urgent", "critical",
   * "most important"). Used to front-load planning work.
   */
  prioritySignals: string[];
  /**
   * Clauses that narrow or exclude scope (e.g. "focus on the auth module",
   * "ignore vendor/").
   */
  scopeEmphasis: string[];
  /**
   * Clauses that could not be encoded as a lens weight, scope emphasis, or
   * priority signal. Callers SHOULD promote these to blocking checkpoint
   * questions rather than silently dropping them.
   */
  unencodableClauses: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHT_BOOST = 1.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split input into clauses on sentence, semicolon, comma, and newline
 * boundaries.
 *
 * **Why comma-splitting is intentional here:**
 * This function is used for free-form intent *hint* extraction where the input
 * is a brief, comma-separated list of priorities (e.g. "security, performance,
 * maintainability"). Commas are the most natural separator for such lists and
 * splitting on them maximises individual lens keyword coverage.
 *
 * **Compare with `clauseInterpreter.decomposeIntent`:**
 * That function is used for the *blocking-checkpoint* intent pipeline where
 * clauses must be independently assessable and commas within a clause should
 * NOT split it (e.g. "focus on modules A, B, and C" is one clause, not three).
 * It therefore splits only on semicolons, " and ", newlines, and ". " sentence
 * boundaries — NOT on commas.
 *
 * The two functions intentionally have different splitting rules. Any change to
 * one should be evaluated against the contract of the other. See
 * `tests/maintainability-split-rules.test.mjs` for a regression assertion that
 * guards the difference.
 */
function decomposeClauses(input: string): string[] {
  // Split on `;`, `,`, newlines, and sentence-ending `.` — but NOT a period
  // flanked by digits, so version/decimal tokens stay intact ("Windows
  // PowerShell 5.1" must not fragment into "...5" + "1", which then surfaces a
  // spurious unencodable clause). A run of separators collapses to one split.
  return input
    .split(/(?:[;,\n]|(?<![0-9])\.(?![0-9]))+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Return matched Lens values for a clause (may be empty). */
function matchLenses(clause: string): Lens[] {
  const lower = clause.toLowerCase();
  const matched = new Set<Lens>();
  for (const { keywords, lens } of LENS_KEYWORD_MAP) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(lens);
        break; // one keyword match is enough per entry
      }
    }
  }
  return [...matched];
}

/** Return the first scope-emphasis string for a clause, or null. */
function matchScopeEmphasis(clause: string): string | null {
  for (const pattern of SCOPE_PATTERNS) {
    const m = pattern.exec(clause);
    if (m) {
      return clause.trim();
    }
  }
  return null;
}

/** Return true if the clause signals urgency/priority. */
function matchesPriority(clause: string): boolean {
  return PRIORITY_PATTERNS.some((p) => p.test(clause));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interpret a free-form intent string into structured planning signals.
 *
 * - Empty / blank → zero-weight result with empty arrays.
 * - Verbatim input string never appears in any output field.
 * - Pure / synchronous — safe to call in deterministic planning paths.
 */
export function interpretFreeFormIntent(input: string): InterpretedIntent {
  const result: InterpretedIntent = {
    lensWeights: {},
    prioritySignals: [],
    scopeEmphasis: [],
    unencodableClauses: [],
  };

  if (!input || !input.trim()) {
    return result;
  }

  const clauses = decomposeClauses(input);

  for (const clause of clauses) {
    let encoded = false;

    // Lens matching
    const lenses = matchLenses(clause);
    if (lenses.length > 0) {
      for (const lens of lenses) {
        const current = result.lensWeights[lens] ?? 1.0;
        // Accumulate boost — repeated mentions increase weight slightly.
        result.lensWeights[lens] = Math.max(current, DEFAULT_WEIGHT_BOOST);
      }
      encoded = true;
    }

    // Priority signal
    if (matchesPriority(clause)) {
      result.prioritySignals.push(clause);
      encoded = true;
    }

    // Scope emphasis
    const scope = matchScopeEmphasis(clause);
    if (scope !== null) {
      result.scopeEmphasis.push(scope);
      encoded = true;
    }

    if (!encoded) {
      result.unencodableClauses.push(clause);
    }
  }

  return result;
}
