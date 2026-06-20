/**
 * DC-5 — obligation change-vs-addition classification + paired/scoped negative
 * test-spec gate (single source).
 *
 * Two latent failure modes this module closes:
 *
 *   CE-013 (render-only misclassification): the paired-obligation gate used to
 *     force EVERY testable obligation to carry a positive+negative pair, with no
 *     notion of whether the obligation changes prior behavior or adds new
 *     behavior. A pure addition has no behavior to regress, so pairing it is
 *     burden without signal — and, worse, the "classification" lived only in the
 *     prompt prose (render-only), never as a recorded, checkable verdict. This
 *     module classifies each obligation *deterministically first* (does it touch
 *     a symbol/file that already exists?) and records the verdict on the ledger,
 *     so an LLM may confirm/override but the result is never silent.
 *
 *   CE-006 (unscoped repo-wide-grep negative): a behavior-CHANGE obligation's
 *     negative half could be satisfied by an assertion that greps the whole repo
 *     ("no file anywhere contains X") — which rots immediately and proves nothing
 *     about the changed symbol. The negative must be SCOPED to the changed
 *     symbol/file. The scope check is a structural PREDICATE over the assertion
 *     (it must name an anchor AND must not be an unscoped global scan), not a
 *     keyword match — keyword matching alone is exactly what let the unscoped
 *     negative through.
 *
 * Single-source invariant (mirrors `derive.ts`): the deriver, the test-plan
 * derivation gate (`validatePairedObligations`), and the `mergeImplementResults`
 * verify gate ALL classify and pair through the helpers here. No parallel logic.
 */
import { isRecord, type ObligationChangeClassification } from "audit-tools/shared";

// ── Symbol extraction ─────────────────────────────────────────────────────────

/**
 * Identifier-like tokens (camelCase / snake_case / dotted / path-ish) that name a
 * code symbol or file. Length >= 3 so single letters and noise are ignored.
 * Used both to pull candidate symbols out of an obligation description and to
 * build the baseline corpus of pre-existing symbols.
 */
const SYMBOL_TOKEN_PATTERN = /[A-Za-z_$][A-Za-z0-9_$./-]{2,}/g;

/** Common English words that look identifier-ish but never name a symbol. */
const SYMBOL_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "must", "not", "its", "via",
  "per", "into", "when", "then", "than", "from", "module", "function", "value",
  "input", "output", "inputs", "outputs", "should", "shall", "handle", "failure",
  "mode", "implement", "contract", "boundary", "validation", "every", "each",
  "obligation", "behavior", "behaviour", "existing", "new", "add", "change",
]);

/** Extract candidate symbol/file tokens from free text (lowercased, de-noised). */
export function extractSymbolTokens(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = new Set<string>();
  for (const raw of text.match(SYMBOL_TOKEN_PATTERN) ?? []) {
    const token = raw.toLowerCase().replace(/^[./-]+|[./-]+$/g, "");
    if (token.length < 3) continue;
    if (SYMBOL_STOPWORDS.has(token)) continue;
    // A token must carry a "code-ish" shape — a case hump, an underscore, a dot,
    // a slash, or a digit — so a plain prose word ("rejects") is not mistaken for
    // a symbol while `writeRecord`, `flush_buffer`, `src/a.ts`, `O_1` are kept.
    if (/[A-Z]/.test(raw.slice(1)) || /[_./\-0-9]/.test(token)) {
      out.add(token);
    }
  }
  return [...out];
}

/**
 * Build the baseline corpus of pre-existing symbol/file tokens from the finalized
 * module contracts. A symbol present here already exists, so an obligation that
 * references it is *changing* existing behavior rather than adding new behavior.
 *
 * The corpus is drawn from the declared interface surface (inputs / outputs /
 * side_effects / validation_boundary) plus each module name — the things the
 * contract says already exist at the seam.
 */
export function buildBaselineSymbolCorpus(finalizedModuleContracts: unknown): Set<string> {
  const corpus = new Set<string>();
  const record = isRecord(finalizedModuleContracts) ? finalizedModuleContracts : {};
  const modules = Array.isArray(record.module_contracts) ? record.module_contracts : [];
  for (const mod of modules) {
    if (!isRecord(mod)) continue;
    if (typeof mod.name === "string") {
      for (const t of extractSymbolTokens(mod.name)) corpus.add(t);
    }
    for (const field of ["inputs", "outputs", "side_effects"] as const) {
      if (!Array.isArray(mod[field])) continue;
      for (const entry of mod[field] as unknown[]) {
        if (typeof entry !== "string") continue;
        for (const t of extractSymbolTokens(entry)) corpus.add(t);
      }
    }
    if (typeof mod.validation_boundary === "string") {
      for (const t of extractSymbolTokens(mod.validation_boundary)) corpus.add(t);
    }
  }
  return corpus;
}

// ── Deterministic classification (FIRST pass) ──────────────────────────────────

/**
 * Classify one obligation change-vs-addition deterministically.
 *
 * Heuristic: the obligation *touches an existing symbol* when any symbol token in
 * its description is present in the baseline corpus of pre-existing symbols. Such
 * an obligation is a behavior CHANGE; otherwise it is a pure ADDITION.
 *
 * The matched tokens become `touched_symbols` — the scope anchors a paired
 * negative assertion must name. This is the deterministic FIRST pass; an LLM may
 * confirm or override it via `applyLlmConfirmation`, and the override is recorded.
 */
export function classifyObligationChange(
  description: string,
  baselineSymbols: Set<string>,
): ObligationChangeClassification {
  const tokens = extractSymbolTokens(description);
  const touched = tokens.filter((t) => baselineSymbols.has(t));
  if (touched.length > 0) {
    return {
      change_kind: "change",
      touched_symbols: touched,
      determined_by: "touches_existing_symbol",
    };
  }
  return {
    change_kind: "addition",
    touched_symbols: [],
    determined_by: "no_existing_symbol",
  };
}

/** An LLM verdict that confirms or overrides the deterministic classification. */
export interface LlmClassificationVerdict {
  change_kind: "change" | "addition";
  /** When the LLM marks a change, the symbols it says are touched (scope anchors). */
  touched_symbols?: string[];
  rationale?: string;
}

/**
 * Merge an LLM verdict onto the deterministic classification, recording the
 * provenance. The LLM may CONFIRM (same verdict) or OVERRIDE (different verdict);
 * either way the result is recorded so the classification is never silent. When
 * the LLM overrides to a change but names no anchors, the deterministically
 * extracted touched symbols are preserved (a change always needs an anchor set).
 */
export function applyLlmConfirmation(
  deterministic: ObligationChangeClassification,
  llm: LlmClassificationVerdict,
): ObligationChangeClassification {
  const confirmed = llm.change_kind === deterministic.change_kind;
  const touched =
    llm.change_kind === "change"
      ? dedupe([
          // Normalize LLM-provided anchors to the same lowercased form the
          // deterministic extractor uses, so the recorded anchor set is consistent.
          ...(llm.touched_symbols ?? []).map((s) =>
            typeof s === "string" ? s.toLowerCase() : s,
          ),
          ...deterministic.touched_symbols,
        ])
      : [];
  return {
    change_kind: llm.change_kind,
    touched_symbols: touched,
    determined_by: confirmed ? "llm_confirmed" : "llm_override",
    ...(llm.rationale ? { rationale: llm.rationale } : {}),
  };
}

// ── Anti-rot scope predicate (CE-006) ──────────────────────────────────────────

/**
 * Markers of an UNSCOPED, repo-wide negative assertion — a grep/scan over the
 * whole tree that names no specific symbol and rots the moment any unrelated file
 * matches. Presence of one of these (without an offsetting scope anchor) is what
 * the predicate rejects. This is a STRUCTURAL signal about the assertion's shape,
 * distinct from polarity keywords.
 */
const UNSCOPED_GLOBAL_SCAN_PATTERN =
  /\b(?:repo[\s-]?wide|whole\s+repo|entire\s+(?:repo|codebase|tree)|across\s+the\s+(?:repo|codebase|tree)|any\s+file|no\s+file\s+(?:anywhere|in\s+the\s+repo)|anywhere\s+in\s+the\s+(?:repo|codebase|tree)|grep\s+(?:the\s+)?(?:repo|codebase|tree))\b/i;

/** Match a scope anchor as a whole word/path fragment inside an assertion. */
function assertionNamesAnchor(assertion: string, anchor: string): boolean {
  if (anchor.length < 3) return false;
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word/path boundary: the anchor is not glued to surrounding identifier chars.
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "i").test(assertion);
}

/**
 * A negative assertion for a behavior-CHANGE obligation is SCOPED when it names
 * at least one of the change's anchors (the touched symbol/file) AND is not an
 * unscoped repo-wide scan. Naming an anchor is necessary but not sufficient: an
 * assertion that both names the symbol and says "grep the whole repo" is still
 * rejected, because the scan, not the symbol, is what it actually checks.
 *
 * Returns true when the assertion is acceptably scoped to the change.
 */
export function negativeAssertionIsScoped(
  assertion: string,
  anchors: readonly string[],
): boolean {
  if (typeof assertion !== "string" || assertion.length === 0) return false;
  if (UNSCOPED_GLOBAL_SCAN_PATTERN.test(assertion)) return false;
  return anchors.some((a) => assertionNamesAnchor(assertion, a));
}

// ── Polarity detection (shared with the legacy keyword gate) ───────────────────

/** Phrases that mark a negative/failure assertion (paired-obligation half). */
export const NEGATIVE_ASSERTION_PATTERN =
  /\b(rejects?|rejected|throws?|errors?|fails?|failure|invalid|disallows?|forbidden|refuses?|must not|does not|should not|cannot|never|negative|missing|absent|empty)\b/i;

/** Phrases that mark a positive/satisfied assertion (paired-obligation half). */
export const POSITIVE_ASSERTION_PATTERN =
  /\b(accept|accepted|allow|allowed|succeed|succeeds|returns?|produces?|valid|present|satisfies|satisfied|passes?|emits?|writes?|equal|equals|matches?)\b/i;

/** The polarity an assertion declares, accounting for an authoritative label. */
export type AssertionPolarity = "positive" | "negative" | "both" | "none";

/**
 * Classify one assertion's polarity. An explicit `POSITIVE:` / `NEGATIVE:` label
 * is authoritative and skips the keyword fallback (so "POSITIVE: must not exceed
 * N" counts only as positive). Unlabeled assertions fall through to the keyword
 * regexes, which may match both polarities.
 */
export function assertionPolarity(assertion: string): AssertionPolarity {
  const label = /^\s*(POSITIVE|NEGATIVE)\s*:/i.exec(assertion);
  if (label) {
    return label[1].toUpperCase() === "POSITIVE" ? "positive" : "negative";
  }
  const neg = NEGATIVE_ASSERTION_PATTERN.test(assertion);
  const pos = POSITIVE_ASSERTION_PATTERN.test(assertion);
  if (neg && pos) return "both";
  if (neg) return "negative";
  if (pos) return "positive";
  return "none";
}

// ── Paired-spec evaluation (the gate primitive) ────────────────────────────────

/**
 * The pairing verdict for a single CHANGE obligation against its covering test
 * specs' assertions. `ok` is true only when BOTH a positive assertion and a
 * SCOPED negative assertion are present. Each reason is a short, stable code the
 * callers turn into a ValidationIssue (test-plan gate) or a block reason (verify
 * gate) — single-sourced so both gates report the same failures.
 */
export interface PairingVerdict {
  ok: boolean;
  hasPositive: boolean;
  hasNegative: boolean;
  /** A negative was present but none of them were scoped to the change. */
  negativeUnscoped: boolean;
}

/**
 * Evaluate the paired positive+scoped-negative requirement for a behavior-CHANGE
 * obligation. `anchors` are the change's scope anchors (touched symbols/file).
 *
 * - A positive half is any assertion with positive polarity.
 * - A negative half counts ONLY when it is scoped to the change (CE-006): an
 *   unscoped repo-wide negative does not satisfy the negative requirement.
 *   `negativeUnscoped` is reported when the sole negative(s) failed scoping, so
 *   the diagnostic distinguishes "no negative at all" from "negative not scoped".
 */
export function evaluatePairing(
  assertions: readonly string[],
  anchors: readonly string[],
): PairingVerdict {
  let hasPositive = false;
  let hasScopedNegative = false;
  let hasAnyNegative = false;
  for (const assertion of assertions) {
    if (typeof assertion !== "string") continue;
    const polarity = assertionPolarity(assertion);
    if (polarity === "positive" || polarity === "both") hasPositive = true;
    if (polarity === "negative" || polarity === "both") {
      hasAnyNegative = true;
      if (negativeAssertionIsScoped(assertion, anchors)) hasScopedNegative = true;
    }
  }
  return {
    ok: hasPositive && hasScopedNegative,
    hasPositive,
    hasNegative: hasScopedNegative,
    negativeUnscoped: hasAnyNegative && !hasScopedNegative,
  };
}

// ── Defensive read + anchor derivation (used by the gates) ─────────────────────

/**
 * Read an obligation's `change_classification` from a raw, untrusted payload.
 * Returns the narrowed classification, or `undefined` when absent/malformed — the
 * gates treat an unclassified TESTABLE obligation as a CHANGE (fail-closed), so a
 * dropped or corrupt classification can never relax the paired-test requirement.
 */
export function readObligationChangeClassification(
  obligation: unknown,
): ObligationChangeClassification | undefined {
  if (!isRecord(obligation)) return undefined;
  const cls = obligation.change_classification;
  if (!isRecord(cls)) return undefined;
  if (cls.change_kind !== "change" && cls.change_kind !== "addition") return undefined;
  const touched = Array.isArray(cls.touched_symbols)
    ? (cls.touched_symbols as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const determinedBy =
    cls.determined_by === "touches_existing_symbol" ||
    cls.determined_by === "no_existing_symbol" ||
    cls.determined_by === "llm_confirmed" ||
    cls.determined_by === "llm_override"
      ? cls.determined_by
      : "touches_existing_symbol";
  return {
    change_kind: cls.change_kind,
    touched_symbols: touched,
    determined_by: determinedBy,
    ...(typeof cls.rationale === "string" ? { rationale: cls.rationale } : {}),
  };
}

/**
 * The scope anchors a paired negative must name for one obligation. Prefers the
 * classification's recorded `touched_symbols`; falls back to the obligation id
 * plus any symbol tokens in its description when the classification carries none
 * (e.g. an unclassified obligation treated as a fail-closed change). Always
 * non-empty when the id is a real id, so a fail-closed change still has a concrete
 * anchor to scope against rather than vacuously accepting any negative.
 */
export function obligationScopeAnchors(
  obligationId: string,
  description: string,
  classification: ObligationChangeClassification | undefined,
): string[] {
  if (classification && classification.touched_symbols.length > 0) {
    return classification.touched_symbols;
  }
  const anchors = new Set<string>();
  if (typeof obligationId === "string" && obligationId.length >= 3) {
    anchors.add(obligationId.toLowerCase());
  }
  for (const t of extractSymbolTokens(description)) anchors.add(t);
  return [...anchors];
}

// ── Verify-gate enforcement (mergeImplementResults) ────────────────────────────

/** A test_validator_plan spec's assertions, indexed by obligation id. */
function assertionsByObligation(testValidatorPlanPayload: unknown): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  const specs =
    isRecord(testValidatorPlanPayload) && Array.isArray(testValidatorPlanPayload.test_specs)
      ? (testValidatorPlanPayload.test_specs as unknown[])
      : [];
  for (const spec of specs) {
    if (!isRecord(spec) || typeof spec.obligation_id !== "string") continue;
    const list = byId.get(spec.obligation_id) ?? [];
    if (Array.isArray(spec.assertions)) {
      for (const a of spec.assertions as unknown[]) {
        if (typeof a === "string") list.push(a);
      }
    }
    byId.set(spec.obligation_id, list);
  }
  return byId;
}

/** True when an obligation has an inapplicable_claim opting it out, in the plan. */
function obligationOptedOut(
  testValidatorPlanPayload: unknown,
  obligationId: string,
): boolean {
  const specs =
    isRecord(testValidatorPlanPayload) && Array.isArray(testValidatorPlanPayload.test_specs)
      ? (testValidatorPlanPayload.test_specs as unknown[])
      : [];
  return specs.some(
    (spec) =>
      isRecord(spec) &&
      spec.obligation_id === obligationId &&
      isRecord(spec.inapplicable_claim) &&
      spec.inapplicable_claim.obligation_id === obligationId &&
      typeof spec.inapplicable_claim.reason === "string" &&
      spec.inapplicable_claim.reason.length > 0,
  );
}

/**
 * Verify-gate (DC-5): for the obligations a resolved finding covers, return a
 * block reason when any behavior-CHANGE obligation's test specs are only one
 * polarity — a positive without a SCOPED negative, or a negative-only set. A pure
 * addition, an opted-out obligation, or one not present in the ledger is ignored.
 *
 * This is the SAME pairing/scoping evaluation the test-plan derivation gate uses
 * (`evaluatePairing` + `obligationScopeAnchors`), so a node cannot self-report a
 * change resolved while leaving the pair half-open: only-one-polarity → blocked.
 * Returns `null` when every covered change obligation is fully paired.
 */
export function verifyPairingForFinding(
  obligationIds: readonly string[],
  obligationLedgerPayload: unknown,
  testValidatorPlanPayload: unknown,
): string | null {
  if (obligationIds.length === 0) return null;
  const obligations =
    isRecord(obligationLedgerPayload) && Array.isArray(obligationLedgerPayload.obligations)
      ? (obligationLedgerPayload.obligations as unknown[])
      : [];
  if (obligations.length === 0) return null;

  const byId = new Map<string, Record<string, unknown>>();
  for (const obl of obligations) {
    if (isRecord(obl) && typeof obl.id === "string") byId.set(obl.id, obl);
  }
  const assertions = assertionsByObligation(testValidatorPlanPayload);
  const reasons: string[] = [];

  for (const oblId of obligationIds) {
    const obl = byId.get(oblId);
    if (!obl) continue;
    const kind = typeof obl.kind === "string" ? obl.kind : "";
    if (kind !== "invariant" && kind !== "behavioral") continue;
    if (obligationOptedOut(testValidatorPlanPayload, oblId)) continue;

    const classification = readObligationChangeClassification(obl);
    // Pure addition never paired; only a change (or fail-closed unclassified)
    // is gated here.
    if (classification?.change_kind === "addition") continue;

    const description = typeof obl.description === "string" ? obl.description : "";
    const anchors = obligationScopeAnchors(oblId, description, classification);
    const verdict = evaluatePairing(assertions.get(oblId) ?? [], anchors);
    if (verdict.ok) continue;

    if (!verdict.hasPositive && !verdict.hasNegative) {
      reasons.push(
        `obligation "${oblId}" (behavior change) has no paired test spec — a change must assert both the satisfied path and a negative scoped to the changed symbol/file`,
      );
    } else if (!verdict.hasNegative) {
      reasons.push(
        verdict.negativeUnscoped
          ? `obligation "${oblId}" (behavior change) has only one polarity: its negative assertion is not scoped to the change (anchors: ${anchors.join(", ") || "none"}) — an unscoped repo-wide negative is rejected (CE-006)`
          : `obligation "${oblId}" (behavior change) has only one polarity: a positive assertion without a scoped negative (failure-path) half`,
      );
    } else {
      reasons.push(
        `obligation "${oblId}" (behavior change) has only one polarity: a negative assertion without a positive (satisfied-path) half`,
      );
    }
  }

  if (reasons.length === 0) return null;
  return (
    `DC-5 paired-test gate: ${reasons.join("; ")}. ` +
    `A behavior-change obligation must carry a paired positive+scoped-negative test spec before it can be reported resolved.`
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}
