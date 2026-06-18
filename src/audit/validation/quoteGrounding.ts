/**
 * Quote-and-verify grounding for audit findings (S7 anti-hallucination).
 *
 * The primitives now live in `audit-tools/shared`
 * (`shared/src/validation/findingGrounding.ts`) so the auditor, the conceptual-
 * review grounding, and the remediator all consume ONE implementation rather
 * than each carrying a copy (drift-plan E3 + P7). This module re-exports them so
 * the existing `../validation/quoteGrounding.js` import sites are unchanged.
 *
 * The safeguard is attached to the *claim*: every finding cites a verbatim span
 * (`affected_files[].quoted_text`); the tool re-reads that span from disk and
 * content-matches it (whitespace/CRLF-normalized, matched on content not line
 * numbers). The confirmed bit is the tool's re-check, never the model's word; a
 * finding whose quote does not re-verify (or that carries no quote) is
 * `ungrounded` — surfaced, never silently admitted as a confirmed finding.
 */
export {
  normalizeForMatch,
  quoteMatches,
  verifyFindingGrounding,
  type SourceReader,
} from "audit-tools/shared";
