// Does a free-text decision field actually cite a nightly ledger key it claims?
//
// THE TRAP. Both attestation producers (`.claude/hooks/attest-loop-core-review.mjs`
// and `scripts/attest-constitutional-doc-change.mjs`) write the durable audit
// record of a review or an owner decision as FREE TEXT. An owner decision that
// rests on a settled nightly question naturally cites that question's key, and
// nothing verified the citation: on 2026-09-04 an `--owner-decision` recorded
// `cde41c31c1c6a7f3` when the ledger held `cde41c31f1c6a7f3` — one character
// off. The attestation is the record that OUTLIVES the work; a typo in it is a
// dangling reference nobody can follow, and the only thing that noticed was a
// later `answer.mjs --done`, i.e. after the record was already durable.
//
// A citation is checkable mechanically, so it is checked here rather than left
// to the caller's care: `.claude/nightly-decisions.json` is keyed by exactly
// the 16-lowercase-hex `subjectKey` this module matches on.
//
// WHY REFUSE RATHER THAN WARN. The record is the artifact; a warning printed to
// a scrollback that the record outlives is not enforcement. The cost of a
// refusal is one re-run of a command the caller is holding anyway, and the
// refusal names the nearest real key so the typo case is self-healing.
//
// FAIL-OPEN ON A MISSING/UNREADABLE LEDGER, ANNOUNCED. A repo with no ledger
// has no keys to resolve against, and an unreadable one must not make a repo
// un-attestable (the same rule the derived-file preflight's unwired leg
// follows). Fail-open is announced, never silent — a silent skip is
// indistinguishable from a verified citation.
import { readFileSync } from 'node:fs';
import { DECISIONS_RELPATH, decisionsPath } from '../nightly/items.mjs';

// The ledger key format, and the ONLY shape this module treats as a citation.
// `subjectKey` (scripts/nightly/items.mjs) builds it as the 16-char prefix of a
// sha1 hex digest of `<path>::<normalized subject>`.
const LEDGER_KEY_RE = /\b[0-9a-f]{16}\b/g;

/**
 * @typedef {{ok: true, keys: string[], skipped?: string}} CitationResolved
 * @typedef {{ok: false, reason: string, key: string, suggestion: string | null}} CitationRefused
 */

/** Hamming distance over equal-length strings; null when the lengths differ. */
function hamming(a, b) {
  if (a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** The ledger key one substitution away from `key`, when exactly one exists. */
function nearestKey(key, keys) {
  let found = null;
  for (const candidate of keys) {
    if (hamming(key, candidate) !== 1) continue;
    if (found !== null) return null; // ambiguous — say nothing rather than guess
    found = candidate;
  }
  return found;
}

/**
 * Resolve every 16-hex citation in `text` against the nightly decisions ledger.
 *
 * Returns `{ok: true, keys}` listing the citations that resolved (empty when the
 * text cites none), or `{ok: false, reason, key, suggestion}` for the first
 * citation that does not. `skipped` is set when the check could not run at all
 * (absent ledger, read fault, malformed JSON) so the caller can ANNOUNCE the
 * fail-open rather than let it read as a verified citation.
 *
 * Malformed JSON is treated as unavailable rather than as an error: this module
 * is a citation checker, and `readDecisions` already fails CLOSED (throws) on
 * its own write paths, where the risk is destroying the ledger. Nothing here
 * writes.
 *
 * @param {string} root
 * @param {string} text
 * @returns {CitationResolved | CitationRefused}
 */
export function resolveNightlyDecisionKeys(root, text) {
  const cited = [...new Set(String(text ?? '').match(LEDGER_KEY_RE) ?? [])];
  if (cited.length === 0) return { ok: true, keys: [] };

  let ledger;
  try {
    const raw = readFileSync(decisionsPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: true, keys: [], skipped: `${DECISIONS_RELPATH} is not a key map` };
    }
    ledger = parsed;
  } catch (err) {
    const code = err && /** @type {any} */ (err).code;
    const why =
      code === 'ENOENT'
        ? `no ${DECISIONS_RELPATH} in this repository`
        : `could not read ${DECISIONS_RELPATH} (${err && /** @type {any} */ (err).message})`;
    return { ok: true, keys: [], skipped: why };
  }

  const keys = Object.keys(ledger);
  for (const key of cited) {
    if (Object.prototype.hasOwnProperty.call(ledger, key)) continue;
    return {
      ok: false,
      key,
      suggestion: nearestKey(key, keys),
      reason:
        `it cites the 16-hex nightly ledger key "${key}", which is NOT a key in ${DECISIONS_RELPATH} ` +
        `(${keys.length} recorded)`,
    };
  }
  return { ok: true, keys: cited };
}
