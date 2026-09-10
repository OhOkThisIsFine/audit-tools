/**
 * Free-form intent interpreter.
 *
 * Converts a free_form_intent string from IntentCheckpoint into structured
 * priority/lens/scope signals consumed at planning time. The verbatim string
 * is NEVER threaded into worker or dispatch prompts (INV-S04).
 *
 * All logic is pure and synchronous — no I/O, no LLM calls.
 */

import {
  LENS_KEYWORD_MAP,
  SCOPE_PATTERNS,
  PRIORITY_PATTERNS,
  scopeClausePolarity,
} from "./sharedIntentData.js";
import { splitIntentClauses } from "./clauseBoundaries.js";
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
   * INCLUSION-polarity clauses that narrow scope IN (e.g. "focus on the auth
   * module", "only audit src/"). Never carries an exclusion clause — see
   * {@link scopeExclusions} — so a consumer boosting by scope match cannot
   * accidentally boost the scope the user asked to avoid (COR-a0648a7d).
   */
  scopeEmphasis: string[];
  /**
   * EXCLUSION-polarity clauses that narrow scope OUT (e.g. "ignore vendor/",
   * "skip tests/"). Kept in a DEDICATED field, never merged into
   * {@link scopeEmphasis}, so a consumer can tell "the user wants this in
   * focus" from "the user wants this avoided" without re-parsing the lead-in
   * verb itself (the sign-convention bug COR-a0648a7d / COR-a0648a7d-2).
   */
  scopeExclusions: string[];
  /**
   * Clauses that could not be encoded as a lens weight, scope emphasis, or
   * priority signal. Callers SHOULD promote these to blocking checkpoint
   * questions rather than silently dropping them.
   *
   * Each entry is the clause TEXT. The sentence-boundary splitter keeps these
   * whole clauses rather than fragments, so an entry is a directive the operator
   * actually wrote — see `clauseBoundaries.ts`.
   */
  unencodableClauses: string[];
  /**
   * How many clauses the input decomposed into. Reported so a reader can tell
   * "one directive, unencodable" from "six fragments, all unencodable" — the
   * two look identical when only the unencodable list is shown, and the second
   * shape was the fragmentation defect this splitter no longer produces.
   */
  clauseCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHT_BOOST = 1.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split input into clauses on sentence, comma and newline boundaries — but NOT
 * on a bare `;`.
 *
 * **Why comma-splitting is intentional here:**
 * This function is used for free-form intent *hint* extraction where the input
 * is a brief, comma-separated list of priorities (e.g. "security, performance,
 * maintainability"). Commas are the most natural separator for such lists and
 * splitting on them maximises individual lens keyword coverage.
 *
 * **Why a `;` inside a parenthetical is NOT a separator — the fragmentation this
 * closes.** `… (this is the contract; see docs/x.md)` is one thought with a
 * parenthetical aside, and splitting on that `;` shredded it into fragments that
 * are unencodable *because* they are fragments — a half-clause names no lens, no
 * scope and no priority, so each surfaced as an operator-facing blocking
 * question about text the operator never wrote as a standalone clause.
 *
 * **A `;` at depth 0 ALWAYS separates.** `focus on src/api; ignore vendor/` must
 * stay two clauses: merged, the text has ONE polarity and the excluded half is
 * boosted as an inclusion (COR-a0648a7d). That holds when the next clause opens
 * with a parenthesis too — `(a) …; (b) ignore …` is two directives, and a
 * `(see ADR-7)` aside introduces the one after it. Suppressing a depth-0 `;`
 * merely because the next non-space char is `(` re-inverted the sign for exactly
 * those forms. Sentence-ending `.` and newlines still split.
 *
 * **Compare with `clauseInterpreter.decomposeIntent`:**
 * That function is used for the *blocking-checkpoint* intent pipeline where
 * clauses must be independently assessable and commas within a clause should
 * NOT split it (e.g. "focus on modules A, B, and C" is one clause, not three).
 * It therefore splits on " and ", newlines, and ". " sentence boundaries — NOT
 * on commas — and does not treat `;` as a boundary either.
 *
 * The two functions still differ on commas, and that difference is intentional.
 * Any change to one should be evaluated against the contract of the other. See
 * `tests/shared/maintainability-split-rules.test.ts` for a regression assertion
 * that guards the difference.
 */
function decomposeClauses(input: string): string[] {
  return splitIntentClauses(input, { splitOnCommas: true, splitOnAnd: false });
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
    scopeExclusions: [],
    unencodableClauses: [],
    clauseCount: 0,
  };

  if (!input || !input.trim()) {
    return result;
  }

  const clauses = decomposeClauses(input);

  // The clause COUNT is reported alongside the clauses themselves, so a caller
  // (and the operator reading the emission) can see how many directives the
  // intent decomposed into without re-counting the arrays below. A count is not
  // a promise that each clause was encodable — `unencodableClauses` is.
  result.clauseCount = clauses.length;

  for (const clause of clauses) {
    let encoded = false;

    // A clause's polarity gates the lens boost below: an EXCLUSION-polarity
    // clause (e.g. "ignore performance issues") must never register a
    // positive lensWeight for a keyword it happens to contain — the user
    // asked to de-emphasise this clause, not weight it (COR-a0648a7d).
    const polarity = scopeClausePolarity(clause);

    // Lens matching
    if (polarity !== "exclude") {
      const lenses = matchLenses(clause);
      if (lenses.length > 0) {
        for (const lens of lenses) {
          const current = result.lensWeights[lens] ?? 1.0;
          // Accumulate boost — repeated mentions increase weight slightly.
          result.lensWeights[lens] = Math.max(current, DEFAULT_WEIGHT_BOOST);
        }
        encoded = true;
      }
    }

    // Priority signal
    if (matchesPriority(clause)) {
      result.prioritySignals.push(clause);
      encoded = true;
    }

    // Scope emphasis — polarity decides the destination field. An INCLUSION
    // clause lands in `scopeEmphasis` (unchanged from before this fix); an
    // EXCLUSION clause lands in the dedicated `scopeExclusions` field instead
    // of being merged in, so a downstream consumer never has to re-derive
    // polarity from the clause text (COR-a0648a7d / COR-a0648a7d-2).
    if (polarity === "include") {
      result.scopeEmphasis.push(clause.trim());
      encoded = true;
    } else if (polarity === "exclude") {
      result.scopeExclusions.push(clause.trim());
      encoded = true;
    }

    if (!encoded) {
      result.unencodableClauses.push(clause);
    }
  }

  return result;
}
