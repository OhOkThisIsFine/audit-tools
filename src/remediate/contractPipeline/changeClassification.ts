// <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
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
    // <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
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

// <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
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

/**
 * Negation cues that, in the SAME clause immediately before a global-scan phrase,
 * mark it as DESCRIPTIVE contrast ("scoped to X, *not* an unscoped repo-wide
 * check") rather than the assertion's actual action. Flagging the literal words
 * "repo-wide" regardless of negation is exactly what forced hosts to euphemise a
 * legitimately-scoped negative — the CE-006 false-positive. Only an AFFIRMATIVE
 * scan (the scan is the check) disqualifies scoping.
 */
const SCAN_NEGATION_CUE =
  /\b(?:not|never|no\s+longer|rather\s+than|instead\s+of|without|avoids?|avoiding|isn'?t|aren'?t|doesn'?t|don'?t|won'?t)\b/i;

/**
 * True when the assertion uses a global-scan phrase AFFIRMATIVELY — the scan is
 * the check it performs, not a contrast clause describing what it deliberately
 * avoids. Each scan match is judged by its own clause (text back to the nearest
 * `. ; , — --` boundary): a negation cue in that clause makes the mention
 * descriptive and non-disqualifying; an unqualified scan disqualifies. This is a
 * structural read of the assertion's action, not a bare keyword veto on the words.
 */
function usesAffirmativeGlobalScan(assertion: string): boolean {
  const re = new RegExp(UNSCOPED_GLOBAL_SCAN_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(assertion)) !== null) {
    const clause = assertion.slice(0, match.index).split(/[.;,]|—|--/).pop() ?? "";
    if (!SCAN_NEGATION_CUE.test(clause)) return true;
    if (match.index === re.lastIndex) re.lastIndex++; // zero-width guard
  }
  return false;
}

/** Match a scope anchor as a whole word/path fragment inside an assertion. */
function assertionNamesAnchor(assertion: string, anchor: string): boolean {
  if (anchor.length < 3) return false;
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word/path boundary: the anchor is not glued to surrounding identifier chars.
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "i").test(assertion);
}

/**
 * A negative assertion for a behavior-CHANGE obligation is SCOPED when it names
 * at least one of the change's anchors (the touched symbol/file) AND does not
 * perform an affirmative unscoped repo-wide scan. Naming an anchor is necessary
 * but not sufficient: an assertion that both names the symbol and says "grep the
 * whole repo" is still rejected, because the scan, not the symbol, is what it
 * actually checks. A merely DESCRIPTIVE mention of a global scan ("scoped to X,
 * not an unscoped repo-wide check") does NOT disqualify — the veto reads the
 * assertion's action, not the literal words, so a host need not euphemise (CE-006).
 *
 * Returns true when the assertion is acceptably scoped to the change.
 */
export function negativeAssertionIsScoped(
  assertion: string,
  anchors: readonly string[],
): boolean {
  if (typeof assertion !== "string" || assertion.length === 0) return false;
  if (usesAffirmativeGlobalScan(assertion)) return false;
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
 * Multi-segment identifier tokens (obligation ids `OBL-AUTH-fail-session`, kebab/
 * snake symbols, dotted/sliced paths `src/x/plan.ts`, `a::b`). A keyword regex
 * `\b`-boundary still fires on a polarity word delimited by `-`/`_`/`.`/`/`/`:`
 * inside such a token (e.g. `fail` in `OBL-AUTH-fail-session`), flipping a positive
 * assertion that merely *cites* an id. These carry no prose polarity, so mask them
 * before keyword classification. A run must have at least one internal delimiter to
 * qualify — ordinary prose words (no internal `-_./:`)  are left untouched, as are
 * multiword phrases like "does not" (space-separated, not a single token).
 *
 * SCANNED, NOT MATCHED — and the reason is a measured quadratic, not taste. The
 * obvious regex here is `[A-Za-z0-9]+(?:[-_/.:]+[A-Za-z0-9]+)+`, and on a long
 * UNBROKEN alphanumeric run it is Θ(n²): the engine starts at every position and
 * each start consumes the rest of the run before the (absent) delimiter fails the
 * whole match, so a 16,000-char run took 3.36 SECONDS (measured on the `word-run`
 * family: 44/186/741/3360ms across 2k/4k/8k/16k, a clean 4×-per-doubling). An
 * assertion arrives from a host-authored test plan with no length bound, so the
 * input class is reachable.
 *
 * Restructuring the regex does NOT fix it: the failure is the per-start-position
 * rescan, so a possessive/atomic leading run only replaces an O(n) giveback with
 * an O(n) take, and a lookahead made of the same character class still has to
 * scan the run to fail. A single forward pass over a two-character-class grammar
 * is the linear form, and the grammar is tiny and fully ours. Same replacement
 * semantics as the regex it replaces, pinned by
 * `tests/remediate/change-classification-backtracking.test.ts`.
 */
function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) // a-z
  );
}

/** The token's internal delimiters: `-`, `_`, `/`, `.`, `:`. */
function isIdentifierDelimiter(code: number): boolean {
  return (
    code === 45 || // -
    code === 95 || // _
    code === 47 || // /
    code === 46 || // .
    code === 58 //   :
  );
}

/**
 * Blank out identifier tokens so their embedded words don't leak polarity.
 *
 * One left-to-right pass, O(n) — and the pass must SKIP, not step, on failure.
 * The regex's token is `alnum+ (delimiter+ alnum+)+`: it starts and ends on an
 * alphanumeric and contains at least one delimiter that is FOLLOWED by an
 * alphanumeric. So a maximal run of `alnum|delimiter` that holds no such
 * delimiter-then-alphanumeric pair cannot contain a token starting anywhere
 * inside it, and the scan jumps past the whole run in one step. Emitting the
 * leading character and re-entering would rescan the rest of the run at every
 * position — the same quadratic the regex had, merely relocated.
 *
 * On a match the replacement ends at the LAST alphanumeric of the run, leaving
 * any trailing delimiters in place, which is exactly where the regex's greedy
 * match ended.
 */
function stripIdentifierTokens(assertion: string): string {
  const out: string[] = [];
  const length = assertion.length;
  let index = 0;
  while (index < length) {
    if (!isAsciiAlphanumeric(assertion.charCodeAt(index))) {
      out.push(assertion[index]!);
      index += 1;
      continue;
    }
    // Extend over the maximal alphanumeric/delimiter run, tracking whether a
    // delimiter has been followed by an alphanumeric (the qualifying shape).
    let cursor = index;
    let lastAlphanumeric = index;
    let sawDelimiter = false;
    let qualifies = false;
    while (cursor < length) {
      const current = assertion.charCodeAt(cursor);
      if (isAsciiAlphanumeric(current)) {
        if (sawDelimiter) qualifies = true;
        lastAlphanumeric = cursor;
        cursor += 1;
        continue;
      }
      if (isIdentifierDelimiter(current)) {
        sawDelimiter = true;
        cursor += 1;
        continue;
      }
      break;
    }
    if (qualifies) {
      out.push(" ");
      index = lastAlphanumeric + 1;
      continue;
    }
    // No token can begin inside this run — copy it through verbatim and resume
    // after it.
    out.push(assertion.slice(index, cursor));
    index = cursor;
  }
  return out.join("");
}

/**
 * Classify one assertion's polarity. An explicit `POSITIVE:` / `NEGATIVE:` label
 * is authoritative and skips the keyword fallback (so "POSITIVE: must not exceed
 * N" counts only as positive). Unlabeled assertions fall through to the keyword
 * regexes, which may match both polarities — run against an identifier-masked copy
 * so a polarity word embedded in a cited id (e.g. `fail` in `OBL-AUTH-fail-session`)
 * doesn't misclassify the assertion.
 */
export function assertionPolarity(assertion: string): AssertionPolarity {
  const label = /^\s*(POSITIVE|NEGATIVE)\s*:/i.exec(assertion);
  if (label) {
    return label[1].toUpperCase() === "POSITIVE" ? "positive" : "negative";
  }
  const prose = stripIdentifierTokens(assertion);
  const neg = NEGATIVE_ASSERTION_PATTERN.test(prose);
  const pos = POSITIVE_ASSERTION_PATTERN.test(prose);
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
 * Returns the narrowed classification, or `undefined` only when the field is
 * genuinely ABSENT — a truly unclassified obligation (e.g. a structural one), which
 * the gates already treat as a CHANGE (fail-closed) at the consumer.
 *
 * A classification that is PRESENT but CORRUPT (not a record, or an unrecognized
 * `change_kind`) is read as a fail-closed CHANGE rather than `undefined` (INV-IR-4):
 * a dropped or garbled classification can never relax the paired-test requirement
 * and can never let incremental item-scoping (contract-incremental-reconvergence)
 * carry a changed item forward as if it were an unchanged addition.
 */
export function readObligationChangeClassification(
  obligation: unknown,
): ObligationChangeClassification | undefined {
  if (!isRecord(obligation)) return undefined;
  // Distinguish "absent" (no field → undefined, consumers stay fail-closed) from
  // "present but corrupt" (field exists → an explicit fail-closed CHANGE verdict).
  if (!("change_classification" in obligation)) return undefined;
  const cls = obligation.change_classification;
  const failClosedChange = (touched_symbols: string[]): ObligationChangeClassification => ({
    change_kind: "change",
    touched_symbols,
    determined_by: "touches_existing_symbol",
  });
  if (!isRecord(cls)) return failClosedChange([]);
  if (cls.change_kind !== "change" && cls.change_kind !== "addition") {
    const touched = Array.isArray(cls.touched_symbols)
      ? (cls.touched_symbols as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    return failClosedChange(touched);
  }
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
