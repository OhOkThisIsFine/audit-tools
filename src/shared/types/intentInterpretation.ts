/**
 * Versioned seam contract for the free_form_intent Interpreter (N-X06).
 *
 * Pins the output shape of the intent interpretation step so that consumers
 * (audit-code, remediate-code) can be validated against a single,
 * version-stamped result interface.
 *
 * The implementing function lives in src/intent/clauseInterpreter.ts (interpretIntent)
 * and src/intent/freeFormIntentInterpreter.ts (interpretFreeFormIntent).
 * This file ONLY declares the contract types and the version constant.
 */

import type { Lens } from "./lens.js";

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

/**
 * Version string for the FreeFormIntentInterpretation contract.
 * Increment when any breaking interface change lands.
 */
export const FREE_FORM_INTENT_INTERPRETATION_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** A single encoded clause with its signal kind and detail. */
export interface EncodedClause {
  /** Original clause text (trimmed, never the verbatim free_form_intent). */
  text: string;
  /** The signal kind this clause encoded to. */
  kind: "lens_weight" | "priority_signal" | "scope_emphasis";
  /**
   * Human-readable detail describing what was encoded.
   * e.g. "Matches lens(es): security" or "Contains urgency/priority keyword".
   */
  detail: string;
  /**
   * Lens name, present only when kind === "lens_weight".
   * Enables callers to correlate encoded clauses with lens-weighting logic.
   */
  lens?: Lens;
}

/**
 * Structured output of the free-form intent interpreter.
 *
 * INV-S04: The verbatim free_form_intent string MUST NOT appear in any field
 * of this type. All output is derived signal, never the raw input.
 */
export interface FreeFormIntentInterpretation {
  /** Schema version — must equal FREE_FORM_INTENT_INTERPRETATION_VERSION. */
  schema_version: typeof FREE_FORM_INTENT_INTERPRETATION_VERSION;
  /**
   * Clauses that were successfully encoded as planning signals
   * (lens weights, priority signals, scope emphases).
   */
  encoded_clauses: EncodedClause[];
  /**
   * Blocking checkpoint questions generated from clauses that could not be
   * encoded. Each question must be answered before planning proceeds.
   */
  checkpoint_questions: string[];
  /** True when at least one clause produced a checkpoint question. */
  has_unencodable: boolean;
}
