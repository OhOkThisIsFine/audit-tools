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

/**
 * Translate one ordinary (non-`**`) glob segment to a regex fragment: `*`
 * within a segment matches any run of non-separator characters, `?` matches
 * one, and every other character is escaped — no placeholder substitution.
 */
function translateGlobSegment(segment: string): string {
  let re = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

/**
 * Minimal glob match supporting `*` (within a segment), `**` (across
 * segments, matching ZERO or more whole path segments — conventional glob
 * semantics), `?`.
 *
 * A `**` segment folds its ADJACENT separator into its own regex fragment
 * (optional) rather than emitting it as a mandatory literal, so a
 * zero-segment match is possible on either side: `**\/*.env` matches a
 * repo-root `secrets.env`, `src/**\/*.ts` matches `src/index.ts`, and
 * `vendor/**` matches the bare `vendor` entry itself (COR-ef7a209d /
 * COR-ef7a209d-2) — not only paths with an intermediate directory.
 */
export function globMatches(filePath: string, glob: string): boolean {
  const f = normalize(filePath);
  const g = normalize(glob);
  if (!g.includes("*") && !g.includes("?")) {
    return pathMatchesPrefix(f, g);
  }

  const segments = g.split("/");
  const pieces: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "**") {
      if (i === 0 && i === segments.length - 1) {
        // The WHOLE glob is `**` — matches any path, including nested ones.
        pieces.push(".*");
      } else if (i === 0) {
        // Leading `**` — optionally consume any number of leading segments.
        pieces.push("(?:.*/)?");
      } else {
        // Trailing or interior `**` — optionally consume any number of
        // segments AFTER the preceding one, folding in the boundary `/` so
        // zero segments (i.e. nothing after) is a valid match too.
        pieces.push("(?:/.*)?");
      }
      continue;
    }
    if (i > 0 && segments[i - 1] !== "**") {
      pieces.push("/");
    }
    pieces.push(translateGlobSegment(segment));
  }
  return new RegExp(`^${pieces.join("")}$`).test(f);
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
