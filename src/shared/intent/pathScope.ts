import type { IntentCheckpoint } from "../types/intentCheckpoint.js";

/**
 * Single authority for intent path-scope matching + structured-exclusion policy,
 * shared by both orchestrators so their scope decisions can never drift. Audit
 * (review scope: `intentScopeDisposition.ts`) and remediate (write scope:
 * `checkpointFilter.ts`) previously carried byte-identical prefix predicates AND
 * consulted DIFFERENT checkpoint fields (audit honored `disposition_overrides` but
 * ignored `must_not_touch`; remediate the reverse) — the exact latent scope-policy
 * drift the auditor-agnostic-robustness rule bans. Both now consume this module, so
 * a checkpoint yields the SAME per-file exclusion on both sides.
 *
 * All matching is case-sensitive and OS-agnostic (separators normalized to "/").
 */
function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Exact path or directory-prefix match (e.g. "src/api" matches "src/api/x.ts"). */
export function pathMatchesPrefix(filePath: string, entryPath: string): boolean {
  const f = normalize(filePath);
  const p = normalize(entryPath).replace(/\/+$/, "");
  if (!p) return false;
  return f === p || f.startsWith(`${p}/`);
}

/** Minimal glob match supporting `*` (within a segment), `**` (across segments), `?`. */
export function globMatches(filePath: string, glob: string): boolean {
  const f = normalize(filePath);
  const g = normalize(glob);
  if (!g.includes("*") && !g.includes("?")) {
    return pathMatchesPrefix(f, g);
  }
  // Translate the glob to a regex char-by-char so `*` / `**` / `?` are handled
  // and every other character is escaped — no placeholder substitution.
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(f);
}

/**
 * `disposition_overrides` statuses that mean "out of scope" for BOTH orchestrators.
 * `binary` / `doc_only` are dispositions but not exclusions, so they are absent.
 */
export const EXCLUDED_OVERRIDE_STATUSES: ReadonlySet<string> = new Set([
  "excluded",
  "generated",
  "vendor",
]);

/**
 * Whether a single file is excluded by the checkpoint's STRUCTURED scope, and the
 * human reason when it is (null when in scope). Consults ALL exclusion fields so the
 * two orchestrators cover the same scope:
 *   - `excluded_scope` (path/prefix + its reason),
 *   - `disposition_overrides` with an excluded status (path/prefix + its reason),
 *   - `must_not_touch` globs (write-forbidden ⇒ also out of review/remediation scope;
 *     a synthesized reason since the entry is a bare glob).
 * Precedence follows that field order (first match wins). Never reads
 * `free_form_intent` (interpreted into priority/lens signals, never verbatim, INV-S04).
 *
 * The AGGREGATION over a unit's / finding's files (audit: excluded only when EVERY
 * file is excluded; remediate: dropped when ANY file is excluded) stays the caller's
 * domain policy — only the per-file field coverage is single-sourced here.
 */
export function fileExclusionReason(
  filePath: string,
  checkpoint: IntentCheckpoint | undefined,
): string | null {
  if (!checkpoint) return null;
  for (const entry of checkpoint.excluded_scope ?? []) {
    if (pathMatchesPrefix(filePath, entry.path)) return entry.reason;
  }
  for (const ov of checkpoint.disposition_overrides ?? []) {
    if (EXCLUDED_OVERRIDE_STATUSES.has(ov.status) && pathMatchesPrefix(filePath, ov.path)) {
      return ov.reason;
    }
  }
  for (const glob of checkpoint.must_not_touch ?? []) {
    if (globMatches(filePath, glob)) return `must-not-touch scope (${glob})`;
  }
  return null;
}
