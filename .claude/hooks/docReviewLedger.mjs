// Shared ledger for doc-review item disposition.
//
// Problem it solves: the nightly doc-review routine writes its open items to the
// `doc-review` branch's findings.md between DOC-REVIEW-OPEN markers. The
// SessionStart surface hook prints that block. Its ONLY clearing mechanism is
// "the next nightly run regenerates findings.md" — so between a fix landing on
// main and the next nightly, every session re-surfaces the same already-resolved
// items. (Observed: AF-1/D-5/D-6/D-7 applied in 25ecc7b7, still nagging.)
//
// Fix (clear-on-apply, conflict-free): when the host dispositions items, record
// their IDs here keyed by the findings.md commit SHA they were resolved against.
// The surface hook filters them out. When the nightly regenerates findings.md
// (new SHA), the old SHA's resolutions no longer match, so genuinely-new items
// surface and stale entries are ignored. No cross-branch push → no race with the
// cloud routine that owns the doc-review branch.
//
// Keyed by SHA (not by ID alone) so a recycled item ID in a future run is never
// silently suppressed by an old disposition.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LEDGER_PATH = join(__dirname, 'doc-review-resolved.json');

// Parse the leading `[ID]` token from an OPEN-block bullet line.
// Matches `- [AF-1] ...` / `* [D-5] ...`; returns null for non-item lines.
export function parseItemId(line) {
  const m = /^\s*[-*]\s*\[([^\]]+)\]/.exec(line);
  return m ? m[1].trim() : null;
}

export function readLedger(path = LEDGER_PATH) {
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {}; // absent / malformed → empty, never throw
  }
}

export function writeLedger(ledger, path = LEDGER_PATH) {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

// Record `ids` as resolved against findings.md commit `sha`. Idempotent + additive.
export function recordResolved(sha, ids, path = LEDGER_PATH) {
  if (!sha || !ids || ids.length === 0) return readLedger(path);
  const ledger = readLedger(path);
  const existing = new Set(Array.isArray(ledger[sha]) ? ledger[sha] : []);
  for (const id of ids) existing.add(id);
  ledger[sha] = [...existing].sort();
  // Keep only the most recent SHA's resolutions plus this one — older findings
  // generations can never re-surface, so their ledger rows are dead weight.
  const pruned = { [sha]: ledger[sha] };
  writeLedger(pruned, path);
  return pruned;
}

// Returns the set of IDs resolved against this findings.md SHA.
export function resolvedIdsFor(sha, path = LEDGER_PATH) {
  if (!sha) return new Set();
  const ledger = readLedger(path);
  return new Set(Array.isArray(ledger[sha]) ? ledger[sha] : []);
}
