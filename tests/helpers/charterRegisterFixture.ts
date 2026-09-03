// Shared fixture pieces for `charter_register.json` (schema v4).
//
// v4 made `citation_validation` and `evidence_coverage` REQUIRED, deliberately:
// an optional affirmation is one a writer can forget, which is the same
// false-green in a new place. That means every register a test builds must state
// both — so they are stated ONCE here rather than pasted into a dozen fixtures
// where they would drift apart.
//
// These are real values, not a cast. A `as CharterRegister` would make the
// required-field gate inert, which is exactly the thing the schema bump exists to
// prevent.
import type {
  CharterPacketCoverage,
  CitationValidationSummary,
} from "audit-tools/shared";

/**
 * The affirmation a register carries when no charter work was examined — the
 * omit path's honest record. A fixture that wants to assert a CHECKED register
 * should state its own summary rather than reach for this.
 */
export const NO_CITATIONS_VALIDATION: CitationValidationSummary = {
  status: "no_citations",
  citation_count: 0,
  checked_count: 0,
  failed_count: 0,
  delivered_evidence_checked: false,
};

/**
 * The two v4 fields every register must carry, for fixtures whose subject is
 * something else entirely (staleness, dependency slices, prompt context).
 */
export const REGISTER_V4_AFFIRMATION: {
  citation_validation: CitationValidationSummary;
  evidence_coverage: CharterPacketCoverage[];
} = {
  citation_validation: NO_CITATIONS_VALIDATION,
  evidence_coverage: [],
};
