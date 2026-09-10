/**
 * THE clause-boundary scan for `free_form_intent` — one rule, both interpreters.
 *
 * Two interpreters draw over the same operator-written string:
 *
 *   - `freeFormIntentInterpreter.decomposeClauses` — hint extraction (lens
 *     weights / scope / priority). Splits on COMMAS, because its input is a
 *     brief comma-separated list ("security, performance, maintainability") and
 *     a comma is the list separator there.
 *   - `clauseInterpreter.decomposeIntent` — the blocking-checkpoint pipeline,
 *     where every clause must be INDEPENDENTLY assessable, so a comma inside a
 *     clause ("focus on modules A, B, and C") is part of the directive and
 *     " and " is a separator instead.
 *
 * That comma/`and` difference is the ONLY intentional one, and it is what
 * `tests/shared/maintainability-split-rules.test.ts` guards. Everything else
 * about where a clause ENDS is the same question with the same answer, so it
 * lives here rather than in two copies that can drift.
 *
 * WHAT IS NOT A BOUNDARY — and this is the defect this module closes. A bare `;`
 * is how prose punctuates inside ONE thought, not how it ends a sentence:
 *
 *   - `keep the API stable (this is the contract; see docs/x.md)` — the `;` is
 *     inside a parenthetical aside. Splitting there yields
 *     `keep the API stable (this is the contract` and `see docs/x.md)`, and a
 *     half-clause is unencodable *because* it is a half-clause: it names no
 *     lens, no scope and no priority, so it surfaced as an operator-facing
 *     blocking question about text the operator never wrote as a directive.
 *
 * A `;` that separates two genuinely independent directives is STILL a boundary
 * — `focus on src/api; ignore vendor/` must stay two clauses, because a single
 * merged clause would give the whole string ONE polarity (`scopeClausePolarity`
 * returns the first match) and the `ignore` half would be boosted as an
 * inclusion: the exact sign inversion COR-a0648a7d fixed. So the rule is
 * positional, not a blanket off-switch:
 *
 *   - inside parentheses (depth > 0) → never a boundary (an aside is part of its
 *     sentence);
 *   - otherwise, at depth 0 → a boundary, as before.
 *
 * DEPTH IS THE WHOLE TEST — a `;` at depth 0 stays a boundary even when the
 * text after it OPENS with `(`. Suppressing that case (`; (b) …`, `; (see …)`)
 * was tried and is unsound: `(b) ignore vendor/` is a directive in its own
 * right, and a `(see ADR-7)` is an aside that introduces one — merging either
 * into the preceding clause gives the merged text ONE polarity, so the excluded
 * path is ordered FIRST by `applyIntentOrdering` and the sign convention
 * inverts. An `(a) …; (b) …` enumeration is two clauses, exactly like any other
 * pair of `;`-separated directives; what the parentheses mean is decided by the
 * depth this scan tracks, never by where the next `(` happens to sit.
 *
 * Sentence-ending `.` (followed by whitespace or end-of-input) and newlines
 * remain boundaries. The `.` guard is unchanged: it keeps `docs/backlog/x.md`
 * and `PowerShell 5.1` whole, because there the period is followed by a
 * non-space character.
 */

/** Which characters end a clause, beyond the shared sentence/newline rules. */
export interface ClauseBoundaryOptions {
  /**
   * Split on `,`. True for the hint interpreter (a comma-separated priority
   * list), false for the blocking-checkpoint interpreter (commas belong to the
   * directive). This is the ONE declared difference between the two.
   */
  splitOnCommas: boolean;
  /**
   * Split on the word `and`. True for the blocking-checkpoint interpreter,
   * false for the hint interpreter.
   */
  splitOnAnd: boolean;
}

/** Opening/closing bracket pairs whose depth suppresses a `;` boundary. */
const OPENING = "([{";
const CLOSING = ")]}";

/**
 * Split a free-form intent string into its clause texts, in order, trimmed and
 * with empties dropped. Pure and synchronous — no I/O, no LLM calls.
 */
export function splitIntentClauses(
  input: string,
  options: ClauseBoundaryOptions,
): string[] {
  if (typeof input !== "string" || input.trim().length === 0) return [];

  const text = input.replace(/\r\n/g, "\n");
  const clauses: string[] = [];
  let current = "";
  let depth = 0;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) clauses.push(trimmed);
    current = "";
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;

    if (OPENING.includes(char)) {
      depth += 1;
      current += char;
      continue;
    }
    if (CLOSING.includes(char)) {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ";" && depth === 0) {
      flush();
      continue;
    }
    if (char === "\n") {
      flush();
      continue;
    }
    if (options.splitOnCommas && char === "," && depth === 0) {
      flush();
      continue;
    }
    if (
      char === "." &&
      depth === 0 &&
      isSentenceEnd(text, index)
    ) {
      flush();
      continue;
    }
    if (
      options.splitOnAnd &&
      depth === 0 &&
      isWordAnd(text, index)
    ) {
      index += 2; // consume "and"
      flush();
      continue;
    }

    current += char;
  }
  flush();
  return clauses;
}

/** A `.` ends a sentence only before whitespace or end-of-input. */
function isSentenceEnd(text: string, index: number): boolean {
  const next = text[index + 1];
  return next === undefined || /\s/.test(next);
}

/**
 * True when `text` at `index` spells the standalone word `and` (word-boundary
 * on both sides), so `demand` and `Android` are never split points.
 */
function isWordAnd(text: string, index: number): boolean {
  if (text.slice(index, index + 3).toLowerCase() !== "and") return false;
  const before = index === 0 ? "" : (text[index - 1] as string);
  const after = text[index + 3];
  return (
    !/[A-Za-z0-9_]/.test(before) && (after === undefined || !/[A-Za-z0-9_]/.test(after))
  );
}
